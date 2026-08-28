/**
 * Licence hráče: přehled, kde smí nastupovat, a volba týmů pro playoff.
 * Pravidla samotná žijí v services/licence.js, aby je stejně viděla
 * i kontrola soupisky.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const prisma   = require('../lib/prisma');
const licence  = require('../services/licence');
const seasonSvc = require('../services/seasonTransition');

const router = express.Router();

router.use(requireAuth);

// GET /licence/me?season=2025/26 – kde všude smím hrát a jak na tom jsem
router.get('/me', async (req, res, next) => {
  try {
    if (!req.user.player) {
      return res.status(404).json({ error: 'Nemáš hráčský profil', code: 'NO_PLAYER' });
    }
    const season = req.query.season || await seasonSvc.currentSeason();
    const prehled = await licence.prehledHrace(req.user.player.id, season);
    res.json(prehled);
  } catch (err) { next(err); }
});

// PUT /licence/playoff – volba primárního a sekundárního týmu
router.put('/playoff', async (req, res, next) => {
  try {
    if (!req.user.player) {
      return res.status(404).json({ error: 'Nemáš hráčský profil', code: 'NO_PLAYER' });
    }
    const playerId = req.user.player.id;
    const season   = req.body.season || await seasonSvc.currentSeason();
    const { primaryTeamId, secondaryTeamId } = req.body;

    if (!primaryTeamId) {
      return res.status(400).json({ error: 'Vyber primární tým' });
    }
    if (secondaryTeamId && secondaryTeamId === primaryTeamId) {
      return res.status(400).json({ error: 'Primární a sekundární tým musí být různé' });
    }

    // Volit lze jen z týmů, kde hráč nasbíral dost startů
    const naroky = await licence.narokyNaPlayoff(playerId, season);
    const idcka  = naroky.map(t => t.id);

    if (!idcka.includes(primaryTeamId)) {
      return res.status(422).json({
        error: `Za tenhle tým jsi v základní části neodehrál aspoň ${licence.MIN_STARTU_PRO_PLAYOFF} zápasy`,
        code:  'NOT_ELIGIBLE',
      });
    }
    if (secondaryTeamId && !idcka.includes(secondaryTeamId)) {
      return res.status(422).json({
        error: `Za sekundární tým jsi v základní části neodehrál aspoň ${licence.MIN_STARTU_PRO_PLAYOFF} zápasy`,
        code:  'NOT_ELIGIBLE',
      });
    }

    // Dva týmy dávají smysl jen se superlicencí
    const payment = await prisma.playerPayment.findUnique({ where: { playerId } });
    if (secondaryTeamId && !licence.maSuperlicenci(payment)) {
      return res.status(422).json({
        error: 'Druhý tým v playoff je součástí superlicence',
        code:  'NO_SUPER',
      });
    }

    // Jakmile playoff začalo, volbu už měnit nejde — jinak by šlo přebíhat podle výsledků
    const rozehrano = await prisma.match.count({
      where: { season, phase: 'PLAYOFF', status: { in: ['LIVE', 'DONE'] } },
    });
    const stavajici = await prisma.playoffChoice.findUnique({
      where: { playerId_season: { playerId, season } },
    });
    if (rozehrano > 0 && stavajici) {
      return res.status(409).json({
        error: 'Playoff už běží, volbu týmů měnit nelze',
        code:  'PLAYOFF_STARTED',
      });
    }

    const volba = await prisma.playoffChoice.upsert({
      where:  { playerId_season: { playerId, season } },
      create: { playerId, season, primaryTeamId, secondaryTeamId: secondaryTeamId || null },
      update: { primaryTeamId, secondaryTeamId: secondaryTeamId || null },
      include: {
        primary:   { select: { id: true, name: true, abbr: true, color: true } },
        secondary: { select: { id: true, name: true, abbr: true, color: true } },
      },
    });

    res.json(volba);
  } catch (err) { next(err); }
});

// DELETE /licence/playoff – zrušení volby (dokud playoff neběží)
router.delete('/playoff', async (req, res, next) => {
  try {
    if (!req.user.player) return res.status(404).json({ error: 'Nemáš hráčský profil' });
    const season = req.query.season || await seasonSvc.currentSeason();

    const rozehrano = await prisma.match.count({
      where: { season, phase: 'PLAYOFF', status: { in: ['LIVE', 'DONE'] } },
    });
    if (rozehrano > 0) {
      return res.status(409).json({ error: 'Playoff už běží, volbu týmů měnit nelze' });
    }

    await prisma.playoffChoice.deleteMany({ where: { playerId: req.user.player.id, season } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /licence/team/:teamId?season= – pro vedoucího: kdo smí do sestavy
router.get('/team/:teamId', async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const season = req.query.season || await seasonSvc.currentSeason();

    const jeVedouci = req.user.manager?.some(m => m.teamId === teamId);
    if (!jeVedouci) return res.status(403).json({ error: 'Nejsi vedoucí tohoto týmu' });

    // Kmenoví hráči
    const kmenovi = await prisma.player.findMany({
      where:  { teamId },
      select: { id: true, firstName: true, lastName: true, jersey: true, position: true, payment: true },
      orderBy: { lastName: 'asc' },
    });

    // Hosté – kdokoli, kdo za tým v sezóně nastoupil a není kmenový
    const slots = await prisma.lineupPlayer.findMany({
      where: {
        lineup: { teamId, match: { season, status: { not: 'CANCELLED' } } },
        player: { teamId: { not: teamId } },
      },
      select: {
        player: {
          select: {
            id: true, firstName: true, lastName: true, jersey: true, position: true,
            payment: true,
            team: { select: { id: true, name: true, abbr: true } },
          },
        },
      },
    });

    const hosteMap = new Map();
    for (const s of slots) hosteMap.set(s.player.id, s.player);

    res.json({
      season,
      home: kmenovi.map(p => ({
        id: p.id, firstName: p.firstName, lastName: p.lastName,
        jersey: p.jersey, position: p.position,
        licensed: licence.maZakladniLicenci(p.payment),
        superLic: licence.maSuperlicenci(p.payment),
      })),
      guests: [...hosteMap.values()].map(p => ({
        id: p.id, firstName: p.firstName, lastName: p.lastName,
        jersey: p.jersey, position: p.position,
        homeTeam: p.team,
        licensed: licence.maZakladniLicenci(p.payment),
        superLic: licence.maSuperlicenci(p.payment),
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
