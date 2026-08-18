const express = require('express');

const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { createNotifications } = require('./notifications');
const { sendPush } = require('../services/push');

const router = express.Router();
const prisma = require('../lib/prisma');

// GET /matches/bracket?division=X&season=Y – play-off pavouk
router.get('/bracket', async (req, res, next) => {
  try {
    const { division, season } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        round: { not: null },
        ...(division && { division }),
        ...(season   && { season }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
      },
      orderBy: [{ round: 'asc' }, { date: 'asc' }],
    });

    // Seskup kola
    const rounds = {};
    for (const m of matches) {
      if (m.round == null) continue;
      if (!rounds[m.round]) rounds[m.round] = [];
      rounds[m.round].push(m);
    }
    res.json(rounds);
  } catch (err) { next(err); }
});

// GET /matches – seznam zápasů
router.get('/', async (req, res, next) => {
  try {
    const { status, teamId, homeTeamId, refereeId, division, season, limit = '50', offset = '0' } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status     && { status }),
        ...(division   && { division }),
        ...(season     && { season }),
        ...(refereeId  && { refereeId }),
        ...(homeTeamId && { homeTeamId }),
        ...(teamId     && { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
        _count:   { select: { events: true } },
      },
      orderBy: { date: status === 'UPCOMING' ? 'asc' : 'desc' },
      take:  parseInt(limit),
      skip:  parseInt(offset),
    });
    res.json(matches);
  } catch (err) { next(err); }
});

// GET /matches/:id – detail zápasu
router.get('/:id', async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        homeTeam: true,
        awayTeam: true,
        referee:  true,
        events: {
          include: { scorer: true, assist: true, penalty: true },
          orderBy: [{ period: 'asc' }, { minute: 'asc' }],
        },
        lineups: {
          include: { players: { include: { player: { include: { payment: true } } } } },
        },
        postmatches: { include: { opponentMvp: true } },
      },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    res.json(match);
  } catch (err) { next(err); }
});

// POST /matches – vytvoření zápasu (pouze supervisor)
router.post('/', requireSupervisor, async (req, res, next) => {
  try {
    const { homeTeamId, awayTeamId, refereeId, date, venue, competition, division, season, round } = req.body;
    if (!homeTeamId || !awayTeamId || !date) {
      return res.status(400).json({ error: 'Chybí povinné údaje (domácí, hosté, datum)' });
    }
    const match = await prisma.match.create({
      data: {
        homeTeamId,
        awayTeamId,
        refereeId:   refereeId || null,
        date:        new Date(date),
        venue:       venue || null,
        competition: competition || 'FSL Liga',
        division:    division   || 'Divize A',
        season:      season     || null,
        round:       round      ? parseInt(round) : null,
      },
      include: { homeTeam: true, awayTeam: true, referee: true },
    });
    res.status(201).json(match);
  } catch (err) { next(err); }
});

// PUT /matches/:id – úprava zápasu (supervisor)
router.put('/:id', requireSupervisor, async (req, res, next) => {
  try {
    const { refereeId, date, venue, status, homeScore, awayScore,
            homeTeamId, awayTeamId, round, division, competition, season } = req.body;
    const match = await prisma.match.update({
      where: { id: req.params.id },
      data: {
        ...(refereeId    !== undefined && { refereeId: refereeId || null }),
        ...(date         && { date: new Date(date) }),
        ...(venue        !== undefined && { venue: venue || null }),
        ...(status       && { status }),
        ...(homeScore    !== undefined && { homeScore: parseInt(homeScore) }),
        ...(awayScore    !== undefined && { awayScore: parseInt(awayScore) }),
        ...(homeTeamId   && { homeTeamId }),
        ...(awayTeamId   && { awayTeamId }),
        ...(round        !== undefined && { round: round ? parseInt(round) : null }),
        ...(division     && { division }),
        ...(competition  && { competition }),
        ...(season       && { season }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
        referee:  { select: { id: true, firstName: true, lastName: true } },
      },
    });
    res.json(match);
  } catch (err) { next(err); }
});

// POST /matches/:id/start – rozhodčí zahájí zápas (UPCOMING → LIVE)
router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: { homeTeam: true, awayTeam: true },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'UPCOMING') return res.status(400).json({ error: 'Zápas musí být ve stavu UPCOMING' });
    const referee = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee = referee && match.refereeId === referee.id;
    const isSup = req.user?.player?.isSupervisor || process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isReferee && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });

    // Kontrola soupisek – obě musí mít min. 9 hráčů (8 hráčů v poli + 1 brankář)
    const MIN_PLAYERS = 9;
    const lineups = await prisma.lineupSubmission.findMany({
      where:   { matchId: req.params.id },
      include: { players: { select: { isGoalkeeper: true } } },
    });
    const homeLineup = lineups.find(l => l.teamId === match.homeTeamId);
    const awayLineup = lineups.find(l => l.teamId === match.awayTeamId);
    const homeCnt    = homeLineup?.players?.length ?? 0;
    const awayCnt    = awayLineup?.players?.length ?? 0;
    const homeHasGK  = homeLineup?.players?.some(p => p.isGoalkeeper) ?? false;
    const awayHasGK  = awayLineup?.players?.some(p => p.isGoalkeeper) ?? false;
    const errors = [];
    if (homeCnt < MIN_PLAYERS) errors.push(`${match.homeTeam.abbr}: min. ${MIN_PLAYERS} hráčů (má ${homeCnt})`);
    if (awayCnt < MIN_PLAYERS) errors.push(`${match.awayTeam.abbr}: min. ${MIN_PLAYERS} hráčů (má ${awayCnt})`);
    if (!homeHasGK) errors.push(`${match.homeTeam.abbr}: chybí brankář`);
    if (!awayHasGK) errors.push(`${match.awayTeam.abbr}: chybí brankář`);
    if (errors.length > 0) {
      return res.status(400).json({
        error: `Nelze zahájit zápas – ${errors.join('; ')}.`,
        code:  'LINEUP_INCOMPLETE',
      });
    }

    const updated = await prisma.match.update({
      where: { id: req.params.id },
      data:  { status: 'LIVE' },
    });

    // Push notifikace hráčům obou týmů
    try {
      const players = await prisma.player.findMany({
        where:  { teamId: { in: [match.homeTeamId, match.awayTeamId] } },
        select: { user: { select: { pushToken: true } } },
      });
      const tokens = players.map(p => p.user?.pushToken).filter(Boolean);
      await sendPush(
        tokens,
        '⚡ Zápas právě začal!',
        `${match.homeTeam.abbr} vs ${match.awayTeam.abbr} · sleduj živé skóre`,
        { screen: `match/${match.id}` }
      );
    } catch { /* push je nepovinný */ }

    res.json(updated);
  } catch (err) { next(err); }
});

// POST /matches/:id/end – rozhodčí ukončí zápas (LIVE → DONE)
router.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'LIVE') return res.status(400).json({ error: 'Zápas musí být ve stavu LIVE' });
    const referee = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee = referee && match.refereeId === referee.id;
    const isSup = req.user?.player?.isSupervisor || process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isReferee && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const updated = await prisma.match.update({
      where: { id: req.params.id },
      data:  { status: 'DONE' },
      include: { homeTeam: true, awayTeam: true },
    });

    // Notifikace oběma vedoucím
    const managerIds = await prisma.manager.findMany({
      where: { teamId: { in: [match.homeTeamId, match.awayTeamId] } },
      select: { userId: true },
    });
    await createNotifications(managerIds.map(m => ({
      userId: m.userId,
      title:  'Zápas ukončen',
      body:   `${updated.homeTeam.abbr} ${updated.homeScore}:${updated.awayScore} ${updated.awayTeam.abbr} – vyplňte prosím postmatch formulář`,
      screen: 'postmatch',
    })));

    res.json(updated);
  } catch (err) { next(err); }
});

// ==================== UDÁLOSTI (GÓLY, TRESTY) ====================

// POST /matches/:id/events – přidání události (gól/trest – vedoucí nebo supervisor)
router.post('/:id/events', requireAuth, async (req, res, next) => {
  try {
    const { type, minute, period, teamId, scorerId, assistId, penaltyId, penaltyType } = req.body;
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });

    // BUG-08: Lze přidávat události pouze do LIVE zápasů
    if (match.status !== 'LIVE') {
      return res.status(400).json({ error: 'Události lze přidávat pouze do probíhajícího (LIVE) zápasu' });
    }

    const isManager    = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    const referee      = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee    = referee && match.refereeId === referee.id;
    if (!isManager && !isSupervisor && !isReferee) return res.status(403).json({ error: 'Nemáte oprávnění' });

    // Validace event type
    const VALID_TYPES = ['GOAL', 'PENALTY', 'SHOOTOUT_GOAL', 'SHOOTOUT_MISS', 'PERIOD_END', 'MATCH_END'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `Neplatný typ události. Povolené: ${VALID_TYPES.join(', ')}` });
    }
    // teamId povinné pro gól
    if ((type === 'GOAL' || type === 'SHOOTOUT_GOAL') && !teamId) {
      return res.status(400).json({ error: 'teamId je povinné pro gól' });
    }
    // Validace minuty
    const minuteParsed = parseInt(minute);
    if (isNaN(minuteParsed) || minuteParsed < 0 || minuteParsed > 200) {
      return res.status(400).json({ error: 'Neplatná minuta zápasu' });
    }

    const event = await prisma.matchEvent.create({
      data: {
        matchId: req.params.id,
        type,
        minute:      minuteParsed,
        period:      parseInt(period) || 1,
        teamId:      teamId    || null,
        scorerId:    scorerId  || null,
        assistId:    assistId  || null,
        penaltyId:   penaltyId || null,
        penaltyType: penaltyType || null,
      },
      include: { scorer: true, assist: true, penalty: true },
    });

    // Aktualizuj skóre při gólu
    if (type === 'GOAL' || type === 'SHOOTOUT_GOAL') {
      const isHome = teamId === match.homeTeamId;
      await prisma.match.update({
        where: { id: req.params.id },
        data: isHome
          ? { homeScore: { increment: 1 } }
          : { awayScore: { increment: 1 } },
      });
    }

    res.status(201).json(event);
  } catch (err) { next(err); }
});

// DELETE /matches/:id/events/:eventId – smazání události
router.delete('/:id/events/:eventId', requireAuth, async (req, res, next) => {
  try {
    const event = await prisma.matchEvent.findUnique({ where: { id: req.params.eventId } });
    if (!event || event.matchId !== req.params.id) return res.status(404).json({ error: 'Událost nenalezena' });

    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'LIVE') return res.status(400).json({ error: 'Události lze mazat pouze v probíhajícím zápasu' });
    const isManager    = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    const referee2     = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee2   = referee2 && match.refereeId === referee2.id;
    if (!isManager && !isSupervisor && !isReferee2) return res.status(403).json({ error: 'Nemáte oprávnění' });

    await prisma.matchEvent.delete({ where: { id: req.params.eventId } });

    // Reverzní update skóre — BUG-07: chráníme před záporným skóre
    if (event.type === 'GOAL' || event.type === 'SHOOTOUT_GOAL') {
      const isHome = event.teamId === match.homeTeamId;
      const currentScore = isHome ? match.homeScore : match.awayScore;
      if (currentScore > 0) {
        await prisma.match.update({
          where: { id: req.params.id },
          data: isHome
            ? { homeScore: { decrement: 1 } }
            : { awayScore: { decrement: 1 } },
        });
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SOUPISKY ====================

// PUT /matches/:id/lineup/:teamId – odeslání soupisk
router.put('/:id/lineup/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { players, force } = req.body; // force=true přeskočí kontrolu licencí
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    // ── Kontrola stavu zápasu ──
    const matchCheck = await prisma.match.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!matchCheck) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (['LIVE', 'DONE'].includes(matchCheck.status)) {
      return res.status(400).json({ error: 'Zápas již probíhá nebo skončil – soupisku nelze měnit' });
    }

    // ── Kontrola licencí ──
    if (!force) {
      const playerIds = players.map(p => p.playerId);
      const payments = await prisma.playerPayment.findMany({
        where: { playerId: { in: playerIds } },
        select: { playerId: true, licStatus: true },
      });
      const unlicensedIds = playerIds.filter(id => {
        const pay = payments.find(p => p.playerId === id);
        return !pay || !['PAID', 'WAIVED'].includes(pay.licStatus);
      });
      if (unlicensedIds.length > 0) {
        const details = await prisma.player.findMany({
          where: { id: { in: unlicensedIds } },
          select: { id: true, firstName: true, lastName: true, jersey: true },
        });
        return res.status(422).json({
          error: 'Soupiska obsahuje hráče bez platné licence',
          code: 'UNLICENSED_PLAYERS',
          unlicensed: details,
        });
      }
    }

    const lineup = await prisma.lineupSubmission.upsert({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      create: {
        matchId: req.params.id,
        teamId:  req.params.teamId,
        players: { create: players },
      },
      update: {
        confirmed: false,
        players: {
          deleteMany: {},
          create: players,
        },
      },
      include: { players: { include: { player: true } } },
    });
    res.json(lineup);
  } catch (err) { next(err); }
});

// POST /matches/:id/lineup/:teamId/confirm – potvrzení soupisky
router.post('/:id/lineup/:teamId/confirm', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const lineup = await prisma.lineupSubmission.update({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      data:  { confirmed: true },
    });
    res.json(lineup);
  } catch (err) { next(err); }
});

// ==================== POSTMATCH ====================

// PUT /matches/:id/postmatch/:teamId – odevzdání po-zápasového formuláře
router.put('/:id/postmatch/:teamId', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const { refRating, refNote, opponentMvpId, actionVideoUrl, actionDesc } = req.body;
    const postmatch = await prisma.postmatchData.upsert({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      create: {
        matchId: req.params.id,
        teamId:  req.params.teamId,
        refRating:      refRating      ? parseInt(refRating) : null,
        refNote:        refNote        || null,
        opponentMvpId:  opponentMvpId  || null,
        actionVideoUrl: actionVideoUrl || null,
        actionDesc:     actionDesc     || null,
      },
      update: {
        ...(refRating      !== undefined && { refRating: parseInt(refRating) }),
        ...(refNote        !== undefined && { refNote }),
        ...(opponentMvpId  !== undefined && { opponentMvpId }),
        ...(actionVideoUrl !== undefined && { actionVideoUrl }),
        ...(actionDesc     !== undefined && { actionDesc }),
      },
      include: { opponentMvp: true },
    });
    res.json(postmatch);
  } catch (err) { next(err); }
});

// POST /matches/:id/postmatch/:teamId/submit – finální odeslání (uzamkne)
router.post('/:id/postmatch/:teamId/submit', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const matchForSubmit = await prisma.match.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!matchForSubmit) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (matchForSubmit.status !== 'DONE') {
      return res.status(400).json({ error: 'Postmatch formulář lze uzamknout pouze po skončení zápasu' });
    }

    const postmatch = await prisma.postmatchData.update({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      data:  { submitted: true, submittedAt: new Date() },
    });
    res.json(postmatch);
  } catch (err) { next(err); }
});

module.exports = router;
