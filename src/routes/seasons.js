/**
 * Sezóny: která je aktuální a jaké jdou vybrat.
 *
 * Aktuální sezóna se dřív odvozovala ze sezóny posledního založeného zápasu,
 * takže ji fakticky určovala testovací data a přepnout se dala jen přechodem
 * sezóny — ten ale resetuje platby. Nastavení je proto oddělené: přepnutí
 * sezóny nic neresetuje, na to je pořád přechod sezóny.
 */

const express = require('express');
const { requireAuth, requireSupervisor, isSupervisorUser } = require('../middleware/auth');
const prisma    = require('../lib/prisma');
const seasonSvc = require('../services/seasonTransition');

const router = express.Router();

/** Sezóny, ze kterých jde vybírat: aktuální, následující a všechny už použité. */
async function nabidkaSezon() {
  const current = await seasonSvc.currentSeason();

  const zZapasu = await prisma.match.findMany({
    distinct: ['season'], select: { season: true },
  });
  const zPrihlasek = await prisma.teamSeason.findMany({
    distinct: ['season'], select: { season: true },
  });

  const vsechny = new Set([
    ...zZapasu.map(m => m.season),
    ...zPrihlasek.map(t => t.season),
    current,
    seasonSvc.nextSeason(current),
  ].filter(Boolean));

  return {
    current,
    next: seasonSvc.nextSeason(current),
    options: [...vsechny].sort().reverse(),
  };
}

// GET /seasons – veřejné čtení, potřebuje ho i registrace týmu
router.get('/', async (req, res, next) => {
  try {
    res.json(await nabidkaSezon());
  } catch (err) { next(err); }
});

// PUT /seasons/current – supervisor přepne aktuální sezónu
router.put('/current', requireSupervisor, async (req, res, next) => {
  try {
    const { season, confirm } = req.body;

    if (!seasonSvc.SEASON_RE.test(season ?? '')) {
      return res.status(400).json({ error: 'Sezóna musí být ve tvaru 2026/27' });
    }
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Přepnutí sezóny je potřeba potvrdit',
        code:  'CONFIRM_REQUIRED',
      });
    }

    const stara = await seasonSvc.currentSeason();
    if (stara === season) {
      return res.json({ ok: true, unchanged: true, current: season });
    }

    await seasonSvc.setCurrentSeason(season);

    // Ostatní supervisoři se to musí dozvědět — mění to, co vidí celá liga
    await seasonSvc.notifySupervisors(
      'Změna aktuální sezóny',
      `Aktuální sezóna byla přepnuta z ${stara ?? '—'} na ${season}. `
      + 'Platby ani licence se tím nemění.',
    );

    res.json({ ok: true, previous: stara, current: season });
  } catch (err) { next(err); }
});

// GET /seasons/teams?season= – kdo je přihlášený a kdo z minula chybí
router.get('/teams', requireAuth, async (req, res, next) => {
  try {
    if (!isSupervisorUser(req.user)) {
      return res.status(403).json({ error: 'Přístup pouze pro supervisory' });
    }
    const season = req.query.season || await seasonSvc.currentSeason();

    const prihlasky = await prisma.teamSeason.findMany({
      where:   { season },
      include: { team: { select: { id: true, name: true, abbr: true, color: true, regStatus: true } } },
    });
    const prihlaseneIds = prihlasky.map(p => p.teamId);

    // Týmy, které někdy hrály, ale do téhle sezóny přihlášku nemají
    const drive = await prisma.teamSeason.findMany({
      where:    { season: { not: season }, teamId: { notIn: prihlaseneIds } },
      distinct: ['teamId'],
      include:  { team: { select: { id: true, name: true, abbr: true, color: true, regStatus: true } } },
      orderBy:  { season: 'desc' },
    });

    res.json({
      season,
      registered: prihlasky.map(p => ({ ...p.team, placed: !!p.leagueId })),
      missing:    drive.map(p => ({ ...p.team, lastSeason: p.season })),
    });
  } catch (err) { next(err); }
});

// POST /seasons/teams – přihlášení týmů do sezóny
router.post('/teams', requireSupervisor, async (req, res, next) => {
  try {
    const season = req.body.season || await seasonSvc.currentSeason();
    const { teamIds } = req.body;

    if (!Array.isArray(teamIds) || teamIds.length === 0) {
      return res.status(400).json({ error: 'Zadej teamIds' });
    }
    if (!seasonSvc.SEASON_RE.test(season ?? '')) {
      return res.status(400).json({ error: 'Sezóna musí být ve tvaru 2026/27' });
    }

    let pridano = 0;
    for (const teamId of teamIds) {
      const uz = await prisma.teamSeason.findUnique({
        where: { teamId_season: { teamId, season } },
      });
      if (uz) continue;
      // Přihláška bez ligy — zařazení dělá supervisor až při rozlosování
      await prisma.teamSeason.create({ data: { teamId, season } });
      pridano += 1;
    }

    res.status(201).json({ ok: true, added: pridano, season });
  } catch (err) { next(err); }
});

// DELETE /seasons/teams/:teamId?season= – odhlášení ze sezóny
router.delete('/teams/:teamId', requireSupervisor, async (req, res, next) => {
  try {
    const season = req.query.season || await seasonSvc.currentSeason();

    const odehrano = await prisma.match.count({
      where: {
        season,
        OR: [{ homeTeamId: req.params.teamId }, { awayTeamId: req.params.teamId }],
      },
    });
    if (odehrano > 0) {
      return res.status(409).json({
        error: 'Tým už má v téhle sezóně zápasy, odhlásit ho nelze',
        code:  'HAS_MATCHES',
      });
    }

    await prisma.teamSeason.deleteMany({ where: { teamId: req.params.teamId, season } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
