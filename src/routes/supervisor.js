const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireSupervisor } = require('../middleware/auth');
const { createNotification, createNotifications } = require('./notifications');

const router = express.Router();
const prisma = new PrismaClient();

// Všechny endpointy v tomto souboru vyžadují supervisor roli
router.use(requireSupervisor);

// ==================== PŘEHLED ====================

// GET /supervisor/dashboard – souhrnné statistiky pro supervisor panel
router.get('/dashboard', async (req, res, next) => {
  try {
    const [
      pendingReferees,
      pendingRequests,
      upcomingMatches,
      totalTeams,
      totalPlayers,
      unpaidLicenses,
    ] = await Promise.all([
      prisma.referee.count({ where: { status: 'PENDING' } }),
      prisma.supervisorRequest.count({ where: { status: 'PENDING' } }),
      prisma.match.count({ where: { status: 'UPCOMING', date: { gte: new Date() } } }),
      prisma.team.count(),
      prisma.player.count(),
      prisma.playerPayment.count({ where: { licStatus: { not: 'PAID' } } }),
    ]);

    res.json({
      pendingReferees,
      pendingRequests,
      upcomingMatches,
      totalTeams,
      totalPlayers,
      unpaidLicenses,
    });
  } catch (err) { next(err); }
});

// ==================== FRONTA ŽÁDOSTÍ ====================

// GET /supervisor/requests – všechny žádosti
router.get('/requests', async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const requests = await prisma.supervisorRequest.findMany({
      where: {
        ...(status && { status }),
        ...(type   && { type }),
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

// POST /supervisor/requests – vytvoření žádosti (vedoucí/hráč)
// Pozn.: tato route NEVYŽADUJE supervisor – přidáme separátní handler
router.post('/requests', async (req, res, next) => {
  // Tato cesta je dostupná bez supervisor, je volána z jiné route montáže
  // Viz server.js: router.post('/supervisor/requests', requireAuth, ...)
  next();
});

// PUT /supervisor/requests/:id – zpracování žádosti
router.put('/requests/:id', async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const validStatuses = ['IN_PROGRESS', 'APPROVED', 'REJECTED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Neplatný stav žádosti' });
    }

    const request = await prisma.supervisorRequest.update({
      where: { id: req.params.id },
      data: { status, ...(note && { note }) },
    });
    res.json(request);
  } catch (err) { next(err); }
});

// ==================== ROZHODČÍ ====================

// GET /supervisor/referees – seznam čekajících rozhodčích
router.get('/referees', async (req, res, next) => {
  try {
    const { status = 'PENDING' } = req.query;
    const refs = await prisma.referee.findMany({
      where: { status },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(refs);
  } catch (err) { next(err); }
});

// ==================== ZÁPASY ====================

// GET /supervisor/matches – správa zápasů
router.get('/matches', async (req, res, next) => {
  try {
    const { status, division, round } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status   && { status }),
        ...(division && { division }),
        ...(round    && { round: parseInt(round) }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true } },
        awayTeam: { select: { id: true, name: true, abbr: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
      },
      orderBy: { date: 'asc' },
    });
    res.json(matches);
  } catch (err) { next(err); }
});

// POST /supervisor/matches/:id/assign-referee – přiřazení rozhodčího k zápasu
router.post('/matches/:id/assign-referee', async (req, res, next) => {
  try {
    const { refereeId } = req.body;
    if (!refereeId) return res.status(400).json({ error: 'Chybí refereeId' });

    const ref = await prisma.referee.findUnique({ where: { id: refereeId } });
    if (!ref || ref.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Rozhodčí není schválen' });
    }

    const match = await prisma.match.update({
      where: { id: req.params.id },
      data:  { refereeId },
      include: {
        homeTeam: true,
        awayTeam: true,
        referee:  { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Notifikace rozhodčímu (+ push)
    await createNotification(ref.userId, 'Nové nasazení',
      `Byl(a) jste nasazen(a) na zápas ${match.homeTeam.abbr} vs ${match.awayTeam.abbr}`, 'ref-detail');

    res.json(match);
  } catch (err) { next(err); }
});

// ==================== SOUTĚŽE A DIVIZE ====================

// GET /supervisor/divisions – přehled divízí a počtů týmů
router.get('/divisions', async (req, res, next) => {
  try {
    const divisions = await prisma.team.groupBy({
      by: ['division'],
      _count: { division: true },
      orderBy: { division: 'asc' },
    });
    res.json(divisions);
  } catch (err) { next(err); }
});

// ==================== PLATBY ====================

// GET /supervisor/payments – přehled plateb
router.get('/payments', async (req, res, next) => {
  try {
    const { status } = req.query;
    const [players, teams] = await Promise.all([
      prisma.playerPayment.findMany({
        where: status ? { licStatus: status } : undefined,
        include: {
          player: {
            select: { id: true, firstName: true, lastName: true, jersey: true,
              team: { select: { id: true, name: true, abbr: true } } },
          },
        },
        orderBy: { player: { lastName: 'asc' } },
      }),
      prisma.teamPayment.findMany({
        where: status ? { status } : undefined,
        include: { team: { select: { id: true, name: true, abbr: true } } },
        orderBy: { team: { name: 'asc' } },
      }),
    ]);
    res.json({ players, teams });
  } catch (err) { next(err); }
});

// ==================== NOTIFIKACE ====================

// POST /supervisor/notify – odeslání notifikace hráčům/rozhodčím
router.post('/notify', async (req, res, next) => {
  try {
    const { userIds, title, body, screen } = req.body;
    if (!userIds?.length || !title || !body) {
      return res.status(400).json({ error: 'Chybí userIds, title nebo body' });
    }

    const items = userIds.map(userId => ({ userId, title, body, screen: screen || null }));
    await createNotifications(items);
    res.json({ sent: items.length });
  } catch (err) { next(err); }
});

module.exports = router;
