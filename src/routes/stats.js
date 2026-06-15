const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// GET /stats/scorers – tabulka střelců
router.get('/scorers', async (req, res, next) => {
  try {
    const { division, season, limit = '20' } = req.query;

    const goals = await prisma.matchEvent.groupBy({
      by: ['scorerId'],
      where: {
        type: 'GOAL',
        scorerId: { not: null },
        ...(division && { match: { division } }),
      },
      _count: { scorerId: true },
      orderBy: { _count: { scorerId: 'desc' } },
      take: parseInt(limit),
    });

    // Doplň data hráčů
    const playerIds = goals.map(g => g.scorerId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      include: { team: { select: { id: true, abbr: true, color: true } } },
    });
    const playerMap = Object.fromEntries(players.map(p => [p.id, p]));

    const result = goals.map(g => ({
      player: playerMap[g.scorerId],
      goals:  g._count.scorerId,
    })).filter(r => r.player);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/assisters – tabulka nahrávačů
router.get('/assisters', async (req, res, next) => {
  try {
    const { division, limit = '20' } = req.query;

    const assists = await prisma.matchEvent.groupBy({
      by: ['assistId'],
      where: {
        type: 'GOAL',
        assistId: { not: null },
        ...(division && { match: { division } }),
      },
      _count: { assistId: true },
      orderBy: { _count: { assistId: 'desc' } },
      take: parseInt(limit),
    });

    const playerIds = assists.map(a => a.assistId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      include: { team: { select: { id: true, abbr: true, color: true } } },
    });
    const playerMap = Object.fromEntries(players.map(p => [p.id, p]));

    const result = assists.map(a => ({
      player:  playerMap[a.assistId],
      assists: a._count.assistId,
    })).filter(r => r.player);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/points – kombinovaná tabulka (góly + asistence)
router.get('/points', async (req, res, next) => {
  try {
    const { division, limit = '20' } = req.query;

    const matchWhere = division ? { match: { division } } : {};

    const [goals, assists] = await Promise.all([
      prisma.matchEvent.groupBy({
        by: ['scorerId'],
        where: { type: 'GOAL', scorerId: { not: null }, ...matchWhere },
        _count: { scorerId: true },
      }),
      prisma.matchEvent.groupBy({
        by: ['assistId'],
        where: { type: 'GOAL', assistId: { not: null }, ...matchWhere },
        _count: { assistId: true },
      }),
    ]);

    const pointsMap = {};
    goals.forEach(g => {
      if (!g.scorerId) return;
      pointsMap[g.scorerId] = pointsMap[g.scorerId] || { goals: 0, assists: 0 };
      pointsMap[g.scorerId].goals = g._count.scorerId;
    });
    assists.forEach(a => {
      if (!a.assistId) return;
      pointsMap[a.assistId] = pointsMap[a.assistId] || { goals: 0, assists: 0 };
      pointsMap[a.assistId].assists = a._count.assistId;
    });

    const allIds = Object.keys(pointsMap);
    const players = await prisma.player.findMany({
      where: { id: { in: allIds } },
      include: { team: { select: { id: true, abbr: true, color: true } } },
    });

    const result = players
      .map(p => ({
        player:  p,
        goals:   pointsMap[p.id]?.goals   || 0,
        assists: pointsMap[p.id]?.assists  || 0,
        points:  (pointsMap[p.id]?.goals   || 0) + (pointsMap[p.id]?.assists || 0),
      }))
      .sort((a, b) => b.points - a.points || b.goals - a.goals)
      .slice(0, parseInt(limit));

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/mvp – tabulka MVP (počet hlasování od soupeřů)
router.get('/mvp', async (req, res, next) => {
  try {
    const { division, limit = '20' } = req.query;

    const votes = await prisma.postmatchData.groupBy({
      by: ['opponentMvpId'],
      where: {
        opponentMvpId: { not: null },
        submitted: true,
        ...(division && { match: { division } }),
      },
      _count: { opponentMvpId: true },
      orderBy: { _count: { opponentMvpId: 'desc' } },
      take: parseInt(limit),
    });

    const playerIds = votes.map(v => v.opponentMvpId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      include: { team: { select: { id: true, abbr: true, color: true } } },
    });
    const playerMap = Object.fromEntries(players.map(p => [p.id, p]));

    const result = votes.map(v => ({
      player: playerMap[v.opponentMvpId],
      votes:  v._count.opponentMvpId,
    })).filter(r => r.player);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/table – tabulka (výhry/remízy/prohry/skóre)
router.get('/table', async (req, res, next) => {
  try {
    const { division = 'Divize A' } = req.query;

    const matches = await prisma.match.findMany({
      where: { division, status: 'DONE' },
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true },
    });

    const tableMap = {};
    function getEntry(teamId) {
      if (!tableMap[teamId]) tableMap[teamId] = { teamId, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
      return tableMap[teamId];
    }

    matches.forEach(m => {
      const h = getEntry(m.homeTeamId);
      const a = getEntry(m.awayTeamId);
      h.p++; a.p++;
      h.gf += m.homeScore; h.ga += m.awayScore;
      a.gf += m.awayScore; a.ga += m.homeScore;
      if (m.homeScore > m.awayScore) { h.w++; h.pts += 3; a.l++; }
      else if (m.homeScore < m.awayScore) { a.w++; a.pts += 3; h.l++; }
      else { h.d++; h.pts += 1; a.d++; a.pts += 1; }
    });

    const teamIds = Object.keys(tableMap);
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true, abbr: true, color: true, logoUrl: true },
    });
    const teamLookup = Object.fromEntries(teams.map(t => [t.id, t]));

    const table = Object.values(tableMap)
      .map(r => ({ ...r, team: teamLookup[r.teamId], gd: r.gf - r.ga }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);

    res.json(table);
  } catch (err) { next(err); }
});

// GET /stats/referees – průměrné hodnocení rozhodčích
router.get('/referees', async (req, res, next) => {
  try {
    const ratings = await prisma.refRating.groupBy({
      by: ['refereeId'],
      _avg: { rating: true },
      _count: { rating: true },
    });

    const refIds = ratings.map(r => r.refereeId);
    const refs = await prisma.referee.findMany({
      where: { id: { in: refIds }, status: 'APPROVED' },
      select: { id: true, firstName: true, lastName: true, photoUrl: true, level: true },
    });
    const refLookup = Object.fromEntries(refs.map(r => [r.id, r]));

    const result = ratings
      .filter(r => refLookup[r.refereeId])
      .map(r => ({
        referee: refLookup[r.refereeId],
        avg:     Math.round(r._avg.rating * 10) / 10,
        count:   r._count.rating,
      }))
      .sort((a, b) => b.avg - a.avg);

    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
