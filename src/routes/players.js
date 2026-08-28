const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { uploadPhoto } = require('../utils/fileUpload');

const router = express.Router();
const prisma = require('../lib/prisma');

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

// GET /players/my/stats – osobní statistiky (MUSÍ být před /:id !)
router.get('/my/stats', requireAuth, async (req, res, next) => {
  try {
    const { season } = req.query;
    const matchWhere = season ? { match: { season } } : undefined;

    const player = await prisma.player.findUnique({
      where: { userId: req.user.id },
      include: {
        goals:    { where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        assists:  { where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        penalties:{ where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        mvpVotes: { where: season ? { match: { season } } : undefined },
      },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    res.json({
      goals:     player.goals.length,
      assists:   player.assists.length,
      points:    player.goals.length + player.assists.length,
      penalties: player.penalties.length,
      mvpVotes:  player.mvpVotes.length,
      recentGoals:    player.goals.slice(-5).reverse(),
      recentAssists:  player.assists.slice(-5).reverse(),
    });
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
    const { firstName, lastName, jersey, position, birthdate, phone, teamId, inviteCode } = req.body;
    if (!firstName || !lastName || !jersey) {
      return res.status(400).json({ error: 'Chybí povinné údaje (jméno, příjmení, číslo dresu)' });
    }

    // Tým se odvozuje z pozvánkového kódu. Holé teamId zůstává jako fallback
    // pro starší verze aplikace, které kód ještě neposílají.
    let invite = null;
    let cilovyTeamId = teamId;

    if (inviteCode) {
      invite = await prisma.inviteCode.findUnique({
        where:   { code: String(inviteCode).toUpperCase() },
        include: { team: true },
      });
      if (!invite) return res.status(404).json({ error: 'Neplatný pozvánkový kód' });
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        return res.status(400).json({ error: 'Pozvánkový kód vypršel' });
      }
      cilovyTeamId = invite.teamId;
    }

    if (!cilovyTeamId) {
      return res.status(400).json({ error: 'Chybí pozvánkový kód' });
    }

    // BUG-09 OPRAVA: Validace čísla dresu (zabraňuje NaN z parseInt)
    const jerseyNum = parseInt(jersey, 10);
    if (isNaN(jerseyNum) || jerseyNum < 0 || jerseyNum > 99) {
      return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
    }

    // Zkontroluj, zda už uživatel nemá hráče
    const existing = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (existing) return res.status(409).json({ error: 'Uživatel již má hráčský profil' });

    // Zkontroluj unikátnost čísla dresu v týmu
    const jerseyTaken = await prisma.player.findFirst({
      where: { teamId: cilovyTeamId, jersey: jerseyNum },
    });
    if (jerseyTaken) return res.status(409).json({ error: `Číslo dresu ${jerseyNum} je již obsazeno v tomto týmu` });

    const player = await prisma.player.create({
      data: {
        userId: req.user.id,
        teamId: cilovyTeamId,
        firstName,
        lastName,
        jersey: jerseyNum,
        position: position || 'Útočník',
        birthdate: birthdate ? new Date(birthdate) : null,
        phone,
        payment: { create: {} },
      },
    });
    // Kód se počítá jako použitý až tady — když hráč skutečně vznikl
    if (invite) {
      await prisma.inviteCode.update({
        where: { id: invite.id },
        data:  { usedCount: { increment: 1 } },
      });
    }

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

    // BUG-09 OPRAVA: Validace čísla dresu při editaci
    if (jersey !== undefined && jersey !== null && jersey !== '') {
      const jerseyEditNum = parseInt(jersey, 10);
      if (isNaN(jerseyEditNum) || jerseyEditNum < 0 || jerseyEditNum > 99) {
        return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
      }
    }

    // Zkontroluj unikátnost čísla dresu při změně
    if (jersey && player.teamId) {
      const jerseyTaken = await prisma.player.findFirst({
        where: { teamId: player.teamId, jersey: parseInt(jersey, 10), NOT: { id: req.params.id } },
      });
      if (jerseyTaken) return res.status(409).json({ error: `Číslo dresu ${parseInt(jersey, 10)} je již obsazeno v tomto týmu` });
    }

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: {
        ...(firstName !== undefined && firstName && { firstName }),
        ...(lastName  !== undefined && lastName  && { lastName }),
        ...(jersey    !== undefined && jersey    && { jersey: parseInt(jersey, 10) }),
        ...(position  !== undefined && { position:  position  || null }),
        ...(birthdate !== undefined && birthdate  && { birthdate: new Date(birthdate) }),
        ...(phone     !== undefined && { phone:     phone     || null }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /players/:id/leave-team – hráč opustí tým
router.post('/:id/leave-team', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    if (player.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (!player.teamId) return res.status(400).json({ error: 'Hráč není v žádném týmu' });

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: { teamId: null },
    });
    res.json({ ok: true, player: updated });
  } catch (err) { next(err); }
});

// DELETE /players/:id/team/:teamId – manažer odebere hráče z týmu
router.delete('/:id/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });

    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    const isSup = req.user?.player?.isSupervisor;
    if (!isManager && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (player.teamId !== req.params.teamId) return res.status(400).json({ error: 'Hráč není v tomto týmu' });

    await prisma.player.update({
      where: { id: req.params.id },
      data: { teamId: null },
    });
    res.json({ ok: true });
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
