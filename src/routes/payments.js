const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { bankSync, ensurePlayerVS, ensureTeamVS, getPaymentQR } = require('../services/bankSync');

const router = express.Router();
const prisma = new PrismaClient();

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

// ==================== STRIPE – HRÁČSKÁ LICENCE ====================

// POST /payments/player-license – vytvoření platební relace (Stripe Checkout / Payment Intent)
router.post('/player-license', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where:   { userId: req.user.id },
      include: { payment: true },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });
    if (player.payment?.licStatus === 'PAID') {
      return res.status(409).json({ error: 'Licence je již zaplacena' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],
      line_items: [{
        price_data: {
          currency: 'czk',
          product_data: { name: 'FSL hráčská licence 2025/26' },
          unit_amount: (player.payment?.licFee || 300) * 100, // haléře
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/payment-success?type=license`,
      cancel_url:  `${process.env.CLIENT_URL}/payments`,
      metadata: { playerId: player.id, type: 'PLAYER_LICENSE' },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// POST /payments/home-fee – poplatek za domácí zápas (2 200 Kč)
router.post('/home-fee', requireAuth, async (req, res, next) => {
  try {
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
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],
      line_items: [{
        price_data: {
          currency: 'czk',
          product_data: { name: `FSL poplatek za domácí zápas (${dateStr})` },
          unit_amount: 220000, // 2 200 Kč v haléřích
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/payment-success?type=home-fee`,
      cancel_url:  `${process.env.CLIENT_URL}/payments`,
      metadata: { teamId: match.homeTeamId, matchId, type: 'HOME_FEE' },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { next(err); }
});

// POST /payments/super-license – super licence hráče
router.post('/super-license', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where:   { userId: req.user.id },
      include: { payment: true },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });
    if (player.payment?.superStatus === 'PAID') {
      return res.status(409).json({ error: 'Super licence je již zaplacena' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],
      line_items: [{
        price_data: {
          currency: 'czk',
          product_data: { name: 'FSL super licence hráče 2025/26' },
          unit_amount: (player.payment?.superFee || 300) * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/payment-success?type=super-license`,
      cancel_url:  `${process.env.CLIENT_URL}/payments`,
      metadata: { playerId: player.id, type: 'SUPER_LICENSE' },
    });

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

    try {
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
      }
    } catch (dbErr) {
      console.error('DB update after webhook failed:', dbErr);
    }
  }

  res.json({ received: true });
});

// ==================== SUPERVISOR – RUČNÍ ÚPRAVA ====================

// PUT /payments/player/:playerId – ruční update stavu platby (supervisor)
router.put('/player/:playerId', requireSupervisor, async (req, res, next) => {
  try {
    const { licStatus, superStatus } = req.body;
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
// id:   playerId nebo teamId
router.get('/qr/:type/:id', requireAuth, async (req, res, next) => {
  try {
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

// GET /payments/vs/team/:teamId – vrátí (nebo vygeneruje) VS týmu
router.get('/vs/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { type = 'TEAM_REG' } = req.query;
    const vs = await ensureTeamVS(req.params.teamId, type);
    res.json({ variableSymbol: vs });
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
