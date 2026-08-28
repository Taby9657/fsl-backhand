/**
 * Soutěžní struktura: liga → konference → divize.
 *
 * Čtení je veřejné (potřebuje ho tabulka i statistiky), zápis smí jen
 * supervisor. Hloubka je volitelná — liga bez konferencí je platný stav,
 * stejně jako konference bez divizí.
 */

const express = require('express');
const { requireSupervisor } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

const MAX_LIG_V_SEZONE   = 10;
const MAX_KONFERENCI     = 2;
const MAX_DIVIZI         = 2;

const seasonSvc = require('../services/seasonTransition');

/** Aktuální sezóna z nastavení ligy. */
async function aktualniSezona() {
  return (await seasonSvc.currentSeason()) ?? '2025/26';
}

const stromInclude = {
  conferences: {
    orderBy: { name: 'asc' },
    include: { divisions: { orderBy: { name: 'asc' } } },
  },
};

// ==================== ČTENÍ (veřejné) ====================

// GET /leagues?season=2025/26 – celý strom soutěží pro sezónu
router.get('/', async (req, res, next) => {
  try {
    const season = req.query.season || await aktualniSezona();

    const leagues = await prisma.league.findMany({
      where:   { season },
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
      include: stromInclude,
    });

    // Počty týmů dopočítáme jedním dotazem, ať se nešahá do DB v cyklu
    const zarazeni = await prisma.teamSeason.groupBy({
      by:     ['leagueId', 'conferenceId', 'divisionId'],
      where:  { season },
      _count: { teamId: true },
    });

    const pocet = (fn) => zarazeni.filter(fn).reduce((a, z) => a + z._count.teamId, 0);

    res.json({
      season,
      leagues: leagues.map(l => ({
        ...l,
        teamCount: pocet(z => z.leagueId === l.id),
        conferences: l.conferences.map(k => ({
          ...k,
          teamCount: pocet(z => z.conferenceId === k.id),
          divisions: k.divisions.map(d => ({
            ...d,
            teamCount: pocet(z => z.divisionId === d.id),
          })),
        })),
      })),
    });
  } catch (err) { next(err); }
});

// GET /leagues/teams?season=2025/26 – týmy se zařazením, včetně nezařazených
router.get('/teams', async (req, res, next) => {
  try {
    const season = req.query.season || await aktualniSezona();

    // Jen týmy přihlášené do téhle sezóny — tým bez přihlášky do soutěže nepatří
    const prihlasky = await prisma.teamSeason.findMany({
      where: { season },
      include: {
        team: {
          select: {
            id: true, name: true, abbr: true, color: true, regStatus: true,
            _count: { select: { players: true } },
          },
        },
        league:     { select: { id: true, name: true } },
        conference: { select: { id: true, name: true } },
        division:   { select: { id: true, name: true } },
      },
    });

    const teams = prihlasky
      .map(p => ({
        ...p.team,
        placement: p.leagueId
          ? {
            leagueId: p.leagueId, conferenceId: p.conferenceId, divisionId: p.divisionId,
            league: p.league, conference: p.conference, division: p.division,
          }
          : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ season, teams });
  } catch (err) { next(err); }
});

// ==================== ZÁPIS (jen supervisor) ====================

router.use(requireSupervisor);

// POST /leagues – nová liga v sezóně
router.post('/', async (req, res, next) => {
  try {
    const { name, level, season: sezonaZTela } = req.body;
    const season = sezonaZTela || await aktualniSezona();

    if (!name?.trim()) return res.status(400).json({ error: 'Zadej název ligy' });

    const pocet = await prisma.league.count({ where: { season } });
    if (pocet >= MAX_LIG_V_SEZONE) {
      return res.status(409).json({ error: `V jedné sezóně může být nejvýš ${MAX_LIG_V_SEZONE} lig` });
    }

    const existuje = await prisma.league.findFirst({ where: { season, name: name.trim() } });
    if (existuje) return res.status(409).json({ error: 'Liga s tímhle názvem už v sezóně je' });

    const league = await prisma.league.create({
      data: {
        season,
        name:  name.trim(),
        level: Number.isInteger(level) ? level : pocet + 1,
      },
      include: stromInclude,
    });
    res.status(201).json(league);
  } catch (err) { next(err); }
});

// PUT /leagues/:id – přejmenování nebo změna úrovně
router.put('/:id', async (req, res, next) => {
  try {
    const { name, level } = req.body;
    const data = {};
    if (name?.trim())          data.name  = name.trim();
    if (Number.isInteger(level)) data.level = level;

    const league = await prisma.league.update({
      where: { id: req.params.id },
      data,
      include: stromInclude,
    });
    res.json(league);
  } catch (err) { next(err); }
});

// DELETE /leagues/:id – smazat lze jen prázdnou ligu
router.delete('/:id', async (req, res, next) => {
  try {
    const obsazeno = await prisma.teamSeason.count({ where: { leagueId: req.params.id } });
    if (obsazeno > 0) {
      return res.status(409).json({
        error: `V lize je ${obsazeno} týmů. Nejdřív je přeřaď jinam.`,
      });
    }
    await prisma.league.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /leagues/:id/conferences – nová konference
router.post('/:id/conferences', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Zadej název konference' });

    const pocet = await prisma.conference.count({ where: { leagueId: req.params.id } });
    if (pocet >= MAX_KONFERENCI) {
      return res.status(409).json({ error: `Liga může mít nejvýš ${MAX_KONFERENCI} konference` });
    }

    const conference = await prisma.conference.create({
      data:    { leagueId: req.params.id, name: name.trim() },
      include: { divisions: true },
    });
    res.status(201).json(conference);
  } catch (err) { next(err); }
});

// PUT /leagues/conferences/:id – přejmenování
router.put('/conferences/:id', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Zadej název konference' });
    const conference = await prisma.conference.update({
      where: { id: req.params.id },
      data:  { name: name.trim() },
      include: { divisions: true },
    });
    res.json(conference);
  } catch (err) { next(err); }
});

// DELETE /leagues/conferences/:id
router.delete('/conferences/:id', async (req, res, next) => {
  try {
    const obsazeno = await prisma.teamSeason.count({ where: { conferenceId: req.params.id } });
    if (obsazeno > 0) {
      return res.status(409).json({ error: `V konferenci je ${obsazeno} týmů. Nejdřív je přeřaď jinam.` });
    }
    await prisma.conference.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /leagues/conferences/:id/divisions – nová divize
router.post('/conferences/:id/divisions', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Zadej název divize' });

    const pocet = await prisma.division.count({ where: { conferenceId: req.params.id } });
    if (pocet >= MAX_DIVIZI) {
      return res.status(409).json({ error: `Konference může mít nejvýš ${MAX_DIVIZI} divize` });
    }

    const division = await prisma.division.create({
      data: { conferenceId: req.params.id, name: name.trim() },
    });
    res.status(201).json(division);
  } catch (err) { next(err); }
});

// PUT /leagues/divisions/:id – přejmenování
router.put('/divisions/:id', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Zadej název divize' });
    const division = await prisma.division.update({
      where: { id: req.params.id },
      data:  { name: name.trim() },
    });
    res.json(division);
  } catch (err) { next(err); }
});

// DELETE /leagues/divisions/:id
router.delete('/divisions/:id', async (req, res, next) => {
  try {
    const obsazeno = await prisma.teamSeason.count({ where: { divisionId: req.params.id } });
    if (obsazeno > 0) {
      return res.status(409).json({ error: `V divizi je ${obsazeno} týmů. Nejdřív je přeřaď jinam.` });
    }
    await prisma.division.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== ZAŘAZENÍ TÝMU ====================

// PUT /leagues/placement/:teamId – zařadit tým, nebo ho vyřadit (leagueId: null)
router.put('/placement/:teamId', async (req, res, next) => {
  try {
    const { leagueId, conferenceId, divisionId, season: sezonaZTela } = req.body;
    const season = sezonaZTela || await aktualniSezona();

    const team = await prisma.team.findUnique({ where: { id: req.params.teamId } });
    if (!team) return res.status(404).json({ error: 'Tým nenalezen' });

    // Vyřazení z ligy — přihláška do sezóny zůstává, jen se zruší zařazení.
    // Smazat celou přihlášku by tým ze sezóny odhlásilo, což je jiná akce.
    if (!leagueId) {
      await prisma.teamSeason.upsert({
        where:  { teamId_season: { teamId: team.id, season } },
        create: { teamId: team.id, season },
        update: { leagueId: null, conferenceId: null, divisionId: null },
      });
      return res.json({ ok: true, placement: null });
    }

    const league = await prisma.league.findUnique({ where: { id: leagueId } });
    if (!league)               return res.status(404).json({ error: 'Liga nenalezena' });
    if (league.season !== season) {
      return res.status(400).json({ error: 'Liga patří do jiné sezóny' });
    }

    // Konference i divize musí sedět do stromu, jinak by vznikla nesmyslná kombinace
    if (conferenceId) {
      const conf = await prisma.conference.findUnique({ where: { id: conferenceId } });
      if (!conf || conf.leagueId !== leagueId) {
        return res.status(400).json({ error: 'Konference nepatří do téhle ligy' });
      }
    }
    if (divisionId) {
      if (!conferenceId) return res.status(400).json({ error: 'Divizi lze zvolit jen spolu s konferencí' });
      const div = await prisma.division.findUnique({ where: { id: divisionId } });
      if (!div || div.conferenceId !== conferenceId) {
        return res.status(400).json({ error: 'Divize nepatří do téhle konference' });
      }
    }

    const placement = await prisma.teamSeason.upsert({
      where:  { teamId_season: { teamId: team.id, season } },
      create: { teamId: team.id, season, leagueId, conferenceId: conferenceId || null, divisionId: divisionId || null },
      update: { leagueId, conferenceId: conferenceId || null, divisionId: divisionId || null },
      include: {
        league:     { select: { id: true, name: true } },
        conference: { select: { id: true, name: true } },
        division:   { select: { id: true, name: true } },
      },
    });

    res.json({ ok: true, placement });
  } catch (err) { next(err); }
});

module.exports = router;
