const express = require('express');

const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { uploadPhoto } = require('../utils/fileUpload');
const { createNotification } = require('./notifications');

const router = express.Router();
const prisma = require('../lib/prisma');

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
      process.env.SUPERVISOR_USER_IDS?.split(',').map(s => s.trim()).includes(req.user.id);
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
        ...(phone       !== undefined && { phone:       phone       || null }),
        ...(address     !== undefined && { address:     address     || null }),
        ...(city        !== undefined && { city:        city        || null }),
        ...(zip         !== undefined && { zip:         zip         || null }),
        ...(bankAccount !== undefined && { bankAccount: bankAccount || null }),
        ...(bankCode    !== undefined && { bankCode:    bankCode    || null }),
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

    // Notifikace rozhodčímu (včetně push)
    await createNotification(ref.userId, 'Registrace schválena',
      `Vaše registrace rozhodčího byla schválena. Úroveň: ${ref.level}`, 'ref-detail');

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

    // Notifikace rozhodčímu (včetně push)
    await createNotification(ref.userId, 'Registrace zamítnuta',
      reason || 'Vaše registrace rozhodčího byla zamítnuta.', 'onboard-ref');

    res.json(ref);
  } catch (err) { next(err); }
});

// POST /referees/:id/rate – hodnocení rozhodčího po zápase (manažer jednoho z týmů)
router.post('/:id/rate', requireAuth, async (req, res, next) => {
  try {
    const { matchId, rating } = req.body;
    if (!matchId || !rating || Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ error: 'Neplatné hodnocení – zadej číslo 1–5 a matchId' });
    }

    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'DONE') return res.status(400).json({ error: 'Zápas ještě neskončil' });
    if (match.refereeId !== req.params.id) return res.status(400).json({ error: 'Rozhodčí nebyl přiřazen k tomuto zápasu' });

    // Ověř, že uživatel je manažer jednoho z týmů
    const manager = await prisma.manager.findFirst({
      where: {
        userId: req.user.id,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
    });
    if (!manager) return res.status(403).json({ error: 'Nemáte oprávnění hodnotit rozhodčího' });

    const result = await prisma.refRating.upsert({
      where:  { matchId_teamId: { matchId, teamId: manager.teamId } },
      create: { matchId, refereeId: req.params.id, teamId: manager.teamId, rating: Number(rating) },
      update: { rating: Number(rating) },
    });

    res.json(result);
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
