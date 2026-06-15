const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { uploadPhoto } = require('../utils/fileUpload');

const router = express.Router();
const prisma = new PrismaClient();

// GET /referees – seznam rozhodčích (veřejné základní info)
router.get('/', async (req, res, next) => {
  try {
    const { status, level } = req.query;
    const referees = await prisma.referee.findMany({
      where: {
        ...(status && { status }),
        ...(level  && { level }),
      },
      select: {
        id: true, firstName: true, lastName: true, photoUrl: true,
        level: true, status: true, createdAt: true,
      },
      orderBy: [{ lastName: 'asc' }],
    });
    res.json(referees);
  } catch (err) { next(err); }
});

// GET /referees/:id – detail rozhodčího
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ref = await prisma.referee.findUnique({
      where: { id: req.params.id },
      include: {
        matches: {
          include: {
            homeTeam: { select: { id: true, name: true, abbr: true } },
            awayTeam: { select: { id: true, name: true, abbr: true } },
          },
          orderBy: { date: 'desc' },
        },
        ratings: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!ref) return res.status(404).json({ error: 'Rozhodčí nenalezen' });

    // Citlivé HR/bank údaje jen pro samotného rozhodčího nebo supervisora
    const isSelf       = ref.userId === req.user.id;
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isSelf && !isSupervisor) {
      const { birthNo, address, city, zip, bankAccount, bankCode, ...safe } = ref;
      return res.json(safe);
    }
    res.json(ref);
  } catch (err) { next(err); }
});

// POST /referees – onboarding nového rozhodčího (krok 1+2)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      firstName, lastName, phone,
      birthNo, address, city, zip, bankAccount, bankCode,
    } = req.body;
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Jméno a příjmení jsou povinné' });
    }

    const existing = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    if (existing) return res.status(409).json({ error: 'Uživatel již má profil rozhodčího' });

    const ref = await prisma.referee.create({
      data: {
        userId:     req.user.id,
        firstName,
        lastName,
        phone:       phone       || null,
        birthNo:     birthNo     || null,
        address:     address     || null,
        city:        city        || null,
        zip:         zip         || null,
        bankAccount: bankAccount || null,
        bankCode:    bankCode    || null,
        status:      'PENDING',
        level:       'C',
      },
    });
    res.status(201).json(ref);
  } catch (err) { next(err); }
});

// POST /referees/:id/photo – nahrání fotky rozhodčího
router.post('/:id/photo', requireAuth, uploadPhoto.single('photo'), async (req, res, next) => {
  try {
    const ref = await prisma.referee.findUnique({ where: { id: req.params.id } });
    if (!ref) return res.status(404).json({ error: 'Rozhodčí nenalezen' });
    if (ref.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const updated = await prisma.referee.update({
      where: { id: req.params.id },
      data:  { photoUrl: req.file.path },
    });
    res.json({ photoUrl: updated.photoUrl });
  } catch (err) { next(err); }
});

// PUT /referees/:id – úprava profilu (vlastní rozhodčí)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const ref = await prisma.referee.findUnique({ where: { id: req.params.id } });
    if (!ref) return res.status(404).json({ error: 'Rozhodčí nenalezen' });
    if (ref.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const { phone, address, city, zip, bankAccount, bankCode } = req.body;
    const updated = await prisma.referee.update({
      where: { id: req.params.id },
      data: {
        ...(phone       && { phone }),
        ...(address     && { address }),
        ...(city        && { city }),
        ...(zip         && { zip }),
        ...(bankAccount && { bankAccount }),
        ...(bankCode    && { bankCode }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// ==================== SUPERVISOR akce ====================

// PUT /referees/:id/approve – schválení + přiřazení úrovně (supervisor)
router.put('/:id/approve', requireSupervisor, async (req, res, next) => {
  try {
    const { level } = req.body;
    const validLevels = ['A', 'B', 'C'];
    if (level && !validLevels.includes(level)) {
      return res.status(400).json({ error: 'Neplatná úroveň rozhodčího (A/B/C)' });
    }

    const ref = await prisma.referee.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED', ...(level && { level }) },
    });

    // Notifikace rozhodčímu
    await prisma.notification.create({
      data: {
        userId: ref.userId,
        title:  'Registrace schválena',
        body:   `Vaše registrace rozhodčího byla schválena. Úroveň: ${ref.level}`,
        screen: 'ref-detail',
      },
    });

    res.json(ref);
  } catch (err) { next(err); }
});

// PUT /referees/:id/reject – zamítnutí registrace (supervisor)
router.put('/:id/reject', requireSupervisor, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const ref = await prisma.referee.update({
      where: { id: req.params.id },
      data:  { status: 'REJECTED' },
    });

    await prisma.notification.create({
      data: {
        userId: ref.userId,
        title:  'Registrace zamítnuta',
        body:   reason || 'Vaše registrace rozhodčího byla zamítnuta.',
        screen: 'onboard-ref',
      },
    });

    res.json(ref);
  } catch (err) { next(err); }
});

// GET /referees/:id/future-matches – nadcházející nasazení (pro kartu rozhodčího)
router.get('/:id/future-matches', async (req, res, next) => {
  try {
    const matches = await prisma.match.findMany({
      where: {
        refereeId: req.params.id,
        date:      { gte: new Date() },
        status:    { in: ['UPCOMING', 'LIVE'] },
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
      },
      orderBy: { date: 'asc' },
    });
    res.json(matches);
  } catch (err) { next(err); }
});

module.exports = router;
