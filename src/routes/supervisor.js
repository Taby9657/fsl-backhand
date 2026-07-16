const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireSupervisor } = require('../middleware/auth');
const { createNotification, createNotifications } = require('./notifications');

const router = express.Router();
const prisma = new PrismaClient();

// Všechny endpointy v tomto souboru vyžadují supervisor roli
router.use(requireSupervisor);

// ==================== PŘEHLED ====================

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

    res.json({ pendingReferees, pendingRequests, upcomingMatches, totalTeams, totalPlayers, unpaidLicenses });
  } catch (err) { next(err); }
});

// ==================== FRONTA ŽÁDOSTÍ ====================

router.get('/requests', async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const requests = await prisma.supervisorRequest.findMany({
      where: { ...(status && { status }), ...(type && { type }) },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

router.post('/requests', async (req, res, next) => { next(); });

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
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
      },
      orderBy: [{ round: 'asc' }, { date: 'asc' }],
    });
    res.json(matches);
  } catch (err) { next(err); }
});

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

    await createNotification(ref.userId, 'Nové nasazení',
      `Byl(a) jste nasazen(a) na zápas ${match.homeTeam.abbr} vs ${match.awayTeam.abbr}`, 'ref-detail');

    res.json(match);
  } catch (err) { next(err); }
});

// DELETE /supervisor/matches/:id – smazání zápasu (jen UPCOMING)
router.delete('/matches/:id', async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Lze smazat pouze naplánované zápasy' });
    }
    await prisma.match.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SPRÁVA TÝMŮ ====================

// GET /supervisor/teams – všechny týmy s počtem hráčů
router.get('/teams', async (req, res, next) => {
  try {
    const { division } = req.query;
    const teams = await prisma.team.findMany({
      where: division ? { division } : undefined,
      include: {
        _count: { select: { players: true } },
      },
      orderBy: [{ division: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// POST /supervisor/teams – vytvoření týmu
router.post('/teams', async (req, res, next) => {
  try {
    const { name, abbr, division, color, venue } = req.body;
    if (!name || !abbr || !division) {
      return res.status(400).json({ error: 'Chybí name, abbr nebo division' });
    }
    if (abbr.length > 3) {
      return res.status(400).json({ error: 'Zkratka max 3 znaky' });
    }

    const existing = await prisma.team.findFirst({ where: { abbr: abbr.toUpperCase(), division } });
    if (existing) return res.status(409).json({ error: `Tým se zkratkou ${abbr} již v divizi existuje` });

    const team = await prisma.team.create({
      data: {
        name,
        abbr:     abbr.toUpperCase(),
        division,
        color:    color ?? '#C9A140',
        venue:    venue ?? null,
      },
      include: { _count: { select: { players: true } } },
    });
    res.status(201).json(team);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id – úprava týmu
router.put('/teams/:id', async (req, res, next) => {
  try {
    const { name, abbr, division, color, venue } = req.body;
    const data = {};
    if (name)     data.name     = name;
    if (abbr)     data.abbr     = abbr.toUpperCase();
    if (division) data.division = division;
    if (color)    data.color    = color;
    if (venue !== undefined) data.venue = venue;

    const team = await prisma.team.update({
      where: { id: req.params.id },
      data,
      include: { _count: { select: { players: true } } },
    });
    res.json(team);
  } catch (err) { next(err); }
});

// DELETE /supervisor/teams/:id – smazání týmu (jen pokud nemá hráče/zápasy)
router.delete('/teams/:id', async (req, res, next) => {
  try {
    const [playerCount, matchCount] = await Promise.all([
      prisma.player.count({ where: { teamId: req.params.id } }),
      prisma.match.count({
        where: { OR: [{ homeTeamId: req.params.id }, { awayTeamId: req.params.id }] },
      }),
    ]);

    if (playerCount > 0) {
      return res.status(400).json({ error: `Tým má ${playerCount} hráčů – nejdříve je přesuň nebo odstraň` });
    }
    if (matchCount > 0) {
      return res.status(400).json({ error: `Tým má ${matchCount} zápasů – nejdříve je smaž` });
    }

    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SOUTĚŽE A DIVIZE ====================

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

// ==================== ROZLOSOVÁNÍ ====================

/**
 * Round-robin algoritmus
 * Vrací pole { homeTeamId, awayTeamId, round }
 * doubleRoundRobin = true → každý s každým doma i venku
 */
function generateRoundRobin(teamIds, doubleRoundRobin = false) {
  const teams = [...teamIds];
  if (teams.length % 2 !== 0) teams.push(null); // BYE
  const n = teams.length;
  const firstLeg = [];
  const rotation = [...teams];

  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const home = rotation[i];
      const away = rotation[n - 1 - i];
      if (home !== null && away !== null) {
        firstLeg.push({ homeTeamId: home, awayTeamId: away, round: r + 1 });
      }
    }
    // Rotace: rotation[0] fixní, zbytek rotuje
    const last = rotation.pop();
    rotation.splice(1, 0, last);
  }

  if (!doubleRoundRobin) return firstLeg;

  const totalRounds = n - 1;
  const secondLeg = firstLeg.map(m => ({
    homeTeamId: m.awayTeamId,
    awayTeamId: m.homeTeamId,
    round:      m.round + totalRounds,
  }));

  return [...firstLeg, ...secondLeg];
}

// POST /supervisor/fixtures/preview – náhled (bez uložení)
router.post('/fixtures/preview', async (req, res, next) => {
  try {
    const { division, doubleRoundRobin = false } = req.body;
    if (!division) return res.status(400).json({ error: 'Chybí division' });

    const teams = await prisma.team.findMany({ where: { division } });
    if (teams.length < 2) return res.status(400).json({ error: 'Divize potřebuje alespoň 2 týmy' });

    const fixtures = generateRoundRobin(teams.map(t => t.id), doubleRoundRobin);
    const rounds = Math.max(...fixtures.map(f => f.round));

    res.json({
      teams:    teams.length,
      matches:  fixtures.length,
      rounds,
      fixtures: fixtures.map(f => ({
        round:    f.round,
        homeTeam: teams.find(t => t.id === f.homeTeamId),
        awayTeam: teams.find(t => t.id === f.awayTeamId),
      })),
    });
  } catch (err) { next(err); }
});

// POST /supervisor/fixtures/generate – vytvoření zápasů v DB
router.post('/fixtures/generate', async (req, res, next) => {
  try {
    const {
      division,
      competition    = 'FSL Liga',
      startDate,           // ISO string prvního kola
      roundIntervalDays = 7,
      defaultTime    = '18:00',   // HH:MM
      defaultVenue   = null,
      doubleRoundRobin = false,
      deleteExisting = false,
    } = req.body;

    if (!division || !startDate) {
      return res.status(400).json({ error: 'Chybí division nebo startDate' });
    }

    const teams = await prisma.team.findMany({ where: { division } });
    if (teams.length < 2) return res.status(400).json({ error: 'Divize potřebuje alespoň 2 týmy' });

    // Smazat existující naplánované zápasy divize
    if (deleteExisting) {
      await prisma.match.deleteMany({ where: { division, status: 'UPCOMING' } });
    }

    const fixtures = generateRoundRobin(teams.map(t => t.id), doubleRoundRobin);

    // Sestavit data zápasů
    const [hour, minute] = defaultTime.split(':').map(Number);
    const base = new Date(startDate);

    const matchData = fixtures.map(f => {
      const d = new Date(base);
      d.setDate(d.getDate() + (f.round - 1) * roundIntervalDays);
      d.setHours(hour, minute, 0, 0);
      return {
        homeTeamId:  f.homeTeamId,
        awayTeamId:  f.awayTeamId,
        round:       f.round,
        division,
        competition,
        date:        d,
        venue:       defaultVenue,
        status:      'UPCOMING',
      };
    });

    await prisma.match.createMany({ data: matchData });

    res.json({
      created:  matchData.length,
      rounds:   Math.max(...fixtures.map(f => f.round)),
      division,
    });
  } catch (err) { next(err); }
});

// ==================== PLATBY ====================

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
