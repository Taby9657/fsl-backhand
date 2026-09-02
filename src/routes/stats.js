const express = require('express');

const { requireSupervisor } = require('../middleware/auth');

const router = express.Router();

/**
 * Filtr zápasů podle soutěžní struktury.
 *
 * Nové zápasy nesou leagueId/conferenceId/divisionId, starší jen textovou
 * divizi. Bereme obojí, ať statistiky za minulé ročníky nezmizí.
 */
function matchScope({ leagueId, conferenceId, divisionId, division, season }) {
  const where = {};
  if (divisionId)   where.divisionId   = divisionId;
  if (conferenceId) where.conferenceId = conferenceId;
  if (leagueId)     where.leagueId     = leagueId;
  if (division && !leagueId && !conferenceId && !divisionId) where.division = division;
  if (season)       where.season       = season;
  return where;
}


const prisma = require('../lib/prisma');
const { VEREJNY_HRAC } = require('../utils/verejneUdaje');
const standings = require('../services/standings');

// GET /stats/seasons – seznam dostupných ročníků
router.get('/seasons', async (req, res, next) => {
  try {
    const rows = await prisma.match.groupBy({
      by: ['season'],
      orderBy: { season: 'desc' },
    });
    res.json(rows.map(r => r.season).filter(Boolean));
  } catch (err) { next(err); }
});

// GET /stats/scorers – tabulka střelců
router.get('/scorers', async (req, res, next) => {
  try {
    const { division, season, limit = '20', leagueId, conferenceId, divisionId } = req.query;
    const matchWhere = {
      ...matchScope({ leagueId, conferenceId, divisionId, division, season }),
    };

    const goals = await prisma.matchEvent.groupBy({
      by: ['scorerId'],
      where: {
        type: 'GOAL',
        scorerId: { not: null },
        ...(Object.keys(matchWhere).length && { match: matchWhere }),
      },
      _count: { scorerId: true },
      orderBy: { _count: { scorerId: 'desc' } },
      take: parseInt(limit),
    });

    // Doplň data hráčů
    const playerIds = goals.map(g => g.scorerId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      select: { ...VEREJNY_HRAC, team: { select: { id: true, abbr: true, color: true } } },
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
    const { division, season, limit = '20', leagueId, conferenceId, divisionId } = req.query;
    const matchWhere = {
      ...matchScope({ leagueId, conferenceId, divisionId, division, season }),
    };

    const assists = await prisma.matchEvent.groupBy({
      by: ['assistId'],
      where: {
        type: 'GOAL',
        assistId: { not: null },
        ...(Object.keys(matchWhere).length && { match: matchWhere }),
      },
      _count: { assistId: true },
      orderBy: { _count: { assistId: 'desc' } },
      take: parseInt(limit),
    });

    const playerIds = assists.map(a => a.assistId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      select: { ...VEREJNY_HRAC, team: { select: { id: true, abbr: true, color: true } } },
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
    const { division, season, limit = '20', leagueId, conferenceId, divisionId } = req.query;
    const mw = matchScope({ leagueId, conferenceId, divisionId, division, season });
    const matchWhere = Object.keys(mw).length ? { match: mw } : {};

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
      select: { ...VEREJNY_HRAC, team: { select: { id: true, abbr: true, color: true } } },
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
    const { division, season, limit = '20', leagueId, conferenceId, divisionId } = req.query;
    const matchWhere = {
      ...matchScope({ leagueId, conferenceId, divisionId, division, season }),
    };

    const votes = await prisma.postmatchData.groupBy({
      by: ['opponentMvpId'],
      where: {
        opponentMvpId: { not: null },
        submitted: true,
        ...(Object.keys(matchWhere).length && { match: matchWhere }),
      },
      _count: { opponentMvpId: true },
      orderBy: { _count: { opponentMvpId: 'desc' } },
      take: parseInt(limit),
    });

    const playerIds = votes.map(v => v.opponentMvpId).filter(Boolean);
    const players = await prisma.player.findMany({
      where: { id: { in: playerIds } },
      select: { ...VEREJNY_HRAC, team: { select: { id: true, abbr: true, color: true } } },
    });
    const playerMap = Object.fromEntries(players.map(p => [p.id, p]));

    const result = votes.map(v => ({
      player: playerMap[v.opponentMvpId],
      votes:  v._count.opponentMvpId,
    })).filter(r => r.player);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/table – tabulka (výhry/remízy/prohry/skóre + forma posledních 5)
router.get('/table', async (req, res, next) => {
  try {
    let { division, season, leagueId, conferenceId, divisionId } = req.query;

    // Bez jakéhokoli zúžení vezmeme skupinu posledního odehraného zápasu,
    // ať tabulka nemíchá dohromady týmy z různých soutěží.
    if (!division && !leagueId && !conferenceId && !divisionId) {
      const first = await prisma.match.findFirst({
        where:   { status: 'DONE', ...(season && { season }) },
        select:  { division: true, divisionId: true, conferenceId: true, leagueId: true },
        orderBy: { date: 'desc' },
      });
      if (!first) return res.json([]);
      if (first.divisionId)        divisionId   = first.divisionId;
      else if (first.conferenceId) conferenceId = first.conferenceId;
      else if (first.leagueId)     leagueId     = first.leagueId;
      else                         division     = first.division;
    }

    // Výpočet žije ve services/standings.js — používá ho i nasazení do playoff,
    // aby si tabulka a pavouk nemohly odporovat.
    const table = await standings.tabulka(
      { division, season, leagueId, conferenceId, divisionId },
      { phase: 'REGULAR' },
    );
    res.json(table);
  } catch (err) { next(err); }
});

// GET /stats/referees – průměrné hodnocení rozhodčích (PostmatchData + RefRating)
router.get('/referees', async (req, res, next) => {
  try {
    const { season } = req.query;

    // Zdroj 1: PostmatchData.refRating — hodnocení od vedoucích týmů (po zápase)
    const [postmatches, fanRatings] = await Promise.all([
      prisma.postmatchData.findMany({
        where: {
          submitted: true,
          refRating: { not: null },
          match: { refereeId: { not: null }, ...(season && { season }) },
        },
        select: { refRating: true, match: { select: { refereeId: true } } },
      }),
      // Zdroj 2: RefRating — hodnocení od hráčů/fanoušků přímo v app
      prisma.refRating.findMany({
        where: {
          ...(season && { match: { season } }),
        },
        select: { refereeId: true, rating: true },
      }),
    ]);

    // Agregace obou zdrojů do jednoho průměru
    const ratingMap = {};
    for (const pm of postmatches) {
      const refId = pm.match.refereeId;
      if (!refId) continue;
      if (!ratingMap[refId]) ratingMap[refId] = { sum: 0, count: 0 };
      ratingMap[refId].sum   += pm.refRating;
      ratingMap[refId].count += 1;
    }
    for (const fr of fanRatings) {
      if (!fr.refereeId) continue;
      if (!ratingMap[fr.refereeId]) ratingMap[fr.refereeId] = { sum: 0, count: 0 };
      ratingMap[fr.refereeId].sum   += fr.rating;
      ratingMap[fr.refereeId].count += 1;
    }

    const refIds = Object.keys(ratingMap);
    if (refIds.length === 0) return res.json([]);

    const refs = await prisma.referee.findMany({
      where: { id: { in: refIds }, status: 'APPROVED' },
      select: { id: true, firstName: true, lastName: true, photoUrl: true, level: true },
    });
    const refLookup = Object.fromEntries(refs.map(r => [r.id, r]));

    const result = refIds
      .filter(id => refLookup[id])
      .map(id => ({
        referee: refLookup[id],
        avg:     Math.round((ratingMap[id].sum / ratingMap[id].count) * 10) / 10,
        count:   ratingMap[id].count,
      }))
      .sort((a, b) => b.avg - a.avg);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /stats/export?type=players|referees&division=X&season=Y
// Vrátí CSV soubor – pouze pro supervisory
router.get('/export', requireSupervisor, async (req, res, next) => {
  try {
    const { type = 'players', division, season, leagueId, conferenceId, divisionId } = req.query;
    const matchWhere = {
      ...matchScope({ leagueId, conferenceId, divisionId, division, season }),
    };

    // CSV helper — escapuj hodnoty pro Excel (ochrana proti CSV injection)
    const csvCell = (v) => {
      const s = String(v ?? '');
      // Escapuj buňky začínající speciálními znaky
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return safe.includes(',') || safe.includes('"') ? `"${safe.replace(/"/g, '""')}"` : safe;
    };

    let csv = '';

    if (type === 'referees') {
      // Export statistik rozhodčích — stejný zdroj jako GET /stats/referees (PostmatchData.refRating)
      const postmatches = await prisma.postmatchData.findMany({
        where: { refRating: { not: null }, match: { refereeId: { not: null }, ...(season && { season }) } },
        select: { refRating: true, match: { select: { refereeId: true } } },
      });
      const ratingMap = {};
      for (const pm of postmatches) {
        const refId = pm.match.refereeId;
        if (!refId) continue;
        if (!ratingMap[refId]) ratingMap[refId] = { sum: 0, count: 0 };
        ratingMap[refId].sum   += pm.refRating;
        ratingMap[refId].count += 1;
      }
      const refIds = Object.keys(ratingMap);
      const refs = await prisma.referee.findMany({
        where: { id: { in: refIds }, status: 'APPROVED' },
        select: { id: true, firstName: true, lastName: true, level: true },
      });
      const refLookup = Object.fromEntries(refs.map(r => [r.id, r]));

      csv = 'Jméno,Příjmení,Úroveň,Průměrné hodnocení,Počet hodnocení\n';
      csv += refIds
        .filter(id => refLookup[id])
        .sort((a, b) => ratingMap[b].count - ratingMap[a].count)
        .map(id => {
          const ref = refLookup[id];
          const avg = Math.round((ratingMap[id].sum / ratingMap[id].count) * 10) / 10;
          return [ref.firstName, ref.lastName, ref.level ?? '', avg, ratingMap[id].count].map(csvCell).join(',');
        })
        .join('\n');
    } else {
      // Export statistik hráčů (výchozí)
      const goals = await prisma.matchEvent.groupBy({
        by: ['scorerId'],
        where: { type: 'GOAL', scorerId: { not: null }, ...(Object.keys(matchWhere).length && { match: matchWhere }) },
        _count: { scorerId: true },
      });
      const assists = await prisma.matchEvent.groupBy({
        by: ['assistId'],
        where: { type: 'GOAL', assistId: { not: null }, ...(Object.keys(matchWhere).length && { match: matchWhere }) },
        _count: { assistId: true },
      });
      // MVP hlasy jsou v PostmatchData.opponentMvpId
      const mvpVotes = await prisma.postmatchData.groupBy({
        by: ['opponentMvpId'],
        where: {
          opponentMvpId: { not: null },
          submitted: true,
          ...(Object.keys(matchWhere).length && { match: matchWhere }),
        },
        _count: { opponentMvpId: true },
      });

      // Unify all playerIds
      const goalMap   = Object.fromEntries(goals.map(g   => [g.scorerId,        g._count.scorerId]));
      const assistMap = Object.fromEntries(assists.map(a => [a.assistId,        a._count.assistId]));
      const mvpMap    = Object.fromEntries(mvpVotes.map(m => [m.opponentMvpId, m._count.opponentMvpId]));
      const allIds    = [...new Set([...Object.keys(goalMap), ...Object.keys(assistMap), ...Object.keys(mvpMap)])];

      const players = await prisma.player.findMany({
        where: { id: { in: allIds } },
        select: { id: true, firstName: true, lastName: true, jersey: true, position: true, team: { select: { name: true, division: true } } },
      });
      players.sort((a, b) => {
        const g = (goalMap[b.id] ?? 0) - (goalMap[a.id] ?? 0);
        const pts_b = (goalMap[b.id] ?? 0) + (assistMap[b.id] ?? 0);
        const pts_a = (goalMap[a.id] ?? 0) + (assistMap[a.id] ?? 0);
        return pts_b - pts_a;
      });

      csv = 'Jméno,Příjmení,Číslo,Pozice,Tým,Divize,Góly,Asistence,Body,MVP\n';
      csv += players.map(p => [
        p.firstName,
        p.lastName,
        p.jersey ?? '',
        p.position ?? '',
        p.team?.name ?? '',
        p.team?.division ?? '',
        goalMap[p.id]   ?? 0,
        assistMap[p.id] ?? 0,
        (goalMap[p.id] ?? 0) + (assistMap[p.id] ?? 0),
        mvpMap[p.id]    ?? 0,
      ].map(csvCell).join(',')).join('\n');
    }

    const filename = `fsl-${type}-${season ?? 'all'}-${division ?? 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM pro Excel
  } catch (err) { next(err); }
});

module.exports = router;
