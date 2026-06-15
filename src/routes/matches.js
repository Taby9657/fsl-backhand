const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireSupervisor } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /matches – seznam zápasů
router.get('/', async (req, res, next) => {
  try {
    const { status, teamId, refereeId, division, limit = '50', offset = '0' } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status    && { status }),
        ...(division  && { division }),
        ...(refereeId && { refereeId }),
        ...(teamId    && { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
        _count:   { select: { events: true } },
      },
      orderBy: { date: 'desc' },
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
          include: { players: { include: { player: true } } },
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
    const { homeTeamId, awayTeamId, refereeId, date, venue, competition, division, round } = req.body;
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
    const { refereeId, date, venue, status, homeScore, awayScore } = req.body;
    const match = await prisma.match.update({
      where: { id: req.params.id },
      data: {
        ...(refereeId  !== undefined && { refereeId }),
        ...(date       && { date: new Date(date) }),
        ...(venue      && { venue }),
        ...(status     && { status }),
        ...(homeScore  !== undefined && { homeScore: parseInt(homeScore) }),
        ...(awayScore  !== undefined && { awayScore: parseInt(awayScore) }),
      },
    });
    res.json(match);
  } catch (err) { next(err); }
});

// ==================== UDÁLOSTI (GÓLY, TRESTY) ====================

// POST /matches/:id/events – přidání události (gól/trest – vedoucí nebo supervisor)
router.post('/:id/events', requireAuth, async (req, res, next) => {
  try {
    const { type, minute, period, teamId, scorerId, assistId, penaltyId, penaltyType } = req.body;
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });

    const isManager   = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isManager && !isSupervisor) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const event = await prisma.matchEvent.create({
      data: {
        matchId: req.params.id,
        type,
        minute:      parseInt(minute),
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
    const isManager   = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isManager && !isSupervisor) return res.status(403).json({ error: 'Nemáte oprávnění' });

    await prisma.matchEvent.delete({ where: { id: req.params.eventId } });

    // Reverzní update skóre
    if (event.type === 'GOAL' || event.type === 'SHOOTOUT_GOAL') {
      const isHome = event.teamId === match.homeTeamId;
      await prisma.match.update({
        where: { id: req.params.id },
        data: isHome
          ? { homeScore: { decrement: 1 } }
          : { awayScore: { decrement: 1 } },
      });
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SOUPISKY ====================

// PUT /matches/:id/lineup/:teamId – odeslání soupisk
router.put('/:id/lineup/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { players } = req.body; // [{ playerId, isGoalkeeper, isCaptain, jerseyOverride }]
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

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

    const postmatch = await prisma.postmatchData.update({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      data:  { submitted: true, submittedAt: new Date() },
    });
    res.json(postmatch);
  } catch (err) { next(err); }
});

module.exports = router;
