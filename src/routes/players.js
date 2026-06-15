const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { uploadPhoto } = require('../utils/fileUpload');

const router = express.Router();
const prisma = new PrismaClient();

// GET /players – seznam všech hráčů (veřejné)
router.get('/', async (req, res, next) => {
  try {
    const { teamId, licensed } = req.query;
    const players = await prisma.player.findMany({
      where: {
        ...(teamId && { teamId }),
        ...(licensed !== undefined && { licensed: licensed === 'true' }),
      },
      include: { team: { select: { id: true, name: true, abbr: true, color: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    res.json(players);
  } catch (err) { next(err); }
});

// GET /players/:id – detail hráče
router.get('/:id', async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where: { id: req.params.id },
      include: {
        team: true,
        goals:   { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        assists: { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        mvpVotes: { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        payment: true,
      },
    });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    res.json(player);
  } catch (err) { next(err); }
});

// POST /players – registrace hráče do týmu
// Vyžaduje: jméno, příjmení, číslo dresu, pozici, teamId
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { firstName, lastName, jersey, position, birthdate, phone, teamId } = req.body;
    if (!firstName || !lastName || !jersey || !teamId) {
      return res.status(400).json({ error: 'Chybí povinné údaje (jméno, příjmení, číslo dresu, tým)' });
    }

    // Zkontroluj, zda už uživatel nemá hráče
    const existing = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (existing) return res.status(409).json({ error: 'Uživatel již má hráčský profil' });

    const player = await prisma.player.create({
      data: {
        userId: req.user.id,
        teamId,
        firstName,
        lastName,
        jersey: parseInt(jersey),
        position: position || 'Útočník',
        birthdate: birthdate ? new Date(birthdate) : null,
        phone,
        payment: { create: {} },
      },
    });
    res.status(201).json(player);
  } catch (err) { next(err); }
});

// PUT /players/:id – úprava hráčského profilu (vlastní hráč nebo vedoucí)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });

    const isSelf    = player.userId === req.user.id;
    const isManager = req.user.manager?.some(m => m.teamId === player.teamId);
    if (!isSelf && !isManager) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const { firstName, lastName, jersey, position, birthdate, phone } = req.body;
    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: {
        ...(firstName  && { firstName }),
        ...(lastName   && { lastName }),
        ...(jersey     && { jersey: parseInt(jersey) }),
        ...(position   && { position }),
        ...(birthdate  && { birthdate: new Date(birthdate) }),
        ...(phone      && { phone }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /players/:id/photo – nahrání fotky
router.post('/:id/photo', requireAuth, uploadPhoto.single('photo'), async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    if (player.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: { photoUrl: req.file.path },
    });
    res.json({ photoUrl: updated.photoUrl });
  } catch (err) { next(err); }
});

module.exports = router;
