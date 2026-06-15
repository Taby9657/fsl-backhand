const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireManager } = require('../middleware/auth');
const { uploadLogo } = require('../utils/fileUpload');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const prisma = new PrismaClient();

// GET /teams – seznam všech týmů
router.get('/', async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      include: { _count: { select: { players: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// GET /teams/:id – detail týmu
router.get('/:id', async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        players: { orderBy: { jersey: 'asc' } },
        managers: { include: { user: true } },
      },
    });
    if (!team) return res.status(404).json({ error: 'Tým nenalezen' });
    res.json(team);
  } catch (err) { next(err); }
});

// POST /teams – registrace nového týmu (vedoucí)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, abbr, color, division } = req.body;
    if (!name || !abbr) return res.status(400).json({ error: 'Název a zkratka jsou povinné' });

    const team = await prisma.team.create({
      data: {
        name,
        abbr: abbr.toUpperCase().slice(0, 3),
        color: color || '#C9A140',
        division: division || 'Divize A',
        managers: { create: { userId: req.user.id } },
        payments: { create: {} },
      },
      include: { managers: true },
    });

    // Vygeneruj pozvánkový kód
    const code = `FSL-${team.abbr}-${uuidv4().slice(0, 4).toUpperCase()}`;
    await prisma.inviteCode.create({ data: { code, teamId: team.id } });

    res.status(201).json({ team, inviteCode: code });
  } catch (err) { next(err); }
});

// PUT /teams/:id – update týmu (jen vedoucí)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const { name, color } = req.body;
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(color && { color }) },
    });
    res.json(team);
  } catch (err) { next(err); }
});

// POST /teams/:id/logo – nahrání loga (multer + cloudinary)
router.post('/:id/logo', requireAuth, uploadLogo.single('logo'), async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: { logoUrl: req.file.path },
    });
    res.json({ logoUrl: team.logoUrl });
  } catch (err) { next(err); }
});

// GET /teams/:id/invite – pozvánkový kód týmu
router.get('/:id/invite', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    let invite = await prisma.inviteCode.findFirst({ where: { teamId: req.params.id } });
    if (!invite) {
      const team = await prisma.team.findUnique({ where: { id: req.params.id } });
      const code = `FSL-${team.abbr}-${uuidv4().slice(0, 4).toUpperCase()}`;
      invite = await prisma.inviteCode.create({ data: { code, teamId: req.params.id } });
    }
    res.json({ code: invite.code });
  } catch (err) { next(err); }
});

// POST /teams/join/:code – hráč se připojí k týmu pomocí kódu
router.post('/join/:code', requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.inviteCode.findUnique({
      where: { code: req.params.code.toUpperCase() },
      include: { team: true },
    });
    if (!invite) return res.status(404).json({ error: 'Neplatný pozvánkový kód' });
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Pozvánkový kód vypršel' });
    }

    await prisma.inviteCode.update({
      where: { id: invite.id },
      data: { usedCount: { increment: 1 } },
    });

    res.json({ team: invite.team });
  } catch (err) { next(err); }
});

module.exports = router;
