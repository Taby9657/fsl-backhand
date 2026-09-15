const express = require('express');

const { requireAuth, optionalAuth } = require('../middleware/auth');
const { uploadDraftVideo, cloudinary } = require('../utils/fileUpload');
const { createNotification, createNotifications } = require('./notifications');

const router = express.Router();
const prisma = require('../lib/prisma');
const licence = require('../services/licence');
const seasonSvc = require('../services/seasonTransition');
const pocty = require('../services/pocty');
const { slotZPostu } = require('../utils/posty');
const draftPool = require('../services/draftPool');

const H72 = 72 * 60 * 60 * 1000;
const H24 = 24 * 60 * 60 * 1000;

/**
 * Draft končí zápisem na **soupisku**, ne nastavením `Player.teamId`.
 *
 * Do 15. 9. 2026 nastavovalo přijetí nabídky i cron jen `teamId`. Hráč se
 * objevil na `/tym/soupiska` (ta čte `Player.teamId`), ale sestava se skládá
 * výhradně z `TeamRoster` — v seznamu tedy nebyl a vedoucí neměl jak zjistit
 * proč. **Kdo sem přidá další cestu do týmu, musí zavolat tohle**, ne jen
 * `player.update`.
 *
 * Zároveň se přepíše `Player.position` postem z draft profilu: vedoucí
 * draftoval brankáře podle toho, co četl v poolu, a bez tohohle by mu
 * skončil na soupisce jako hráč do pole.
 */
async function zapisNaSoupisku(playerId, teamId, draftPosition) {
  try {
    if (draftPosition) {
      await prisma.player.update({
        where: { id: playerId },
        data:  { position: draftPosition },
      });
    }
    const sezona = await licence.sezonaTymu(teamId, await seasonSvc.currentSeason());
    if (!sezona) {
      console.warn(`[draft] Tým ${teamId} nemá přihlášku do sezóny — hráč ${playerId} není na soupisce`);
      return;
    }
    const vysledek = await licence.pridatDoSoupisky(playerId, teamId, sezona, { isHome: true });
    if (!vysledek?.ok && vysledek?.code !== 'ALREADY_ON_ROSTER') {
      console.error(`[draft] Zápis na soupisku selhal (${vysledek?.code}): ${vysledek?.error}`);
    }
  } catch (err) {
    console.error('[draft] Zápis na soupisku selhal:', err.message);
  }
}

/**
 * Vejde se hráč ještě na soupisku týmu? Kontroluje se **při odesílání
 * nabídky**, ne až při přijetí — jinak by se hráč dozvěděl o zamítnutí
 * teprve po 72 hodinách čekání.
 */
async function miMistoNaSoupisce(teamId, position) {
  const sezona = await licence.sezonaTymu(teamId, await seasonSvc.currentSeason());
  if (!sezona) return { ok: true };
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { isOpen: true } });
  const naSoupisce = await prisma.teamRoster.findMany({
    where: { teamId, season: sezona }, select: { slot: true },
  });
  return pocty.vejdeSeNaSoupisku(
    pocty.rozdel(naSoupisce), slotZPostu(position), pocty.limitySoupisky(team));
}

// ── Auto-expire helper – PERF-01: voláno z cron jobu v server.js, NE při každém requestu ──
async function processExpiredWindows() {
  const now = new Date();
  const expired = await prisma.draftOffer.findMany({
    where: { status: 'PENDING', isFirst: true, expiresAt: { lt: now }, profile: { isActive: true } },
    include: { profile: { include: { player: { select: { id: true, userId: true, firstName: true, lastName: true } } } }, team: { select: { name: true } } },
  });

  for (const offer of expired) {
    const profileId = offer.profileId;
    const playerId  = offer.profile.playerId;

    // Atomický claim – zabraňuje dvojímu zpracování při souběžných requestech
    const claimed = await prisma.draftOffer.updateMany({
      where: { id: offer.id, status: 'PENDING' },
      data:  { status: 'ACCEPTED' },
    });
    if (claimed.count === 0) continue;
    // Hráč vstupuje do týmu
    await prisma.player.update({ where: { id: playerId }, data: { teamId: offer.teamId } });
    await zapisNaSoupisku(playerId, offer.teamId, offer.profile.position);
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
//
// **Veřejný.** Pro hráče bez týmu je draft jediná vstupní brána do ligy,
// takže seznam musí být vidět i bez přihlášení — jinak se o něm nikdo
// nedozví. Kontaktní údaje veřejné nejsou: `phone` se do selectu vůbec
// nedostane, pokud volající není vedoucí. Nepřihlášený `req.user` je
// `undefined`, proto všude `req.user?.`.
// ────────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const isManager = (req.user?.manager ?? []).length > 0;

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

    // Profil hráči obvykle vznikl už při registraci — tohle je doplnění
    // toho, co o sobě napíše, ne první vstup do poolu. Zápis i notifikace
    // drží `services/draftPool.js`, aby se nerozešly.
    const profile = await draftPool.zapisDoPoolu(player, { bio, pubSkill, position });

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
    let profile;
    try {
      profile = await prisma.draftProfile.update({
        where: { playerId: player.id },
        data:  {
          ...(bio      !== undefined && { bio }),
          ...(pubSkill !== undefined && { pubSkill }),
          ...(position !== undefined && { position }),
        },
        include: { videos: true },
      });
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Draft profil nenalezen' });
      throw e;
    }
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

    const profile = await draftPool.odeberZPoolu(player.id);
    if (!profile) return res.status(404).json({ error: 'Draft profil nenalezen' });

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
// **Veřejný, stejně jako seznam.** Telefon dostane jen vedoucí, nabídky
// jen vlastník profilu — obojí se řeší níž, ne přihlášením.
router.get('/:playerId', optionalAuth, async (req, res, next) => {
  try {
    const isManager     = (req.user?.manager ?? []).length > 0;
    const myPlayer      = req.user
      ? await prisma.player.findUnique({ where: { userId: req.user.id } })
      : null;
    const isOwnProfile  = !!myPlayer && myPlayer.id === req.params.playerId;

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

    // Nabídka mého týmu (manager pohled) – jen PENDING, jinak banner zmátne po rejected nabídce
    let myTeamOffer = null;
    if (isManager && req.user?.manager?.[0]?.teamId) {
      myTeamOffer = await prisma.draftOffer.findFirst({
        where: { profileId: profile.id, teamId: req.user.manager[0].teamId, status: 'PENDING' },
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

    // Kontrola duplicity – blokuje jen PENDING nabídku; REJECTED/EXPIRED umožní znovu nabídnout
    const existingOffer = await prisma.draftOffer.findFirst({
      where: { profileId: profile.id, teamId: myTeamId },
    });
    if (existingOffer?.status === 'PENDING') {
      return res.status(409).json({ error: 'Váš tým již poslal nabídku tomuto hráči' });
    }
    // Smazat starou REJECTED/EXPIRED row – jinak by unique constraint blokoval CREATE
    if (existingOffer) {
      await prisma.draftOffer.delete({ where: { id: existingOffer.id } });
    }

    // Plný tým nesmí blokovat hráče na 72 hodin nabídkou, kterou stejně
    // nemůže přijmout.
    const misto = await miMistoNaSoupisce(myTeamId, profile.position);
    if (!misto.ok) {
      return res.status(409).json({ error: misto.error, code: misto.code });
    }

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

    // Atomický claim – blokuje double-tap / souběžné requesty
    const claimed = await prisma.draftOffer.updateMany({
      where: { id: offer.id, status: 'PENDING' },
      data:  { status: 'ACCEPTED' },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: 'Nabídka již byla zpracována' });
    }
    // Atomicky: zbytek vyprší + hráč do týmu + deaktivace profilu
    await prisma.$transaction([
      prisma.draftOffer.updateMany({
        where: { profileId: profile.id, status: 'PENDING' },
        data:  { status: 'EXPIRED' },
      }),
      prisma.player.update({ where: { id: player.id }, data: { teamId: offer.teamId } }),
      prisma.draftProfile.update({ where: { id: profile.id }, data: { isActive: false } }),
    ]);
    await zapisNaSoupisku(player.id, offer.teamId, profile.position);

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
module.exports.processExpiredWindows = processExpiredWindows;
