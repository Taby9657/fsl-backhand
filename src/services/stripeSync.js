/**
 * Rekonciliace plateb proti Stripe.
 *
 * Webhook může vypadnout — Railway se zrovna nasazuje, síť selže, Stripe to
 * po několika pokusech vzdá. Pak je u Stripe platba zaplacená, ale v databázi
 * pořád „Čeká na platbu" a hráč se nemá jak dovolat nápravy.
 *
 * Tahle úloha projde platby, které nejsou zaplacené, ale mají u sebe uloženou
 * Checkout session, a u Stripe se doptá, jak to s nimi dopadlo. Doplňuje
 * webhook, nenahrazuje ho.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');

/**
 * Je session skutečně zaplacená – a nebyla mezitím vrácena?
 *
 * Refundace se u Stripe děje na charge / payment intentu, ne na Checkout session.
 * Ta zůstane napořád `complete` / `paid`. Bez kontroly payment intentu by tahle
 * úloha vracenou platbu do 6 hodin zase označila za zaplacenou a tiše tím
 * zrušila refundaci.
 */
async function isPaid(sessionId) {
  if (!sessionId) return false;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status !== 'complete' || session.payment_status !== 'paid') return false;

    // payment_intent je bez expandu string, s expandem objekt – snes obojí.
    const intentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

    if (intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId, {
        expand: ['latest_charge'],
      });
      const charge = intent.latest_charge;
      if (charge && (charge.refunded === true || charge.amount_refunded > 0)) return false;
    }

    return true;
  } catch (_) {
    return false; // session neexistuje nebo patří k jinému klíči
  }
}

async function reconcileStripePayments() {
  const results = { checked: 0, fixed: [] };

  if (!/^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || '')) {
    return { ...results, skipped: 'STRIPE_SECRET_KEY není nastaven' };
  }

  // ── Hráčské licence ──
  const playerPayments = await prisma.playerPayment.findMany({
    where: {
      OR: [
        { licStatus:   { not: 'PAID' }, licSessionId:   { not: null } },
        { superStatus: { not: 'PAID' }, superSessionId: { not: null } },
      ],
    },
  });

  for (const p of playerPayments) {
    if (p.licStatus !== 'PAID' && p.licSessionId) {
      results.checked++;
      if (await isPaid(p.licSessionId)) {
        await prisma.playerPayment.update({
          where: { playerId: p.playerId },
          data:  { licStatus: 'PAID', licPaidAt: new Date(), licMethod: 'stripe', stripeId: p.licSessionId },
        });
        await prisma.player.update({ where: { id: p.playerId }, data: { licensed: true } });
        results.fixed.push({ type: 'PLAYER_LICENSE', playerId: p.playerId });
      }
    }
    if (p.superStatus !== 'PAID' && p.superSessionId) {
      results.checked++;
      if (await isPaid(p.superSessionId)) {
        await prisma.playerPayment.update({
          where: { playerId: p.playerId },
          data:  { superStatus: 'PAID', superPaidAt: new Date(), superLic: true },
        });
        results.fixed.push({ type: 'SUPER_LICENSE', playerId: p.playerId });
      }
    }
  }

  // ── Registrace týmů ──
  const teamPayments = await prisma.teamPayment.findMany({
    where: { status: { not: 'PAID' }, sessionId: { not: null } },
  });

  for (const t of teamPayments) {
    results.checked++;
    if (await isPaid(t.sessionId)) {
      await prisma.teamPayment.update({
        where: { teamId: t.teamId },
        data:  { status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: t.sessionId },
      });
      results.fixed.push({ type: 'TEAM_REG', teamId: t.teamId });
    }
  }

  // ── Poplatky za domácí zápasy ──
  const matches = await prisma.match.findMany({
    where: { homeFeePaid: false, homeFeeSessionId: { not: null } },
    select: { id: true, homeFeeSessionId: true },
  });

  for (const m of matches) {
    results.checked++;
    if (await isPaid(m.homeFeeSessionId)) {
      await prisma.match.update({
        where: { id: m.id },
        data:  { homeFeePaid: true, homeFeeStripeId: m.homeFeeSessionId },
      });
      results.fixed.push({ type: 'HOME_FEE', matchId: m.id });
    }
  }

  return results;
}

module.exports = { reconcileStripePayments };
