const express = require('express');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { bankSync, ensurePlayerVS, ensureTeamVS, ensureMatchHomeFeeVS, getPaymentQR, HOME_FEE_AMOUNT } = require('../services/bankSync');

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

// ==================== PŘEHLED PLATEB ====================

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

    res.json({
      playerPayment: player?.payment ?? null,
      teamPayment,
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
        amountCzk: player.payment?.licFee || 250,
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

// POST /payments/home-fee – poplatek za domácí zápas (2 200 Kč)
router.post('/home-fee', requireAuth, async (req, res, next) => {
  try {
    if (!assertStripe(res)) return;
    const { matchId } = req.body;
    const managerTeamIds = (req.user.manager ?? []).map(m => m.teamId);
    if (managerTeamIds.length === 0) return res.status(403).json({ error: 'Nejste vedoucí žádného týmu' });
    if (!matchId) return res.status(400).json({ error: 'Chybí matchId' });

    // Ověř zápas – musí být domácí a ještě nezaplacený
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (!managerTeamIds.includes(match.homeTeamId)) return res.status(403).json({ error: 'Tento zápas není váš domácí' });
    if (match.homeFeePaid) return res.status(409).json({ error: 'Poplatek za tento zápas je již uhrazen' });

    const dateStr = new Date(match.date).toLocaleDateString('cs-CZ');
    let session = await reuseOpenSession(match.homeFeeSessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL poplatek za domácí zápas (${dateStr})`,
        amountCzk: HOME_FEE_AMOUNT,
        type:      'home-fee',
        email:     req.user.email,
        metadata:  { teamId: match.homeTeamId, matchId, type: 'HOME_FEE' },
      });
      await prisma.match.update({
        where: { id: matchId },
        data:  { homeFeeSessionId: session.id },
      });
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
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
        amountCzk: player.payment?.superFee || 250,
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
    if (payment.status === 'PAID')   return res.status(409).json({ error: 'Registrace týmu je již zaplacena' });
    if (payment.status === 'WAIVED') return res.status(409).json({ error: 'Poplatek za registraci je odpuštěn' });

    let session = await reuseOpenSession(payment.sessionId);
    if (!session) {
      session = await createCheckout({
        name:      `FSL registrace týmu ${payment.team.name} ${payment.season}`,
        amountCzk: payment.amount,
        type:      'team-registration',
        email:     req.user.email,
        metadata:  { teamId, type: 'TEAM_REG' },
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
      } else if (metadata.type === 'HOME_FEE' && metadata.matchId) {
        const existingMatch = await prisma.match.findFirst({
          where: { homeFeeStripeId: session.id },
        });
        if (existingMatch) alreadyProcessed = true;
      } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
        const existingTeam = await prisma.teamPayment.findFirst({
          where: { stripeId: session.id },
        });
        if (existingTeam) alreadyProcessed = true;
      }

      if (alreadyProcessed) {
        // Event již byl zpracován — idempotentní odpověď 200
        return res.json({ received: true, idempotent: true });
      }

      // Zpracuj platební událost
      if (metadata.type === 'PLAYER_LICENSE') {
        await prisma.playerPayment.update({
          where: { playerId: metadata.playerId },
          data:  { licStatus: 'PAID', licPaidAt: new Date(), licMethod: 'stripe', stripeId: session.id },
        });
        await prisma.player.update({
          where: { id: metadata.playerId },
          data:  { licensed: true },
        });
      } else if (metadata.type === 'SUPER_LICENSE') {
        await prisma.playerPayment.update({
          where: { playerId: metadata.playerId },
          data:  { superStatus: 'PAID', superPaidAt: new Date(), superLic: true, stripeId: session.id },
        });
      } else if (metadata.type === 'HOME_FEE' && metadata.matchId) {
        await prisma.match.update({
          where: { id: metadata.matchId },
          data:  { homeFeePaid: true, homeFeeStripeId: session.id },
        });
      } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
        await prisma.teamPayment.update({
          where: { teamId: metadata.teamId },
          data:  { status: 'PAID', paidAt: new Date(), method: 'stripe', stripeId: session.id },
        });
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
            data:  { licStatus: 'PENDING', licPaidAt: null, licMethod: null, stripeId: null },
          });
          await prisma.player.update({
            where: { id: metadata.playerId },
            data:  { licensed: false },
          });
        } else if (metadata.type === 'SUPER_LICENSE' && metadata.playerId) {
          await prisma.playerPayment.update({
            where: { playerId: metadata.playerId },
            data:  { superStatus: 'PENDING', superPaidAt: null, superLic: false },
          });
        } else if (metadata.type === 'TEAM_REG' && metadata.teamId) {
          await prisma.teamPayment.update({
            where: { teamId: metadata.teamId },
            data:  { status: 'PENDING', paidAt: null, method: null, stripeId: null },
          });
        } else if (metadata.type === 'HOME_FEE' && metadata.matchId) {
          await prisma.match.update({
            where: { id: metadata.matchId },
            data:  { homeFeePaid: false, homeFeeStripeId: null },
          });
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
// type: player-license | super-license | team-reg | home-fee
// id:   playerId (licence), teamId (registrace) nebo matchId (domácí zápas)
router.get('/qr/:type/:id', requireAuth, async (req, res, next) => {
  try {
    if (!transferConfigured()) {
      return res.status(503).json({
        error: 'Platba převodem zatím není spuštěná. Zaplať prosím kartou nebo přes peněženku.',
        code:  'BANK_NOT_CONFIGURED',
      });
    }
    const data = await getPaymentQR(req.params.type, req.params.id);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /payments/vs/player/:playerId – vrátí (nebo vygeneruje) VS hráče
router.get('/vs/player/:playerId', requireAuth, async (req, res, next) => {
  try {
    const { type = 'PLAYER_LICENSE' } = req.query;
    const vs = await ensurePlayerVS(req.params.playerId, type);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// GET /payments/vs/team/:teamId – vrátí (nebo vygeneruje) VS registrace týmu
router.get('/vs/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    const vs = await ensureTeamVS(req.params.teamId);
    res.json({ variableSymbol: vs });
  } catch (err) { next(err); }
});

// GET /payments/vs/match/:matchId – VS poplatku za konkrétní domácí zápas
router.get('/vs/match/:matchId', requireAuth, async (req, res, next) => {
  try {
    const vs = await ensureMatchHomeFeeVS(req.params.matchId);
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
