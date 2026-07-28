const express = require('express');

const { requireSupervisor } = require('../middleware/auth');
const { createNotification, createNotifications } = require('./notifications');

const router = express.Router();
const prisma = require('../lib/prisma');

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
      include: { user: { select: { id: true, email: true } } },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

// POST /supervisor/requests – přímé vytvoření žádosti supervisorem
router.post('/requests', async (req, res, next) => {
  try {
    const { type, userId, teamId, matchId, body, note } = req.body;
    if (!type || !body) return res.status(400).json({ error: 'Chybí type nebo body' });
    const request = await prisma.supervisorRequest.create({
      data: { type, userId: userId || null, teamId: teamId || null, matchId: matchId || null, body, note: note || null },
      include: { user: { select: { id: true, email: true } } },
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

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
    const { name, abbr, division, color, venue, conference } = req.body;
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
        abbr:       abbr.toUpperCase(),
        division,
        color:      color ?? '#C9A140',
        venue:      venue || null,
        conference: conference || null,
      },
      include: { _count: { select: { players: true } } },
    });
    res.status(201).json(team);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id – úprava týmu
router.put('/teams/:id', async (req, res, next) => {
  try {
    const { name, abbr, division, color, venue, conference } = req.body;
    const data = {};
    if (name)                data.name       = name;
    if (abbr)                data.abbr       = abbr.toUpperCase();
    if (division)            data.division   = division;
    if (color)               data.color      = color;
    if (venue !== undefined) data.venue      = venue || null;
    if (conference !== undefined) data.conference = conference || null;

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
      by: ['division', 'conference'],
      _count: { division: true },
      orderBy: { division: 'asc' },
    });
    res.json(divisions);
  } catch (err) { next(err); }
});

// GET /supervisor/conferences – strom Konference → Divize → Týmy
router.get('/conferences', async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      select: { id: true, name: true, abbr: true, color: true, division: true, conference: true, venue: true },
      orderBy: [{ conference: 'asc' }, { division: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
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
// Podporuje: division | conference | teamIds[]
router.post('/fixtures/preview', async (req, res, next) => {
  try {
    const { division, conference, teamIds, doubleRoundRobin = false } = req.body;

    let teams;
    if (Array.isArray(teamIds) && teamIds.length >= 2) {
      teams = await prisma.team.findMany({ where: { id: { in: teamIds } } });
    } else if (conference) {
      teams = await prisma.team.findMany({ where: { conference } });
    } else if (division) {
      teams = await prisma.team.findMany({ where: { division } });
    } else {
      return res.status(400).json({ error: 'Zadej division, conference nebo teamIds' });
    }

    if (teams.length < 2) return res.status(400).json({ error: 'Potřeba alespoň 2 týmy' });

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
// Podporuje: division | conference | teamIds[]
router.post('/fixtures/generate', async (req, res, next) => {
  try {
    const {
      division, conference, teamIds,
      competition      = 'FSL Liga',
      startDate,
      roundIntervalDays = 7,
      defaultTime      = '18:00',
      defaultVenue     = null,
      doubleRoundRobin = false,
      deleteExisting   = false,
    } = req.body;

    if (!startDate) return res.status(400).json({ error: 'Chybí startDate' });

    let teams;
    let matchDivision = division ?? 'Mix';
    let matchConference = conference ?? null;

    if (Array.isArray(teamIds) && teamIds.length >= 2) {
      teams = await prisma.team.findMany({ where: { id: { in: teamIds } } });
      matchDivision = division || 'Mix';
    } else if (conference) {
      teams = await prisma.team.findMany({ where: { conference } });
      matchConference = conference;
      matchDivision = division || conference;
    } else if (division) {
      teams = await prisma.team.findMany({ where: { division } });
    } else {
      return res.status(400).json({ error: 'Zadej division, conference nebo teamIds' });
    }

    if (teams.length < 2) return res.status(400).json({ error: 'Potřeba alespoň 2 týmy' });

    if (deleteExisting) {
      if (Array.isArray(teamIds) && teamIds.length >= 2) {
        await prisma.match.deleteMany({
          where: { status: 'UPCOMING', OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }] },
        });
      } else {
        await prisma.match.deleteMany({ where: { division: matchDivision, status: 'UPCOMING' } });
      }
    }

    const fixtures = generateRoundRobin(teams.map(t => t.id), doubleRoundRobin);
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
        division:    matchDivision,
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
      division: matchDivision,
      conference: matchConference,
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

// ==================== SEZÓNA ====================

// POST /supervisor/new-season – uzavře starou sezónu, spustí novou
router.post('/new-season', async (req, res, next) => {
  try {
    const { newSeason, cancelPending = false } = req.body;

    // Validace formátu sezóny (např. "2026/27")
    if (!newSeason || !/^\d{4}\/\d{2}$/.test(newSeason)) {
      return res.status(400).json({ error: 'Neplatný formát sezóny – použij tvar "2026/27"' });
    }

    // Zjisti aktuální sezónu (nejnovější z DB)
    const latestMatch = await prisma.match.findFirst({ orderBy: { createdAt: 'desc' }, select: { season: true } });
    const oldSeason = latestMatch?.season ?? null;

    if (oldSeason === newSeason) {
      return res.status(409).json({ error: 'Tato sezóna je již aktivní' });
    }

    let cancelledCount = 0;
    if (cancelPending && oldSeason) {
      // Zruš všechny UPCOMING zápasy ze staré sezóny
      const result = await prisma.match.updateMany({
        where: { season: oldSeason, status: 'UPCOMING' },
        data:  { status: 'CANCELLED' },
      });
      cancelledCount = result.count;
    }

    // MISSING-02: Reset licencí hráčů a plateb týmů na PENDING pro novou sezónu
    const [resetLic, resetTeam] = await Promise.all([
      prisma.playerPayment.updateMany({
        data: { licStatus: 'PENDING', licPaidAt: null, licMethod: null,
                superStatus: 'PENDING', superPaidAt: null, season: newSeason },
      }),
      prisma.teamPayment.updateMany({
        data: { status: 'PENDING', paidAt: null, method: null, season: newSeason },
      }),
    ]);
    // Zrušit player.licensed pro všechny hráče
    await prisma.player.updateMany({ data: { licensed: false } });

    res.json({
      oldSeason,
      newSeason,
      cancelledMatches: cancelledCount,
      resetLicenses: resetLic.count,
      resetTeams: resetTeam.count,
      message: `Sezóna přepnuta na ${newSeason}. Zrušeno ${cancelledCount} zápasů, resetováno ${resetLic.count} licencí.`,
    });
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
