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
 *
 * Pokrývá **všechny** cesty, kterými peníze chodí: licenci, superlicenci,
 * registraci týmu, balíček startů, košík a pokutu za kontumaci. Kdyby se
 * některá vynechala, byl by to tichý výpadek — člověk zaplatí a nikdo se to
 * nedozví. Přesně tohle se v projektu stalo balíčkům a košíku.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');
const kredit = require('./kredit');
const kosik  = require('./kosik');
const { ohlasSupervisorum } = require('./bankSync');

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

/** Aktuální sezóna; když ji nejde zjistit, sezónu neřešíme. */
async function currentSeason() {
  try {
    return await require('./seasonTransition').currentSeason();
  } catch (_) {
    return null;
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
  //
  // Řádek `PAID` z minulé sezóny sem patří taky: registrace se platí každý
  // ročník znovu, takže rozdělaná session u loňského zaplaceného řádku je
  // letošní platba, které se ztratil webhook. Bez téhle podmínky by ji
  // rekonciliace přeskočila a peníze by zůstaly nespárované.
  const sezona = await currentSeason();
  const teamPayments = await prisma.teamPayment.findMany({
    where: {
      sessionId: { not: null },
      OR: [
        { status: { not: 'PAID' } },
        ...(sezona ? [{ season: { not: sezona } }] : []),
      ],
    },
  });

  for (const t of teamPayments) {
    results.checked++;
    if (await isPaid(t.sessionId)) {
      await prisma.teamPayment.update({
        where: { teamId: t.teamId },
        data:  {
          status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: t.sessionId,
          ...(sezona ? { season: sezona } : {}),
        },
      });
      results.fixed.push({ type: 'TEAM_REG', teamId: t.teamId, season: sezona ?? undefined });
    }
  }

  // ── Balíčky zápasů ──
  // Tady je rekonciliace potřebnější než u čehokoli jiného: balíček se kupuje
  // opakovaně během sezóny, takže ztracený webhook potká hráče dřív nebo
  // později. Bez kreditu se přitom nedostane do sestavy.
  const packs = await prisma.matchPack.findMany({
    where:  { status: { not: 'PAID' }, sessionId: { not: null } },
    select: { id: true, sessionId: true },
  });

  for (const p of packs) {
    results.checked++;
    if (await isPaid(p.sessionId)) {
      // `remaining` se schválně nepřepisuje — kdyby se mezitím stihla
      // rezervace, nesmí ji dodatečné zaplacení vrátit zpátky nahoru.
      const updated = await prisma.matchPack.updateMany({
        where: { id: p.id, status: { not: 'PAID' } },
        data:  { status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: p.sessionId },
      });
      if (updated.count === 0) continue;

      // Odměnu za doporučení vyplácí jinak webhook. Když ten nedorazil,
      // musí ji vyplatit tenhle doběh — jinak by o ni ten, kdo hráče
      // přivedl, přišel jen kvůli výpadku spojení.
      const pack = await prisma.matchPack.findUnique({ where: { id: p.id } });
      await kredit.odmenZaDoporuceni(pack.playerId, pack);

      results.fixed.push({ type: 'MATCH_PACK', packId: p.id, playerId: pack.playerId });
    }
  }

  // ── Košíky ──
  // Od 10. 9. 2026 jde přes košík většina peněz, takže ztracený webhook tady
  // bolí nejvíc: nezaúčtuje se **žádná** z položek naráz — člověk zaplatí
  // licenci i balíček a nedostane ani jedno. Zaúčtování dělá `kosik.zauctuj`,
  // tedy tatáž funkce jako webhook, aby se ty dvě cesty nemohly rozejít.
  const carts = await prisma.cart.findMany({
    where:  { status: { not: 'PAID' }, sessionId: { not: null } },
    select: { id: true, sessionId: true },
  });

  for (const c of carts) {
    results.checked++;
    if (await isPaid(c.sessionId)) {
      const vysledek = await kosik.zauctuj(c.id, { method: 'stripe', stripeId: c.sessionId });
      if (!vysledek.ok || vysledek.uzBylo) continue;

      // Položka, která už zaplacená byla jinak, se přeskočila. Peníze za ni
      // dorazily dvakrát a někdo je musí vrátit — nesmí to zapadnout.
      for (const item of vysledek.dvoji ?? []) {
        await ohlasSupervisorum(
          'Dvojí platba',
          `Doběh rekonciliace zaúčtoval košík ${c.id}. Položka „${kosik.nazev(item)}" `
          + `(${item.amount} Kč) už ale zaplacená byla — peníze je potřeba vrátit.`,
        );
      }

      results.fixed.push({ type: 'CART', cartId: c.id, polozek: vysledek.items?.length ?? 0 });
    }
  }

  // ── Pokuty za kontumaci ──
  // Mimo košík, protože se platí zvlášť a hned. Doběh je u nich potřeba
  // stejně: dokud je pokuta nezaplacená, rozhodčí týmu další zápas nespustí,
  // takže ztracený webhook tým zablokuje, i když peníze odešly.
  const fines = await prisma.fine.findMany({
    where:  { status: { notIn: ['PAID', 'WAIVED'] }, sessionId: { not: null } },
    select: { id: true, sessionId: true },
  });

  for (const f of fines) {
    results.checked++;
    if (await isPaid(f.sessionId)) {
      const updated = await prisma.fine.updateMany({
        where: { id: f.id, status: { notIn: ['PAID', 'WAIVED'] } },
        data:  { status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: f.sessionId },
      });
      if (updated.count > 0) results.fixed.push({ type: 'FINE', fineId: f.id });
    }
  }

  return results;
}

module.exports = { reconcileStripePayments };
