const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { uploadDraftVideo, cloudinary } = require('../utils/fileUpload');
const { createNotification, createNotifications } = require('./notifications');

const router = express.Router();
const prisma = new PrismaClient();

const H72 = 72 * 60 * 60 * 1000;
const H24 = 24 * 60 * 60 * 1000;

// ── Auto-expire helper – volá se lazy při každém GET /draft ──
async function processExpiredWindows() {
  const now = new Date();
  const expired = await prisma.draftOffer.findMany({
    where: { status: 'PENDING', isFirst: true, expiresAt: { lt: now } },
    include: { profile: { include: { player: { select: { id: true, userId: true, firstName: true, lastName: true } } } }, team: { select: { name: true } } },
  });

  for (const offer of expired) {
    const profileId = offer.profileId;
    const playerId  = offer.profile.playerId;

    // Auto-accept první nabídku
    await prisma.draftOffer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED' } });
    // Hráč vstupuje do týmu
    await prisma.player.update({ where: { id: playerId }, data: { teamId: offer.teamId } });
    // Zbytek nabídek vyprší
    await prisma.draftOffer.updateMany({
      where: { profileId, status: 'PENDING' },
      data:  { status: 'EXPIRED' },
    });
    // Deaktivovat profil
    await prisma.draftProfile.update({ where: { id: profileId }, data: { isActive: false } });

    // Notifikace hráče
    const player = offer.profile.player;
    if (player?.userId) {
      await createNotification(player.userId, 'Draft – automaticky přijato',
        `Byl(a) jsi automaticky draftován(a) do týmu ${offer.team.name}.`, 'draft');
    }
    // Notifikace týmu
    const teamManagers = await prisma.manager.findMany({
      where: { teamId: offer.teamId }, select: { userId: true },
    });
    if (teamManagers.length) {
      await createNotifications(teamManagers.map(m => ({
        userId: m.userId,
        title:  'Draft – hráč přijat (auto)',
        body:   `${player.firstName} ${player.lastName} byl(a) automaticky přidán(a) do vašeho týmu.`,
        screen: 'draft',
      })));
    }
  }
}

// ────────────────────────────────────────────────────────────
// GET /draft – seznam všech aktivních profilů
// ────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    await processExpiredWindows();

    const isManager = (req.user.manager ?? []).length > 0;

    const profiles = await prisma.draftProfile.findMany({
      where: { isActive: true },
      include: {
        player: {
          select: {
            id: true, firstName: true, lastName: true, jersey: true,
            position: true, photoUrl: true,
            ...(isManager ? { phone: true } : {}),
          },
        },
        videos: { select: { id: true, url: true }, orderBy: { createdAt: 'asc' } },
        _count:  { select: { offers: { where: { status: 'PENDING' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Přidej info o window – jen přes separátní dotaz
    const profileIds = profiles.map(p => p.id);
    const firstOffers = await prisma.draftOffer.findMany({
      where: { profileId: { in: profileIds }, status: 'PENDING', isFirst: true },
      select: { profileId: true, expiresAt: true },
    });
    const expiryMap = Object.fromEntries(firstOffers.map(o => [o.profileId, o.expiresAt]));

    const result = profiles.map(p => ({
      ...p,
      offerCount:      p._count.offers,
      windowExpiresAt: expiryMap[p.id] ?? null,
      _count: undefined,
    }));

    res.json(result);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// GET /draft/me – můj draft profil (s nabídkami)
// ────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const profile = await prisma.draftProfile.findUnique({
      where: { playerId: player.id },
      include: {
        videos: { orderBy: { createdAt: 'asc' } },
        offers: {
          where:   { status: 'PENDING' },
          include: { team: { select: { id: true, name: true, abbr: true, color: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    res.json(profile);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// POST /draft/profile – vytvořit nebo obnovit draft profil
// ────────────────────────────────────────────────────────────
router.post('/profile', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });
    if (player.teamId) return res.status(400).json({ error: 'Hráč je již v týmu' });

    const { bio, pubSkill, position } = req.body;

    const profile = await prisma.draftProfile.upsert({
      where:  { playerId: player.id },
      create: { playerId: player.id, bio: bio || null, pubSkill: pubSkill || null, position: position || null, isActive: true },
      update: { bio: bio || null, pubSkill: pubSkill || null, position: position || null, isActive: true, updatedAt: new Date() },
      include: { videos: true },
    });

    // Notifikace všem vedoucím o novém hráči v draftu
    const managers = await prisma.manager.findMany({ select: { userId: true } });
    if (managers.length) {
      await createNotifications(managers.map(m => ({
        userId: m.userId,
        title:  'Nový hráč v draftu',
        body:   `${player.firstName} ${player.lastName} se přidal(a) do draft poolu`,
        screen: 'draft',
      })));
    }

    res.status(201).json(profile);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// PUT /draft/profile – aktualizovat profil
// ────────────────────────────────────────────────────────────
router.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const { bio, pubSkill, position } = req.body;
    const profile = await prisma.draftProfile.update({
      where: { playerId: player.id },
      data:  {
        ...(bio      !== undefined && { bio }),
        ...(pubSkill !== undefined && { pubSkill }),
        ...(position !== undefined && { position }),
      },
      include: { videos: true },
    });
    res.json(profile);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// DELETE /draft/profile – deaktivovat profil
// ────────────────────────────────────────────────────────────
router.delete('/profile', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    await prisma.draftProfile.update({
      where: { playerId: player.id },
      data:  { isActive: false },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// POST /draft/profile/video – nahrát video (max 5)
// ────────────────────────────────────────────────────────────
router.post('/profile/video', requireAuth, uploadDraftVideo.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Soubor nenalezen' });

    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const profile = await prisma.draftProfile.findUnique({ where: { playerId: player.id } });
    if (!profile) return res.status(404).json({ error: 'Draft profil nenalezen – nejprve ho vytvoř' });

    const count = await prisma.draftVideo.count({ where: { profileId: profile.id } });
    if (count >= 5) return res.status(400).json({ error: 'Maximálně 5 videí na profil' });

    const video = await prisma.draftVideo.create({
      data: { profileId: profile.id, url: req.file.path },
    });
    res.status(201).json(video);
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// DELETE /draft/video/:videoId – smazat video
// ────────────────────────────────────────────────────────────
router.delete('/video/:videoId', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const video = await prisma.draftVideo.findUnique({
      where:   { id: req.params.videoId },
      include: { profile: true },
    });
    if (!video || video.profile.playerId !== player.id) {
      return res.status(404).json({ error: 'Video nenalezeno' });
    }

    // Smazat z Cloudinary
    try {
      const parts   = video.url.split('/upload/');
      const noVer   = parts[1].replace(/^v\d+\//, '');
      const publicId = noVer.replace(/\.[^.]+$/, '');
      await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
    } catch { /* pokud Cloudinary delete selže, DB záznam stejně smažeme */ }

    await prisma.draftVideo.delete({ where: { id: video.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// GET /draft/:playerId – detail profilu hráče
// ────────────────────────────────────────────────────────────
router.get('/:playerId', requireAuth, async (req, res, next) => {
  try {
    await processExpiredWindows();

    const isManager     = (req.user.manager ?? []).length > 0;
    const myPlayer      = await prisma.player.findUnique({ where: { userId: req.user.id } });
    const isOwnProfile  = myPlayer?.id === req.params.playerId;

    const profile = await prisma.draftProfile.findUnique({
      where: { playerId: req.params.playerId },
      include: {
        player: {
          select: {
            id: true, firstName: true, lastName: true, jersey: true,
            position: true, photoUrl: true,
            ...(isManager ? { phone: true } : {}),
          },
        },
        videos: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!profile || !profile.isActive) {
      return res.status(404).json({ error: 'Draft profil nenalezen' });
    }

    // Nabídky vidí pouze vlastník profilu
    let offers = [];
    if (isOwnProfile) {
      offers = await prisma.draftOffer.findMany({
        where:   { profileId: profile.id, status: 'PENDING' },
        include: { team: { select: { id: true, name: true, abbr: true, color: true } } },
        orderBy: { createdAt: 'asc' },
      });
    }

    // Info o window
    const firstOffer = await prisma.draftOffer.findFirst({
      where:   { profileId: profile.id, status: 'PENDING', isFirst: true },
      select:  { expiresAt: true },
    });
    const offerCount = await prisma.draftOffer.count({
      where: { profileId: profile.id, status: 'PENDING' },
    });

    // Nabídka mého týmu (manager pohled)
    let myTeamOffer = null;
    if (isManager && req.user.manager?.[0]?.teamId) {
      myTeamOffer = await prisma.draftOffer.findUnique({
        where: { profileId_teamId: { profileId: profile.id, teamId: req.user.manager[0].teamId } },
      });
    }

    res.json({
      ...profile,
      offers,
      offerCount,
      windowExpiresAt: firstOffer?.expiresAt ?? null,
      myTeamOffer,
    });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// POST /draft/:playerId/offer – tým pošle nabídku
// ────────────────────────────────────────────────────────────
router.post('/:playerId/offer', requireAuth, async (req, res, next) => {
  try {
    const myTeamId = req.user.manager?.[0]?.teamId;
    if (!myTeamId) return res.status(403).json({ error: 'Nejste vedoucí týmu' });

    const profile = await prisma.draftProfile.findUnique({
      where:   { playerId: req.params.playerId },
      include: { player: { select: { userId: true, firstName: true, lastName: true } } },
    });
    if (!profile || !profile.isActive) {
      return res.status(404).json({ error: 'Draft profil nenalezen' });
    }

    // Kontrola duplicity
    const alreadyOffered = await prisma.draftOffer.findUnique({
      where: { profileId_teamId: { profileId: profile.id, teamId: myTeamId } },
    });
    if (alreadyOffered) return res.status(409).json({ error: 'Váš tým již poslal nabídku tomuto hráči' });

    const { message } = req.body;
    const now = new Date();

    // Existující pending nabídky
    const pending = await prisma.draftOffer.findMany({
      where:   { profileId: profile.id, status: 'PENDING' },
      include: { team: { select: { name: true } } },
    });
    const isFirst  = pending.length === 0;
    const expiresAt = isFirst
      ? new Date(now.getTime() + H72)
      : new Date(now.getTime() + H24);

    // Při přebití: reset expirace všech existujících nabídek na 24h
    if (!isFirst) {
      await prisma.draftOffer.updateMany({
        where: { profileId: profile.id, status: 'PENDING' },
        data:  { expiresAt },
      });
      // Notifikace přebitých manažerů
      const competingTeamIds = pending.map(o => o.teamId);
      const managers = await prisma.manager.findMany({
        where:  { teamId: { in: competingTeamIds } },
        select: { userId: true },
      });
      if (managers.length) {
        const myTeam = await prisma.team.findUnique({ where: { id: myTeamId }, select: { name: true } });
        await createNotifications(managers.map(m => ({
          userId: m.userId,
          title:  'Draft – přebití nabídky',
          body:   `Tým ${myTeam?.name} také nabídl ${profile.player.firstName} ${profile.player.lastName}. Zbývá 24 hodin.`,
          screen: 'draft',
        })));
      }
    }

    const offer = await prisma.draftOffer.create({
      data: {
        profileId: profile.id,
        teamId:    myTeamId,
        message:   message || null,
        isFirst,
        expiresAt,
      },
    });

    // Notifikace hráče
    if (profile.player?.userId) {
      const myTeam = await prisma.team.findUnique({ where: { id: myTeamId }, select: { name: true } });
      await createNotification(profile.player.userId, 'Draft – nová nabídka',
        `Tým ${myTeam?.name} tě chce draftovat. ${isFirst ? 'Máš 72 hodin.' : 'Přebití – 24 hodin na rozhodnutí.'}`,
        'draft');
    }

    res.status(201).json({ offer, windowExpiresAt: expiresAt, isFirst });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// POST /draft/:playerId/offer/:offerId/accept – hráč přijme nabídku
// ────────────────────────────────────────────────────────────
router.post('/:playerId/offer/:offerId/accept', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player || player.id !== req.params.playerId) {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    const profile = await prisma.draftProfile.findUnique({ where: { playerId: player.id } });
    if (!profile) return res.status(404).json({ error: 'Draft profil nenalezen' });

    const offer = await prisma.draftOffer.findUnique({
      where:   { id: req.params.offerId },
      include: { team: { select: { id: true, name: true } } },
    });
    if (!offer || offer.profileId !== profile.id || offer.status !== 'PENDING') {
      return res.status(404).json({ error: 'Nabídka nenalezena nebo již zpracována' });
    }

    // Akceptovat tuto nabídku
    await prisma.draftOffer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED' } });
    // Zbytek vyprší
    await prisma.draftOffer.updateMany({
      where: { profileId: profile.id, status: 'PENDING' },
      data:  { status: 'EXPIRED' },
    });
    // Hráč do týmu
    await prisma.player.update({ where: { id: player.id }, data: { teamId: offer.teamId } });
    // Deaktivovat profil
    await prisma.draftProfile.update({ where: { id: profile.id }, data: { isActive: false } });

    // Notifikace akceptovaného týmu
    const managers = await prisma.manager.findMany({
      where:  { teamId: offer.teamId },
      select: { userId: true },
    });
    if (managers.length) {
      await createNotifications(managers.map(m => ({
        userId: m.userId,
        title:  'Draft – hráč přijal nabídku!',
        body:   `${player.firstName} ${player.lastName} přijal(a) vaši nabídku a vstupuje do týmu.`,
        screen: 'draft',
      })));
    }

    res.json({ ok: true, teamId: offer.teamId, teamName: offer.team.name });
  } catch (err) { next(err); }
});

// ────────────────────────────────────────────────────────────
// POST /draft/:playerId/offer/:offerId/reject – hráč odmítne nabídku
// ────────────────────────────────────────────────────────────
router.post('/:playerId/offer/:offerId/reject', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player || player.id !== req.params.playerId) {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    const profile = await prisma.draftProfile.findUnique({ where: { playerId: player.id } });
    if (!profile) return res.status(404).json({ error: 'Draft profil nenalezen' });

    const offer = await prisma.draftOffer.findUnique({
      where:   { id: req.params.offerId },
      include: { team: true },
    });
    if (!offer || offer.profileId !== profile.id || offer.status !== 'PENDING') {
      return res.status(404).json({ error: 'Nabídka nenalezena nebo již zpracována' });
    }

    await prisma.draftOffer.update({ where: { id: offer.id }, data: { status: 'REJECTED' } });

    // Pokud odmítnuta první nabídka, předat isFirst na nejstarší zbývající
    if (offer.isFirst) {
      const next = await prisma.draftOffer.findFirst({
        where:   { profileId: profile.id, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await prisma.draftOffer.update({ where: { id: next.id }, data: { isFirst: true } });
      }
    }

    // Notifikace odmítnutého týmu
    const managers = await prisma.manager.findMany({
      where:  { teamId: offer.teamId },
      select: { userId: true },
    });
    if (managers.length) {
      await createNotifications(managers.map(m => ({
        userId: m.userId,
        title:  'Draft – nabídka odmítnuta',
        body:   `${player.firstName} ${player.lastName} odmítl(a) vaši nabídku.`,
        screen: 'draft',
      })));
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
