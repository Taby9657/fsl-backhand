const express = require('express');

const { requireSupervisor } = require('../middleware/auth');
const { createNotification, createNotifications } = require('./notifications');
const seasonSvc = require('../services/seasonTransition');

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
      pendingTeams,
      appealingTeams,
    ] = await Promise.all([
      prisma.referee.count({ where: { status: 'PENDING' } }),
      prisma.supervisorRequest.count({ where: { status: 'PENDING' } }),
      prisma.match.count({ where: { status: 'UPCOMING', date: { gte: new Date() } } }),
      prisma.team.count(),
      prisma.player.count(),
      prisma.playerPayment.count({ where: { licStatus: { not: 'PAID' } } }),
      prisma.team.count({ where: { regStatus: 'PENDING' } }),
      prisma.team.count({ where: { regStatus: 'APPEALING' } }),
    ]);

    res.json({ pendingReferees, pendingRequests, upcomingMatches, totalTeams, totalPlayers, unpaidLicenses, pendingTeams, appealingTeams });
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
    const { status, division, round, season } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status   && { status }),
        ...(division && { division }),
        ...(round    && { round: parseInt(round) }),
        ...(season   && { season }),
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

// GET /supervisor/teams – všechny týmy s počtem hráčů + filtry
router.get('/teams', async (req, res, next) => {
  try {
    const { division, regStatus, payStatus } = req.query;
    const where = {};
    if (division)  where.division  = division;
    if (regStatus) where.regStatus = regStatus;
    if (payStatus) where.payments  = { status: payStatus };
    const teams = await prisma.team.findMany({
      where,
      include: {
        _count:   { select: { players: true } },
        payments: { select: { status: true, season: true, paidAt: true } },
      },
      orderBy: [{ regStatus: 'asc' }, { division: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id/approve – schválení registrace
router.put('/teams/:id/approve', async (req, res, next) => {
  try {
    const { note } = req.body; // volitelná poznámka
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'APPROVED', regNote: note || null, regAppeal: null, regAppealAt: null },
    });
    // Notifikuj vedoucí týmu
    const managers = await prisma.manager.findMany({
      where:   { teamId: team.id },
      include: { user: { select: { id: true } } },
    });
    for (const m of managers) {
      await createNotification(
        m.user.id,
        'Registrace schválena ✅',
        `Tým ${team.name} byl schválen do ligy.${note ? ` Poznámka: ${note}` : ''}`,
        'admin',
      );
    }
    res.json(team);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id/reject – zamítnutí registrace (povinný důvod)
router.put('/teams/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Důvod zamítnutí je povinný' });
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'REJECTED', regNote: reason.trim() },
    });
    const managers = await prisma.manager.findMany({
      where:   { teamId: team.id },
      include: { user: { select: { id: true } } },
    });
    for (const m of managers) {
      await createNotification(
        m.user.id,
        'Registrace zamítnuta ❌',
        `Tým ${team.name} byl zamítnut. Důvod: ${reason.trim()}`,
        'admin',
      );
    }
    res.json(team);
  } catch (err) { next(err); }
});

// POST /supervisor/teams – vytvoření týmu
router.post('/teams', async (req, res, next) => {
  try {
    const { name, abbr, division, color, venue, conference } = req.body;
    if (!name || !abbr) {
      return res.status(400).json({ error: 'Chybí název nebo zkratka týmu' });
    }
    if (abbr.length > 3) {
      return res.status(400).json({ error: 'Zkratka max 3 znaky' });
    }

    // Divize je volitelná — přiděluje se až při rozlosování. Kolizi zkratky
    // proto hlídáme jen v rámci divize, do které tým rovnou patří.
    const existing = await prisma.team.findFirst({
      where: { abbr: abbr.toUpperCase(), division: division || null },
    });
    if (existing) {
      return res.status(409).json({
        error: division
          ? `Tým se zkratkou ${abbr} už v divizi ${division} existuje`
          : `Nezařazený tým se zkratkou ${abbr} už existuje`,
      });
    }

    const team = await prisma.team.create({
      data: {
        name,
        abbr:       abbr.toUpperCase(),
        division:   division || null,
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
    // Prázdný řetězec znamená "vyřadit z divize", proto !== undefined
    if (division !== undefined) data.division = division || null;
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
      season           = null,
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
        season:      season || null,
      };
    });

    // BUG-06 OPRAVA: Zabal mazání starých a vytváření nových zápasů do DB transakce
    // Zabraňuje nekonzistentnímu stavu při selhání (např. smazáno, ale nevytvořeno)
    await prisma.$transaction(async (tx) => {
      if (deleteExisting) {
        if (Array.isArray(teamIds) && teamIds.length >= 2) {
          await tx.match.deleteMany({
            where: { status: 'UPCOMING', OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }] },
          });
        } else {
          await tx.match.deleteMany({ where: { division: matchDivision, status: 'UPCOMING' } });
        }
      }
      await tx.match.createMany({ data: matchData });
    });

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
// ==================== PŘECHOD SEZÓNY ====================
//
// Dvoukrokový, naplánovaný na datum. Provede ho sám server, ale jen když
// ve staré sezóně nezbývají neodehrané zápasy.

// GET /supervisor/season – aktuální sezóna, naplánovaný přechod a překážky
router.get('/season', async (req, res, next) => {
  try {
    const current = await seasonSvc.currentSeason();
    const [planned, blocking] = await Promise.all([
      prisma.seasonTransition.findFirst({
        where:   { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
      }),
      seasonSvc.blockingMatches(current),
    ]);
    const last = await prisma.seasonTransition.findFirst({
      where:   { status: { in: ['EXECUTED', 'FAILED'] } },
      orderBy: { executedAt: 'desc' },
    });
    const supervisors = await seasonSvc.supervisorIds();
    res.json({
      currentSeason:   current,
      planned,
      lastTransition:  last,
      blockingMatches: blocking.count,
      blockingSample:  blocking.matches,
      supervisorCount: supervisors.length,
      // Pravidlo čtyř očí: potvrzuje někdo jiný než ten, kdo plánoval.
      // Při jediném supervisorovi v lize potvrzuje sám.
      canConfirm:      await seasonSvc.canConfirm(planned, req.user.id),
      plannedByMe:     planned ? planned.createdById === req.user.id : false,
    });
  } catch (err) { next(err); }
});

// POST /supervisor/season – krok 1: naplánování (ještě neplatí, čeká na potvrzení)
router.post('/season', async (req, res, next) => {
  try {
    const { newSeason, scheduledAt } = req.body;

    if (!newSeason || !seasonSvc.SEASON_RE.test(newSeason)) {
      return res.status(400).json({ error: 'Neplatný formát sezóny – použij tvar "2026/27"' });
    }
    const kdy = new Date(scheduledAt);
    if (!scheduledAt || Number.isNaN(kdy.getTime())) {
      return res.status(400).json({ error: 'Neplatné datum přechodu' });
    }
    if (kdy.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Datum přechodu musí být v budoucnosti' });
    }

    const current = await seasonSvc.currentSeason();
    if (current === newSeason) {
      return res.status(409).json({ error: 'Tato sezóna je již aktivní' });
    }

    const existing = await prisma.seasonTransition.findFirst({
      where: { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
    });
    if (existing) {
      return res.status(409).json({ error: 'Jeden přechod už je naplánovaný. Nejdřív ho zruš.' });
    }

    const transition = await prisma.seasonTransition.create({
      data: { newSeason, scheduledAt: kdy, createdById: req.user.id },
    });

    await seasonSvc.notifySupervisors(
      'Naplánován přechod sezóny',
      `Sezóna ${newSeason} je naplánovaná na ${kdy.toLocaleDateString('cs-CZ')}. Čeká na potvrzení.`,
    );

    res.status(201).json(transition);
  } catch (err) { next(err); }
});

// PUT /supervisor/season/:id/confirm – krok 2: potvrzení opsáním názvu sezóny
router.put('/season/:id/confirm', async (req, res, next) => {
  try {
    const { confirmSeason } = req.body;

    const transition = await prisma.seasonTransition.findUnique({ where: { id: req.params.id } });
    if (!transition) return res.status(404).json({ error: 'Přechod nenalezen' });
    if (transition.status !== 'PENDING_CONFIRM') {
      return res.status(409).json({ error: 'Tenhle přechod už potvrzení nečeká' });
    }
    if (!(await seasonSvc.canConfirm(transition, req.user.id))) {
      return res.status(403).json({
        error: 'Přechod musí potvrdit jiný supervisor, než ten, který ho naplánoval.',
      });
    }
    if ((confirmSeason ?? '').trim() !== transition.newSeason) {
      return res.status(400).json({
        error: `Pro potvrzení opiš přesně název sezóny: ${transition.newSeason}`,
      });
    }

    const updated = await prisma.seasonTransition.update({
      where: { id: transition.id },
      data:  { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    await seasonSvc.notifySupervisors(
      'Přechod sezóny potvrzen',
      `Sezóna ${transition.newSeason} se spustí ${transition.scheduledAt.toLocaleDateString('cs-CZ')} automaticky.`,
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /supervisor/season/:id – zrušení naplánovaného přechodu
router.delete('/season/:id', async (req, res, next) => {
  try {
    const transition = await prisma.seasonTransition.findUnique({ where: { id: req.params.id } });
    if (!transition) return res.status(404).json({ error: 'Přechod nenalezen' });
    if (!['PENDING_CONFIRM', 'CONFIRMED'].includes(transition.status)) {
      return res.status(409).json({ error: 'Tenhle přechod už zrušit nelze' });
    }

    const updated = await prisma.seasonTransition.update({
      where: { id: transition.id },
      data:  { status: 'CANCELLED' },
    });

    await seasonSvc.notifySupervisors(
      'Přechod sezóny zrušen',
      `Naplánovaný přechod na sezónu ${transition.newSeason} byl zrušen.`,
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// ==================== SPRÁVA SUPERVISORŮ ====================

// GET /supervisor/users?q= – seznam uživatelů pro přidělení role
router.get('/users', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const users = await prisma.user.findMany({
      where: q ? {
        OR: [
          { email:  { contains: q, mode: 'insensitive' } },
          { player: { firstName: { contains: q, mode: 'insensitive' } } },
          { player: { lastName:  { contains: q, mode: 'insensitive' } } },
        ],
      } : undefined,
      select: {
        id: true, email: true, isSupervisor: true, createdAt: true,
        player:  { select: { firstName: true, lastName: true, isSupervisor: true } },
        referee: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ isSupervisor: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });
    res.json(users);
  } catch (err) { next(err); }
});

// PUT /supervisor/users/:id/supervisor – přidělení nebo odebrání role
router.put('/users/:id/supervisor', async (req, res, next) => {
  try {
    const { isSupervisor } = req.body;
    if (typeof isSupervisor !== 'boolean') {
      return res.status(400).json({ error: 'isSupervisor musí být true nebo false' });
    }

    const target = await prisma.user.findUnique({
      where:  { id: req.params.id },
      select: { id: true, email: true, isSupervisor: true },
    });
    if (!target) return res.status(404).json({ error: 'Uživatel nenalezen' });

    // Nikdo si nesmí odebrat vlastní roli — zavřel by si dveře zevnitř.
    if (!isSupervisor && target.id === req.user.id) {
      return res.status(400).json({ error: 'Vlastní roli supervisora si odebrat nemůžeš. Požádej o to jiného supervisora.' });
    }

    // A liga nesmí zůstat bez jediného supervisora.
    if (!isSupervisor) {
      const zbyva = await prisma.user.count({ where: { isSupervisor: true, id: { not: target.id } } });
      if (zbyva === 0) {
        return res.status(400).json({ error: 'Tohle je poslední supervisor, roli mu odebrat nelze.' });
      }
    }

    const user = await prisma.user.update({
      where:  { id: target.id },
      data:   { isSupervisor },
      select: { id: true, email: true, isSupervisor: true },
    });

    await createNotification(
      user.id,
      isSupervisor ? 'Máš roli supervisora' : 'Role supervisora odebrána',
      isSupervisor
        ? 'Byla ti přidělena role supervisora FSL. Ve Správě najdeš organizaci ligy.'
        : 'Tvoje role supervisora FSL byla odebrána.',
      'admin',
    );

    res.json(user);
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
