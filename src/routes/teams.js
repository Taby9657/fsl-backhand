const express = require('express');

const { requireAuth, requireManager } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { uploadLogo } = require('../utils/fileUpload');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const prisma = require('../lib/prisma');

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

// GET /teams/divisions – veřejný seznam divizí (MUSÍ být před /:id !)
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

// GET /teams/:id – detail týmu
router.get('/:id', async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        players: { orderBy: { jersey: 'asc' }, include: { payment: true } },
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
    const { name, abbr, color, colorSecondary } = req.body;
    if (!name || !abbr) return res.status(400).json({ error: 'Název a zkratka jsou povinné' });

    const team = await prisma.team.create({
      data: {
        name,
        abbr:      abbr.toUpperCase().slice(0, 3),
        color:     color || '#C9A140',
        colorSecondary: colorSecondary || null,
        // Divizi přiděluje supervisor při rozlosování, ne vedoucí při registraci
        division:  null,
        regStatus: 'PENDING', // nový tým čeká na schválení supervisorem
        managers:  { create: { userId: req.user.id } },
        payments:  { create: {} },
      },
      include: { managers: true },
    });

    // Vygeneruj pozvánkový kód
    const code = `FSL-${team.abbr}-${uuidv4().slice(0, 4).toUpperCase()}`;
    await prisma.inviteCode.create({ data: { code, teamId: team.id } });

    // Notifikuj vedoucího o přijetí žádosti
    await createNotification(
      req.user.id,
      'Registrace přijata 📋',
      `Tým ${team.name} byl přihlášen do ligy. Čeká na schválení supervisorem.`,
      'admin',
    );

    res.status(201).json({ team, inviteCode: code });
  } catch (err) { next(err); }
});

// PUT /teams/:id/appeal – odvolání vedoucího po zamítnutí
router.put('/:id/appeal', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const { appeal } = req.body;
    if (!appeal?.trim()) return res.status(400).json({ error: 'Text odvolání je povinný' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Tým nenalezen' });
    if (team.regStatus !== 'REJECTED') {
      return res.status(400).json({ error: 'Odvolání lze podat pouze u zamítnuté registrace' });
    }

    const updated = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'APPEALING', regAppeal: appeal.trim(), regAppealAt: new Date() },
    });

    // Notifikuj supervisory (hráče s isSupervisor=true)
    const supervisors = await prisma.player.findMany({
      where:   { isSupervisor: true },
      include: { user: { select: { id: true } } },
    });
    for (const sv of supervisors) {
      await createNotification(
        sv.user.id,
        'Odvolání registrace ⚠️',
        `Tým ${team.name} se odvolal proti zamítnutí.`,
        'supervisor/teams',
      );
    }

    res.json(updated);
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

    // POZOR: tohle je jen ověření kódu, ne skutečné připojení k týmu.
    // Počítadlo použití se zvyšuje až ve chvíli, kdy hráč opravdu vznikne
    // (POST /players) — jinak by ho nafoukl každý, kdo si kód jen ověří
    // a pak registraci nedokončí.
    res.json({ team: invite.team });
  } catch (err) { next(err); }
});

module.exports = router;
