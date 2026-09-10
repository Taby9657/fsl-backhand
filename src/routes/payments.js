const express = require('express');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth, requireSupervisor, isSupervisorUser } = require('../middleware/auth');
const {
  bankSync, ensurePlayerVS, ensureTeamVS, ensurePackVS, ensureFineVS, getPaymentQR,
  ohlasSupervisorum, jeZeStareSezony,
} = require('../services/bankSync');
const { overPlatbu } = require('../utils/opravneniPlatby');
const seasonSvc = require('../services/seasonTransition');
const kredit    = require('../services/kredit');

const router = express.Router();
const prisma = require('../lib/prisma');

// ==================== POMOCNÉ FUNKCE ====================

// Veřejná adresa webu pro návrat ze Stripe.
// CLIENT_URL může být seznam originů (CORS) – pro URL bereme první / PUBLIC_WEB_URL.
function webUrl() {
  const raw = process.env.PUBLIC_WEB_URL || process.env.CLIENT_URL || '';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

// Je Stripe vubec nakonfigurovany? Pozor na `sk_test_...` z .env.example –
// s tim Stripe vraci nesrozumitelne "Invalid API Key provided: sk_test_…".
function stripeConfigured() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  return /^sk_(test|live)_/.test(key) && key.length >= 30;
}

// Je nastaveny ucet ligy pro prevody?
function transferConfigured() {
  return !!process.env.BANK_IBAN;
}

function assertStripe(res) {
  if (!stripeConfigured()) {
    res.status(503).json({
      error: 'Platba kartou teď není dostupná. Použij prosím platbu převodem s QR kódem.',
      code:  'STRIPE_NOT_CONFIGURED',
    });
    return false;
  }
  return true;
}

// Jednotná Checkout session.
// Záměrně BEZ payment_method_types – Stripe pak nabídne všechny metody zapnuté
// v dashboardu, tedy kartu i Apple Pay / Google Pay / Link podle zařízení.
async function createCheckout({ name, amountCzk, type, metadata, email }) {
  const web = webUrl();
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'czk',
        product_data: { name },
        unit_amount: Math.round(Number(amountCzk) * 100), // haléře
      },
      quantity: 1,
    }],
    locale: 'cs',
    // Session drzime hodinu. Delsi platnost jen zvysuje sanci, ze nekdo
    // dokonci starou platbu, kterou uz mezitim uhradil jinak.
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    success_url: `${web}/payment-success?type=${type}`,
    cancel_url:  `${web}/platby`,
    ...(email ? { customer_email: email } : {}),
    metadata,
  });
}

// Kolik Stripe doopravdy strhl, v korunách. Session drží haléře.
function castkaZeSession(session) {
  const halere = session?.amount_total;
  return typeof halere === 'number' ? Math.round(halere / 100) : null;
}

/**
 * Platba dorazila na něco, co už zaplacené bylo (jinou session, nebo
 * převodem). Dřív se taková platba tiše zapsala přes tu první a nikde po ní
 * nezůstala stopa — peníze u Stripe zůstaly a nikdo o nich nevěděl.
 */
async function ohlasDvojiPlatbu(co, session, castka) {
  console.warn(`Dvojí platba: ${co}, session ${session.id}, ${castka ?? '?'} Kč`);
  await ohlasSupervisorum(
    'Dvojí platba',
    `Přišla platba za ${co} (${castka ?? '?'} Kč, Stripe session ${session.id}), `
    + 'ale ta položka už byla zaplacená. Peníze je potřeba vrátit.',
  );
}

// ==================== PŘEHLED PLATEB ====================

/**
 * Registrace se platí každou sezónu znovu, ale `TeamPayment` je jeden řádek
 * na tým se sloupcem `season`. Řádek `PAID` z minulé sezóny proto neznamená,
 * že je zaplaceno teď — pro aktuální sezónu se na něj musí koukat jako na
 * nezaplacený. Přepíše se až ve chvíli, kdy nová platba doopravdy dorazí.
 */
function platbaTymuProSezonu(payment, sezona) {
  if (!payment) return null;
  if (!jeZeStareSezony(payment, sezona)) return payment;
  return {
    ...payment,
    season:     sezona,
    status:     'PENDING',
    paidAt:     null,
    method:     null,
    paidAmount: 0,
    // Ať je z odpovědi poznat, že tým platil, jen v jiném ročníku.
    paidSeason: payment.status === 'PAID' ? payment.season : null,
  };
}

// GET /payments/me – moje platby (hráč + vedoucí)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where: { userId: req.user.id },
      include: { payment: true, team: { include: { payments: true } } },
    });

    // Platba týmu – přes hráče, nebo přes vedoucího (pokud hráč nemá profil)
    let teamPayment = player?.team?.payments ?? null;
    if (!teamPayment && req.user.manager?.length > 0) {
      const team = await prisma.team.findFirst({
        where:   { managers: { some: { userId: req.user.id } } },
        include: { payments: true },
      });
      teamPayment = team?.payments ?? null;
    }

    const sezona = await seasonSvc.currentSeason();

    // Pokuty za kontumaci. Vedoucí je musí vidět hned na Platbách — dokud
    // je nezaplatí, rozhodčí týmu další zápas nespustí.
    const meTymy = (req.user.manager ?? []).map(m => m.teamId);
    const fines = meTymy.length
      ? await prisma.fine.findMany({
          where:   { teamId: { in: meTymy }, status: { in: ['PENDING', 'OVERDUE'] } },
          include: { team: { select: { id: true, name: true, abbr: true } } },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    res.json({
      playerPayment: player?.payment ?? null,
      teamPayment:   platbaTymuProSezonu(teamPayment, sezona),
      fines,
      currentSeason: sezona,
    });
  } catch (err) { next(err); }
});

// Vrati drive zalozenou Checkout session, pokud je porad otevrena.
// Bez toho vznikala pri kazdem kliknuti nova session a kdo si platbu otevrel
// dvakrat, mohl obe dokoncit a zaplatit dvakrat.
async function reuseOpenSession(sessionId) {
  if (!sessionId) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'open' && session.url) return session;
  } catch (_) {
    // session neexistuje, vyprsela, nebo patri k jinemu klici – zalozime novou
  }
  return null;
}

// GET /payments/methods – ktere platebni cesty jsou zrovna k dispozici.
// Klient podle toho skryje volby, ktere by stejne skoncily chybou.
router.get('/methods', requireAuth, (req, res) => {
  const card = stripeConfigured();
  res.json({
    card,
    wallet:   card,        // Apple Pay / Google Pay jedou pres stejnou Checkout session
    transfer: transferConfigured(),
  });
});

// ==================== STRIPE – HRÁČSKÁ LICENCE ====================

// POST /payments/player-license – vytvoření platební relace (Stripe Checkout / Payment Intent)
router.post('/player-license', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const player = await prisma.player.findUnique({
      where:   { userId: req.user.id },
      include: { payment: true },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });
    if (player.payment?.licStatus === 'PAID') {
      return res.status(409).json({ error: 'Licence je již zaplacena' });
    }

    let session = await reuseOpenSession(player.payment?.licSessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL hráčská licence ${player.payment?.season || '2025/26'}`,
        amountCzk: player.payment?.licFee || 300,
        type:      'license',
        email:     req.user.email,
        metadata:  { playerId: player.id, type: 'PLAYER_LICENSE' },
      });
      await prisma.playerPayment.update({
        where: { playerId: player.id },
        data:  { licSessionId: session.id },
      });
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// GET /payments/packs – ceník balíčků a co z nich hráči zbývá
//
// Kdo hráčský profil nemá, dostane ceník taky — ať vidí, co ho čeká — ale
// s `hasProfile: false`. Bez toho pole si klient nemůže všimnout rozdílu
// a nabídne tlačítko „Koupit", které skončí na „Hráčský profil nenalezen".
// Zbytek odpovědi má v takovém případě nulové hodnoty, ne chybějící klíče:
// dřív mizely `withdrawalHours`, `upcoming` i `canRefer` a klient si je
// musel domýšlet.
router.get('/packs', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    const sezona = await seasonSvc.currentSeason();
    const prazdny = {
      season:    sezona,
      packs:     [],
      remaining: 0,
      spent:     0,
      withdrawalHours: kredit.LHUTA_ODHLASENI_H,
      played:    0,
      canRefer:  false,
      upcoming:  [],
    };
    res.json({
      catalog:    kredit.BALICKY,
      hasProfile: !!player,
      ...(player ? await kredit.prehled(player.id, sezona) : prazdny),
    });
  } catch (err) { next(err); }
});

// POST /payments/pack – nákup balíčku zápasů
//
// Balíček vzniká rovnou, ale jako PENDING — kredit z něj hráč dostane teprve
// ve chvíli, kdy platba doopravdy dorazí. Rozdělaná Checkout session hrát
// nikoho nepustí.
router.post('/pack', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const definice = kredit.balicek(req.body.size);
    if (!definice) {
      return res.status(400).json({
        error: `Balíček musí být jeden z: ${kredit.BALICKY.map(b => b.size).join(', ')} zápasů`,
        code:  'BAD_PACK',
      });
    }

    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const sezona = await seasonSvc.currentSeason();
    if (!sezona) {
      return res.status(409).json({ error: 'Liga nemá nastavenou aktuální sezónu', code: 'NO_CURRENT_SEASON' });
    }

    const pack = await prisma.matchPack.create({
      data: {
        playerId:     player.id,
        season:       sezona,
        size:         definice.size,
        remaining:    definice.size,
        playoffValid: definice.playoffValid,
        price:        definice.price,
      },
    });

    const session = await createCheckout({
      name:      `FSL balíček ${definice.size} ${definice.size === 1 ? 'zápas' : definice.size < 5 ? 'zápasy' : 'zápasů'} ${sezona}`,
      amountCzk: definice.price,
      type:      'match-pack',
      email:     req.user.email,
      metadata:  { packId: pack.id, playerId: player.id, type: 'MATCH_PACK' },
    });
    await prisma.matchPack.update({ where: { id: pack.id }, data: { sessionId: session.id } });

    res.json({ url: session.url, sessionId: session.id, packId: pack.id });
  } catch (err) { next(err); }
});

// POST /payments/fine – pokuta za kontumaci (platí vedoucí týmu)
router.post('/fine', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const { fineId } = req.body ?? {};
    if (!fineId) return res.status(400).json({ error: 'Chybí fineId' });

    const fine = await prisma.fine.findUnique({
      where:   { id: fineId },
      include: { team: { select: { id: true, name: true } } },
    });
    if (!fine) return res.status(404).json({ error: 'Pokuta nenalezena' });

    const teamIds = (req.user.manager ?? []).map(m => m.teamId);
    if (!teamIds.includes(fine.teamId) && !isSupervisorUser(req.user)) {
      return res.status(403).json({ error: 'Tahle pokuta není tvého týmu' });
    }
    if (fine.status === 'PAID' || fine.status === 'WAIVED') {
      return res.status(409).json({ error: 'Pokuta je už vyřízená' });
    }

    let session = await reuseOpenSession(fine.sessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL pokuta za kontumaci (${fine.team.name})`,
        amountCzk: fine.amount,
        type:      'fine',
        email:     req.user.email,
        metadata:  { fineId: fine.id, teamId: fine.teamId, type: 'FINE' },
      });
      await prisma.fine.update({
        where: { id: fine.id },
        data:  { sessionId: session.id },
      });
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// POST /payments/home-fee – zrušeno 9. 9. 2026.
//
// Poplatek 2 200 Kč za domácí zápas platil tým. Od přechodu na balíčky
// zápasy platí hráči (`POST /payments/pack`), takže tahle cesta zmizela.
// Endpoint tu zůstává jen proto, aby starší buildy aplikace dostaly
// srozumitelnou odpověď místo 404 — v Terminálu ani v logu se pak nehádá,
// kde je chyba.
router.post('/home-fee', requireAuth, (req, res) => {
  res.status(410).json({
    error: 'Poplatek za domácí zápas se už neplatí. Zápasy si kupuje každý hráč '
         + 'sám v balíčku startů.',
    code:  'HOME_FEE_REMOVED',
  });
});

// POST /payments/super-license – super licence hráče
router.post('/super-license', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const player = await prisma.player.findUnique({
      where:   { userId: req.user.id },
      include: { payment: true },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });
    if (player.payment?.superStatus === 'PAID') {
      return res.status(409).json({ error: 'Super licence je již zaplacena' });
    }

    let session = await reuseOpenSession(player.payment?.superSessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL super licence hráče ${player.payment?.season || '2025/26'}`,
        amountCzk: player.payment?.superFee || 300,
        type:      'super-license',
        email:     req.user.email,
        metadata:  { playerId: player.id, type: 'SUPER_LICENSE' },
      });
      await prisma.playerPayment.update({
        where: { playerId: player.id },
        data:  { superSessionId: session.id },
      });
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// POST /payments/team-registration – registrační poplatek týmu
router.post('/team-registration', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const managerTeamIds = (req.user.manager ?? []).map(m => m.teamId);
    const teamId = req.body?.teamId || managerTeamIds[0];
    if (!teamId) return res.status(403).json({ error: 'Nejste vedoucí žádného týmu' });
    if (!managerTeamIds.includes(teamId)) return res.status(403).json({ error: 'Tento tým nespravujete' });

    const payment = await prisma.teamPayment.findUnique({
      where:   { teamId },
      include: { team: { select: { name: true } } },
    });
    if (!payment) return res.status(404).json({ error: 'Platba týmu nenalezena' });

    // Zaplaceno loni ≠ zaplaceno letos. Řádek z minulé sezóny registraci
    // v téhle sezóně neblokuje — jinak by o poplatek nikdo nikdy nepožádal.
    const sezona  = await seasonSvc.currentSeason();
    const zeStare = jeZeStareSezony(payment, sezona);

    if (!zeStare) {
      if (payment.status === 'PAID')   return res.status(409).json({ error: 'Registrace týmu je již zaplacena' });
      if (payment.status === 'WAIVED') return res.status(409).json({ error: 'Poplatek za registraci je odpuštěn' });
    }

    let session = await reuseOpenSession(payment.sessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL registrace týmu ${payment.team.name} ${sezona || payment.season}`,
        amountCzk: payment.amount,
        type:      'team-registration',
        email:     req.user.email,
        // Sezóna jde do metadat, ať webhook ví, za jaký ročník se platí,
        // i kdyby se mezitím přepnula.
        metadata:  { teamId, type: 'TEAM_REG', season: sezona || payment.season || '' },
      });
      await prisma.teamPayment.update({
        where: { teamId },
        data:  { sessionId: session.id },
      });
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// ==================== STRIPE WEBHOOK ====================

// POST /payments/webhook – Stripe webhook (raw body vyžadován!)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const metadata = session.metadata;

    // Idempotence: zkontroluj, zda tato Stripe session již byla zpracována
    try {
      let alreadyProcessed = false;

      if (metadata.type === 'PLAYER_LICENSE' || metadata.type === 'SUPER_LICENSE') {
        const existing = await prisma.playerPayment.findFirst({
          where: { stripeId: session.id },
        });
        if (existing) alreadyProcessed = true;
      } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
        const existingTeam = await prisma.teamPayment.findFirst({
          where: { stripeId: session.id },
        });
        if (existingTeam) alreadyProcessed = true;
      } else if (metadata.type === 'MATCH_PACK' && metadata.packId) {
        const existingPack = await prisma.matchPack.findFirst({
          where: { stripeId: session.id },
        });
        if (existingPack) alreadyProcessed = true;
      } else if (metadata.type === 'FINE' && metadata.fineId) {
        const existingFine = await prisma.fine.findFirst({
          where: { stripeId: session.id },
        });
        if (existingFine) alreadyProcessed = true;
      }

      if (alreadyProcessed) {
        // Event již byl zpracován — idempotentní odpověď 200
        return res.json({ received: true, idempotent: true });
      }

      // Zpracuj platební událost.
      //
      // Zápis je všude přes `updateMany` s podmínkou „ještě není zaplaceno" —
      // stejně, jako to odjakživa dělá bankovní párování. Idempotence výš
      // hlídá jen opakování TÉHLE session; bez podmínky tady by druhá platba
      // (jiná session, nebo převod na účet) tiše přepsala tu první a nikde by
      // po ní nezůstala stopa. Když podmínka neprojde, je to dvojí platba
      // a musí ji vidět supervisor, aby ji vrátil.
      const castka = castkaZeSession(session);

      if (metadata.type === 'PLAYER_LICENSE') {
        const updated = await prisma.playerPayment.updateMany({
          where: { playerId: metadata.playerId, licStatus: { not: 'PAID' } },
          data:  {
            licStatus: 'PAID', licPaidAt: new Date(), licMethod: 'stripe',
            stripeId: session.id, ...(castka ? { licPaidAmount: castka } : {}),
          },
        });
        if (updated.count === 0) {
          await ohlasDvojiPlatbu('hráčská licence', session, castka);
        } else {
          await prisma.player.update({
            where: { id: metadata.playerId },
            data:  { licensed: true },
          });
        }
      } else if (metadata.type === 'SUPER_LICENSE') {
        const updated = await prisma.playerPayment.updateMany({
          where: { playerId: metadata.playerId, superStatus: { not: 'PAID' } },
          data:  {
            superStatus: 'PAID', superPaidAt: new Date(), superLic: true,
            stripeId: session.id, ...(castka ? { superPaidAmount: castka } : {}),
          },
        });
        if (updated.count === 0) await ohlasDvojiPlatbu('superlicence', session, castka);
      } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
        // Registrace se platí každou sezónu znovu. Když je uložený řádek
        // z minulého ročníku, přepisujeme ho na nový — a vážeme se na sezónu,
        // kterou jsme viděli, ne na `status`, protože ten je u starého
        // zaplaceného řádku PAID.
        const soucasna = await prisma.teamPayment.findUnique({ where: { teamId: metadata.teamId } });
        const sezona   = metadata.season || soucasna?.season || null;
        const zeStare  = !!soucasna && jeZeStareSezony(soucasna, sezona);
        const kde      = zeStare
          ? { teamId: metadata.teamId, season: soucasna.season }
          : { teamId: metadata.teamId, status: { not: 'PAID' } };

        const updated = await prisma.teamPayment.updateMany({
          where: kde,
          data:  {
            status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: session.id,
            ...(sezona ? { season: sezona } : {}),
            ...(castka ? { paidAmount: castka } : {}),
          },
        });
        if (updated.count === 0) await ohlasDvojiPlatbu('registrace týmu', session, castka);
      } else if (metadata.type === 'MATCH_PACK' && metadata.packId) {
        // Kredit vzniká až tady. `remaining` se nepřepisuje — kdyby se mezitím
        // stihla rezervace, nesmí ji zaplacení vrátit zpátky nahoru.
        const updated = await prisma.matchPack.updateMany({
          where: { id: metadata.packId, status: { not: 'PAID' } },
          data:  {
            status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: session.id,
            ...(castka ? { paidAmount: castka } : {}),
          },
        });
        if (updated.count === 0) {
          await ohlasDvojiPlatbu('balíček zápasů', session, castka);
        } else {
          const pack = await prisma.matchPack.findUnique({ where: { id: metadata.packId } });
          await kredit.odmenZaDoporuceni(pack.playerId, pack);
        }
      } else if (metadata.type === 'FINE' && metadata.fineId) {
        const updated = await prisma.fine.updateMany({
          where: { id: metadata.fineId, status: { notIn: ['PAID', 'WAIVED'] } },
          data:  {
            status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: session.id,
            ...(castka ? { paidAmount: castka } : {}),
          },
        });
        if (updated.count === 0) await ohlasDvojiPlatbu('pokuta za kontumaci', session, castka);
      }
    } catch (dbErr) {
      // BUG-01 OPRAVA: vrať 500 při selhání DB, aby Stripe mohl webhook opakovat
      console.error('DB update po webhook selhal:', dbErr);
      return res.status(500).json({ error: 'Interní chyba při zpracování platby' });
    }
  }

  // Refundace – vrátíme platbu do nezaplaceného stavu, ať v aplikaci nesvítí
  // „Zaplaceno" u něčeho, co je zpátky na účtu hráče.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const fullyRefunded = charge.refunded === true || charge.amount_refunded >= charge.amount;

    if (fullyRefunded && charge.payment_intent) {
      try {
        const list = await stripe.checkout.sessions.list({
          payment_intent: charge.payment_intent,
          limit: 1,
        });
        const metadata = list.data[0]?.metadata ?? {};

        if (metadata.type === 'PLAYER_LICENSE' && metadata.playerId) {
          await prisma.playerPayment.update({
            where: { playerId: metadata.playerId },
            data:  {
              licStatus: 'PENDING', licPaidAt: null, licMethod: null,
              licPaidAmount: 0,
              // Session i stripeId musi pryc. Checkout session zustava u Stripe
              // navzdy `complete`/`paid` (refunduje se charge, ne session), takze
              // dokud tu session id lezi, rekonciliace platbu do 6 h zase oznaci
              // za zaplacenou a refundaci tim tise zrusi.
              stripeId: null, licSessionId: null,
            },
          });
          await prisma.player.update({
            where: { id: metadata.playerId },
            data:  { licensed: false },
          });
        } else if (metadata.type === 'SUPER_LICENSE' && metadata.playerId) {
          await prisma.playerPayment.update({
            where: { playerId: metadata.playerId },
            data:  {
              superStatus: 'PENDING', superPaidAt: null, superLic: false,
              superPaidAmount: 0, superSessionId: null,
            },
          });
        } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
          await prisma.teamPayment.update({
            where: { teamId: metadata.teamId },
            data:  {
              status: 'PENDING', paidAt: null, method: null,
              paidAmount: 0, stripeId: null, sessionId: null,
            },
          });
        } else if (metadata.type === 'MATCH_PACK' && metadata.packId) {
          // Tohle je ta půlka, která dosud chyběla: peníze se vrátily,
          // ale kredit hráči zůstal, takže dál chodil hrát za cizí.
          //
          // Zbytek balíčku se ruší. Starty, které už hráč vypotřeboval,
          // se nikam nevrací — odehrané zápasy jsou odehrané. Kdyby se
          // vracely, kontroloval by kredit sestavu zpětně a zápasy
          // odehrané „na dluh" by nešlo srovnat.
          const pack = await prisma.matchPack.findUnique({ where: { id: metadata.packId } });
          if (pack) {
            await prisma.matchPack.update({
              where: { id: pack.id },
              data:  { status: 'REFUNDED', remaining: 0, paidAmount: 0 },
            });
            const vycerpano = pack.size - pack.remaining;
            if (vycerpano > 0) {
              await ohlasSupervisorum(
                'Vrácený balíček měl odehrané zápasy',
                `Vrácena platba za balíček ${pack.size} zápasů, ale ${vycerpano} `
                + `${vycerpano === 1 ? 'z nich už byl odehraný' : 'z nich už bylo odehraných'}. `
                + 'Vrácená částka by tomu měla odpovídat — zkontroluj to ve Stripu.',
              );
            }
          }
        } else if (metadata.type === 'FINE' && metadata.fineId) {
          await prisma.fine.update({
            where: { id: metadata.fineId },
            data:  { status: 'PENDING', paidAt: null, method: null, paidAmount: 0, stripeId: null },
          });
        } else if (metadata.type === 'HOME_FEE') {
          // Poplatek za domácí zápas se od 9. 9. 2026 nevybírá a sloupce
          // po něm ve schématu nezůstaly. Kdyby dorazila refundace staré
          // platby, není co přepsat — ať se o tom aspoň ví.
          await ohlasSupervisorum(
            'Refundace zrušeného poplatku',
            `Vrácena platba za domácí zápas (session ${session.id}). Tenhle poplatek `
            + 'se už nevybírá, v databázi po něm nic nezůstalo — zkontroluj to ve Stripu.',
          );
        }
      } catch (err) {
        console.error('Zpracování refundace selhalo:', err);
        return res.status(500).json({ error: 'Interní chyba při zpracování refundace' });
      }
    }
  }

  res.json({ received: true });
});

// ==================== SUPERVISOR – RUČNÍ ÚPRAVA ====================

// PUT /payments/team/:teamId – ruční update stavu týmové platby (supervisor)
router.put('/team/:teamId', requireSupervisor, async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['PENDING', 'PAID', 'OVERDUE', 'WAIVED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Neplatný stav platby' });
    }
    const payment = await prisma.teamPayment.update({
      where: { teamId: req.params.teamId },
      data: {
        status,
        ...(status === 'PAID' && { paidAt: new Date(), method: 'manual' }),
      },
    });
    res.json(payment);
  } catch (err) { next(err); }
});

// PUT /payments/player/:playerId – ruční update stavu platby (supervisor)
router.put('/player/:playerId', requireSupervisor, async (req, res, next) => {
  try {
    const { licStatus, superStatus } = req.body;
    const validStatuses = ['PENDING', 'PAID', 'OVERDUE', 'WAIVED'];
    if (licStatus && !validStatuses.includes(licStatus)) {
      return res.status(400).json({ error: 'Neplatný stav licence' });
    }
    if (superStatus && !validStatuses.includes(superStatus)) {
      return res.status(400).json({ error: 'Neplatný stav superlicence' });
    }
    if (!licStatus && !superStatus) {
      return res.status(400).json({ error: 'Chybí licStatus nebo superStatus' });
    }
    const payment = await prisma.playerPayment.update({
      where: { playerId: req.params.playerId },
      data: {
        ...(licStatus   && { licStatus,   ...(licStatus   === 'PAID' && { licPaidAt:   new Date(), licMethod: 'manual' }) }),
        ...(superStatus && { superStatus, ...(superStatus === 'PAID' && { superPaidAt: new Date() }) }),
      },
    });
    if (licStatus === 'PAID') {
      await prisma.player.update({ where: { id: req.params.playerId }, data: { licensed: true } });
    }
    res.json(payment);
  } catch (err) { next(err); }
});

// ==================== BANKOVNÍ PŘEVODY ====================

// GET /payments/qr/:type/:id – QR kód pro platbu převodem (SPAYD)
// type: player-license | super-license | team-reg | match-pack | fine
// id:   playerId (licence), teamId (registrace), packId (balíček) nebo fineId (pokuta)
router.get('/qr/:type/:id', requireAuth, async (req, res, next) => {
  try {
    if (!transferConfigured()) {
      return res.status(503).json({
        error: 'Platba převodem zatím není spuštěná. Zaplať prosím kartou nebo přes peněženku.',
        code:  'BANK_NOT_CONFIGURED',
      });
    }
    // Bez tohohle stačilo být přihlášený kdokoli a znát cizí id — a ta jsou
    // vidět ve veřejném API. K platbě patří její vlastník a supervisor.
    if (!await overPlatbu(req, res, req.params.type, req.params.id)) return;
    const data = await getPaymentQR(req.params.type, req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /payments/vs/player/:playerId – vrátí (nebo vygeneruje) VS hráče
router.get('/vs/player/:playerId', requireAuth, async (req, res, next) => {
  try {
    const { type = 'PLAYER_LICENSE' } = req.query;
    const kontrola = type === 'SUPER_LICENSE' ? 'super-license' : 'player-license';
    if (!await overPlatbu(req, res, kontrola, req.params.playerId)) return;
    const vs = await ensurePlayerVS(req.params.playerId, type);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// GET /payments/vs/team/:teamId – vrátí (nebo vygeneruje) VS registrace týmu
router.get('/vs/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    if (!await overPlatbu(req, res, 'team-reg', req.params.teamId)) return;
    const vs = await ensureTeamVS(req.params.teamId);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// GET /payments/vs/pack/:packId – VS konkrétního balíčku zápasů
router.get('/vs/pack/:packId', requireAuth, async (req, res, next) => {
  try {
    if (!await overPlatbu(req, res, 'match-pack', req.params.packId)) return;
    const vs = await ensurePackVS(req.params.packId);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// GET /payments/vs/fine/:fineId – VS pokuty za kontumaci
router.get('/vs/fine/:fineId', requireAuth, async (req, res, next) => {
  try {
    if (!await overPlatbu(req, res, 'fine', req.params.fineId)) return;
    const vs = await ensureFineVS(req.params.fineId);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// POST /payments/stripe-sync – ruční rekonciliace proti Stripe (supervisor)
router.post('/stripe-sync', requireSupervisor, async (req, res, next) => {
  try {
    const { reconcileStripePayments } = require('../services/stripeSync');
    const results = await reconcileStripePayments();
    res.json(results);
  } catch (err) { next(err); }
});

// POST /payments/bank-sync – ruční spuštění párování (supervisor)
router.post('/bank-sync', requireSupervisor, async (req, res, next) => {
  try {
    const { days = 30 } = req.body;
    const results = await bankSync(parseInt(days));
    res.json(results);
  } catch (err) { next(err); }
});

// GET /payments/bank-transactions – přehled bankovních transakcí (supervisor)
router.get('/bank-transactions', requireSupervisor, async (req, res, next) => {
  try {
    const { matched, limit = '100' } = req.query;
    const transactions = await prisma.bankTransaction.findMany({
      where: matched !== undefined ? { matched: matched === 'true' } : undefined,
      orderBy: { date: 'desc' },
      take: parseInt(limit),
    });
    res.json(transactions);
  } catch (err) { next(err); }
});

module.exports = router;
