/**
 * Chat — konverzace, zprávy, žádosti, blokace, nahlášení.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`.
 *
 * **Všechno je za přihlášením a všechno je vázané na hráčský profil.**
 * Účet bez hráče (vedoucí bez profilu, rozhodčí) chat nemá — psát v lize
 * znamená být v ní hráčem.
 */

const express = require('express');
const router  = express.Router();

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const chat = require('../services/chat');
const seasonSvc = require('../services/seasonTransition');
const { createNotification } = require('./notifications');

/** Hráčský profil přihlášeného, nebo 400. */
function mujHrac(req, res) {
  const p = req.user?.player;
  if (!p) {
    res.status(400).json({ error: 'Chat je pro hráče — nejdřív dokonči registraci hráče' });
    return null;
  }
  return p;
}

const VYBER_AUTORA = {
  id: true, firstName: true, lastName: true, photoUrl: true,
};

/** Zpráva ve tvaru, v jakém ji čeká klient. */
function zpravaProKlienta(m, autoriPodleId) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    kind: m.kind,
    class: m.class,
    body: m.deletedAt ? null : m.body,
    smazano: Boolean(m.deletedAt),
    upraveno: Boolean(m.editedAt),
    payload: m.payload ?? null,
    replyToId: m.replyToId ?? null,
    createdAt: m.createdAt,
    odSupervisora: m.fromSupervisor,
    autor: chat.autorProKlienta(m.authorPlayerId ? autoriPodleId[m.authorPlayerId] : null),
    prilohy: (m.prilohy ?? []).map(p => ({
      id: p.id, url: p.url, thumbUrl: p.thumbUrl, width: p.width, height: p.height,
    })),
    reakce: (m.reakce ?? []).map(r => ({ emoji: r.emoji, playerId: r.playerId })),
  };
}

/** Doplní autory jedním dotazem, ne dotazem na hlavu. */
async function autori(zpravy) {
  const ids = [...new Set(zpravy.map(m => m.authorPlayerId).filter(Boolean))];
  if (!ids.length) return {};
  const lide = await prisma.player.findMany({
    where: { id: { in: ids } }, select: VYBER_AUTORA,
  });
  return Object.fromEntries(lide.map(p => [p.id, p]));
}

// ===========================================================================
// Seznam konverzací
// ===========================================================================

/**
 * GET /chat/conversations?filter=waiting
 *
 * `waiting` je **filtr, ne jiná obrazovka** — supervisor má tentýž seznam,
 * jen s těmi, které čekají na odpověď, nahoře.
 */
router.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);

    const clenstvi = await prisma.conversationMember.findMany({
      where: { playerId: hrac.id, removedAt: null },
      select: { conversationId: true, lastReadAt: true, mutedSocial: true },
    });
    const mojeIds = clenstvi.map(c => c.conversationId);

    const kde = req.query.filter === 'waiting' && jeSupervisor
      ? { waitingSupervisor: true }
      : { id: { in: mojeIds } };

    const konverzace = await prisma.conversation.findMany({
      where: kde,
      orderBy: [{ waitingSupervisor: 'desc' }, { lastMessageAt: 'desc' }],
      take: 100,
    });

    const cteni = Object.fromEntries(clenstvi.map(c => [c.conversationId, c.lastReadAt]));

    // Názvy jedním dotazem na každou skupinu, ne dotazem na hlavu.
    const tymy = await prisma.team.findMany({
      where: { id: { in: konverzace.map(k => k.teamId).filter(Boolean) } },
      select: { id: true, name: true },
    });
    const nazvyTymu = Object.fromEntries(tymy.map(t => [t.id, t.name]));

    const majitele = await prisma.player.findMany({
      where: { id: { in: konverzace.map(k => k.ownerPlayerId).filter(Boolean) } },
      select: VYBER_AUTORA,
    });
    const majitelPodleId = Object.fromEntries(majitele.map(p => [p.id, p]));

    // U přímých konverzací je název ten druhý člověk.
    const protejsky = await prisma.conversationMember.findMany({
      where: {
        conversationId: { in: konverzace.filter(k => k.kind === 'DIRECT').map(k => k.id) },
        playerId: { not: hrac.id },
        removedAt: null,
      },
      select: { conversationId: true, playerId: true },
    });
    const protejskiLide = await prisma.player.findMany({
      where: { id: { in: protejsky.map(p => p.playerId) } },
      select: VYBER_AUTORA,
    });
    const protejsekPodleKonverzace = Object.fromEntries(
      protejsky.map(p => [p.conversationId, protejskiLide.find(l => l.id === p.playerId)]),
    );

    /**
     * Jak se konverzace jmenuje v seznamu.
     *
     * Vlákno s ligou se jmenuje jinak podle toho, kdo se dívá: hráč vidí
     * „Liga", supervisor jméno člověka, který píše — jinak by měl frontu
     * plnou stejně pojmenovaných řádků.
     */
    function nazev(k) {
      if (k.kind === 'TEAM') return nazvyTymu[k.teamId] ?? 'Tým';
      if (k.kind === 'PANDA') return 'Panda';
      if (k.kind === 'SUPPORT') {
        if (k.ownerPlayerId === hrac.id) return 'Liga';
        const p = majitelPodleId[k.ownerPlayerId];
        return p ? `${p.firstName} ${p.lastName}` : 'Hráč';
      }
      const d = protejsekPodleKonverzace[k.id];
      return d ? `${d.firstName} ${d.lastName}` : 'Konverzace';
    }

    const vysledek = [];
    for (const k of konverzace) {
      const posledni = await prisma.message.findFirst({
        where: { conversationId: k.id },
        orderBy: { createdAt: 'desc' },
        select: { body: true, createdAt: true, authorPlayerId: true, deletedAt: true },
      });
      const od = cteni[k.id];
      const neprectene = await prisma.message.count({
        where: {
          conversationId: k.id,
          deletedAt: null,
          ...(od ? { createdAt: { gt: od } } : {}),
          NOT: { authorPlayerId: hrac.id },
        },
      });
      vysledek.push({
        id: k.id,
        kind: k.kind,
        teamId: k.teamId,
        nazev: nazev(k),
        protejsek: k.kind === 'DIRECT'
          ? chat.autorProKlienta(protejsekPodleKonverzace[k.id] ?? null)
          : null,
        cekaNaLigu: k.waitingSupervisor,
        dueAt: k.dueAt,
        lastMessageAt: k.lastMessageAt,
        neprectene,
        nahled: posledni?.deletedAt ? null : (posledni?.body ?? null),
      });
    }
    res.json(vysledek);
  } catch (err) { next(err); }
});

// ===========================================================================
// Zprávy
// ===========================================================================

router.get('/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);
    if (!jeSupervisor && !(await chat.jeClen(req.params.id, hrac.id))) {
      return res.status(403).json({ error: 'Do téhle konverzace nevidíš' });
    }

    const before = req.query.before ? new Date(req.query.before) : null;
    const zpravy = await prisma.message.findMany({
      where: { conversationId: req.params.id, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const ids = zpravy.map(z => z.id);
    const [prilohy, reakce] = await Promise.all([
      prisma.messageAttachment.findMany({ where: { messageId: { in: ids } } }),
      prisma.messageReaction.findMany({ where: { messageId: { in: ids } } }),
    ]);
    const podleId = await autori(zpravy);
    const obohacene = zpravy.map(z => ({
      ...z,
      prilohy: prilohy.filter(p => p.messageId === z.id),
      reakce:  reakce.filter(r => r.messageId === z.id),
    }));
    res.json(obohacene.reverse().map(z => zpravaProKlienta(z, podleId)));
  } catch (err) { next(err); }
});

router.post('/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const { body, replyToId, attachmentIds } = req.body ?? {};
    const text = (body ?? '').trim();
    if (!text && !(attachmentIds?.length)) {
      return res.status(400).json({ error: 'Prázdnou zprávu poslat nejde' });
    }

    const konverzace = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!konverzace) return res.status(404).json({ error: 'Konverzace nenalezena' });

    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);
    const clen = await chat.jeClen(konverzace.id, hrac.id);
    if (!clen && !jeSupervisor) {
      return res.status(403).json({ error: 'Do téhle konverzace psát nemůžeš' });
    }

    // Umlčený nepíše nikam — kromě konverzace s ligou, kde se musí umět bránit.
    if (konverzace.kind !== 'SUPPORT' && await chat.maSankci(hrac.id, 'MUTE')) {
      return res.status(403).json({ error: 'Máš dočasně pozastavené psaní v chatu' });
    }

    const zprava = await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: hrac.id,
        fromSupervisor: jeSupervisor && konverzace.kind === 'SUPPORT',
        body: text,
        replyToId: replyToId ?? null,
        class: 'SPOLECENSKA',
      },
    });

    if (attachmentIds?.length) {
      await prisma.messageAttachment.updateMany({
        where: { id: { in: attachmentIds }, messageId: '' },
        data: { messageId: zprava.id },
      });
    }

    const data = { lastMessageAt: new Date() };
    // Odpověď supervisora je to jediné, co shodí příznak „čeká na ligu".
    if (konverzace.kind === 'SUPPORT' && jeSupervisor && konverzace.waitingSupervisor) {
      data.waitingSupervisor = false;
      data.dueAt = null;
      data.overdueNotifiedAt = null;
      await prisma.conversation.update({ where: { id: konverzace.id }, data });
      const majitel = konverzace.ownerPlayerId
        ? await prisma.player.findUnique({ where: { id: konverzace.ownerPlayerId }, select: { userId: true } })
        : null;
      if (majitel?.userId) {
        await createNotification(majitel.userId, 'Odpověď z ligy', text.slice(0, 120), 'chat');
      }
    } else {
      await prisma.conversation.update({ where: { id: konverzace.id }, data });
    }

    const podleId = await autori([zprava]);
    res.status(201).json(zpravaProKlienta({ ...zprava, prilohy: [], reakce: [] }, podleId));
  } catch (err) { next(err); }
});

/** Úprava vlastní zprávy. */
router.patch('/messages/:id', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const z = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!z || z.deletedAt) return res.status(404).json({ error: 'Zpráva nenalezena' });
    if (z.authorPlayerId !== hrac.id) return res.status(403).json({ error: 'Cizí zprávu upravit nejde' });
    const text = (req.body?.body ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Prázdnou zprávu uložit nejde' });
    const upravena = await prisma.message.update({
      where: { id: z.id }, data: { body: text, editedAt: new Date() },
    });
    const podleId = await autori([upravena]);
    res.json(zpravaProKlienta({ ...upravena, prilohy: [], reakce: [] }, podleId));
  } catch (err) { next(err); }
});

/**
 * Smazání vlastní zprávy.
 *
 * **Text zůstává v databázi.** Bez toho nejde posoudit nahlášení něčeho, co
 * pisatel hned po odeslání smazal. Klientům se už nevrací.
 */
router.delete('/messages/:id', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);
    const z = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!z) return res.status(404).json({ error: 'Zpráva nenalezena' });
    if (z.authorPlayerId !== hrac.id && !jeSupervisor) {
      return res.status(403).json({ error: 'Cizí zprávu smazat nejde' });
    }
    await prisma.message.update({
      where: { id: z.id },
      data: { deletedAt: new Date(), deletedById: hrac.id },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ===========================================================================
// Reakce, přečteno, umlčení
// ===========================================================================

router.post('/messages/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const emoji = (req.body?.emoji ?? '').trim();
    if (!emoji) return res.status(400).json({ error: 'Chybí emoji' });
    await prisma.messageReaction.upsert({
      where: { messageId_playerId_emoji: { messageId: req.params.id, playerId: hrac.id, emoji } },
      create: { messageId: req.params.id, playerId: hrac.id, emoji },
      update: {},
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/messages/:id/reactions/:emoji', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    await prisma.messageReaction.deleteMany({
      where: { messageId: req.params.id, playerId: hrac.id, emoji: req.params.emoji },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/conversations/:id/read', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    await prisma.conversationMember.updateMany({
      where: { conversationId: req.params.id, playerId: hrac.id },
      data: { lastReadAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Umlčení se týká JEN společenských zpráv. Provozní chodí dál. */
router.put('/conversations/:id/mute', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    await prisma.conversationMember.updateMany({
      where: { conversationId: req.params.id, playerId: hrac.id },
      data: { mutedSocial: Boolean(req.body?.muted) },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ===========================================================================
// Přímé zprávy a žádosti o chat
// ===========================================================================

router.post('/direct/:playerId', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const komu = req.params.playerId;
    const verdikt = await chat.muzePsat(hrac.id, komu);

    if (verdikt === 'NE') {
      return res.status(403).json({ error: 'Tomuhle člověku psát nemůžeš' });
    }
    if (verdikt === 'ZADOST') {
      const text = (req.body?.body ?? '').trim();
      if (!text) return res.status(400).json({ error: 'Žádost o chat musí mít zprávu' });
      const stara = await prisma.chatRequest.findUnique({
        where: { fromPlayerId_toPlayerId: { fromPlayerId: hrac.id, toPlayerId: komu } },
      });
      // Odmítnutou žádost jde poslat znovu až po 30 dnech, jinak je to
      // obcházení blokace.
      if (stara) {
        const stari = Date.now() - stara.createdAt.getTime();
        if (stara.status === 'PENDING') return res.status(409).json({ error: 'Žádost už čeká na odpověď' });
        if (stara.status === 'DECLINED' && stari < 30 * 24 * 3600 * 1000) {
          return res.status(409).json({ error: 'Žádost byla odmítnuta, zkus to nejdřív za měsíc' });
        }
        await prisma.chatRequest.delete({ where: { id: stara.id } });
      }
      const zadost = await prisma.chatRequest.create({
        data: { fromPlayerId: hrac.id, toPlayerId: komu, body: text },
      });
      const cil = await prisma.player.findUnique({ where: { id: komu }, select: { userId: true } });
      if (cil?.userId) {
        await createNotification(cil.userId, 'Žádost o chat',
          `${hrac.firstName} ${hrac.lastName} ti chce napsat`, 'chat');
      }
      return res.status(202).json({ zadost: true, id: zadost.id });
    }

    const konverzace = await chat.primaKonverzace(hrac.id, komu);
    res.json({ zadost: false, id: konverzace.id });
  } catch (err) { next(err); }
});

router.get('/requests', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const zadosti = await prisma.chatRequest.findMany({
      where: { toPlayerId: hrac.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    const lide = await prisma.player.findMany({
      where: { id: { in: zadosti.map(z => z.fromPlayerId) } }, select: VYBER_AUTORA,
    });
    const podleId = Object.fromEntries(lide.map(p => [p.id, p]));
    res.json(zadosti.map(z => ({
      id: z.id, body: z.body, createdAt: z.createdAt,
      od: chat.autorProKlienta(podleId[z.fromPlayerId]),
    })));
  } catch (err) { next(err); }
});

router.post('/requests/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const z = await prisma.chatRequest.findUnique({ where: { id: req.params.id } });
    if (!z || z.toPlayerId !== hrac.id) return res.status(404).json({ error: 'Žádost nenalezena' });
    await prisma.chatRequest.update({ where: { id: z.id }, data: { status: 'ACCEPTED' } });
    const konverzace = await chat.primaKonverzace(z.fromPlayerId, z.toPlayerId);
    await prisma.message.create({
      data: { conversationId: konverzace.id, authorPlayerId: z.fromPlayerId, body: z.body },
    });
    res.json({ id: konverzace.id });
  } catch (err) { next(err); }
});

router.post('/requests/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const z = await prisma.chatRequest.findUnique({ where: { id: req.params.id } });
    if (!z || z.toPlayerId !== hrac.id) return res.status(404).json({ error: 'Žádost nenalezena' });
    await prisma.chatRequest.update({ where: { id: z.id }, data: { status: 'DECLINED' } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ===========================================================================
// Blokace a nahlášení
// ===========================================================================

router.post('/block/:playerId', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    await prisma.chatBlock.upsert({
      where: { blockerId_blockedId: { blockerId: hrac.id, blockedId: req.params.playerId } },
      create: { blockerId: hrac.id, blockedId: req.params.playerId },
      update: {},
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/block/:playerId', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    await prisma.chatBlock.deleteMany({
      where: { blockerId: hrac.id, blockedId: req.params.playerId },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Nahlášení zprávy nebo profilu.
 *
 * Nahlášení je **jediný klíč**, kterým se liga dostane k cizí zprávě.
 * Podklad k rozhodnutí skládá až Panda (E2); zatím se jen zakládá záznam.
 */
router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const { messageId, subjectId, reason, target } = req.body ?? {};
    const duvod = (reason ?? '').trim();
    if (!duvod) return res.status(400).json({ error: 'Napiš, co je špatně' });

    let koho = subjectId ?? null;
    if (messageId) {
      const z = await prisma.message.findUnique({ where: { id: messageId } });
      if (!z) return res.status(404).json({ error: 'Zpráva nenalezena' });
      koho = z.authorPlayerId;
    }
    if (!koho) return res.status(400).json({ error: 'Chybí, koho se hlášení týká' });

    const zaznam = await prisma.chatReport.create({
      data: {
        target: target === 'PROFILE' ? 'PROFILE' : 'MESSAGE',
        messageId: messageId ?? null,
        reporterId: hrac.id,
        subjectId: koho,
        reason: duvod,
      },
    });
    res.status(201).json({ id: zaznam.id });
  } catch (err) { next(err); }
});

// ===========================================================================
// Hledání lidí
// ===========================================================================

/**
 * GET /chat/people?q=
 *
 * Vrací **jméno, fotku, post, tým a `canMessage`. Nic víc** — a hlavně nikdy
 * telefon, i když ho hráč v profilu má.
 */
router.get('/people', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return res.json([]);

    const lide = await prisma.player.findMany({
      where: {
        id: { not: hrac.id },
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName:  { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { ...VYBER_AUTORA, position: true, team: { select: { id: true, name: true } } },
      take: 20,
    });

    const vysledek = [];
    for (const p of lide) {
      const verdikt = await chat.muzePsat(hrac.id, p.id);
      if (verdikt === 'NE') continue;
      vysledek.push({
        ...chat.autorProKlienta(p),
        post: p.position,
        tym: p.team ? { id: p.team.id, name: p.team.name } : null,
        canMessage: verdikt,
      });
    }
    res.json(vysledek);
  } catch (err) { next(err); }
});

// ===========================================================================
// Týmová konverzace a její členové
// ===========================================================================

/**
 * GET /chat/team/:teamId
 *
 * Vrátí konverzaci týmu a cestou do ní doplní lidi ze soupisky. Zakládá se
 * líně — první člověk, který chat otevře, ho tím vyrobí.
 */
router.get('/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const teamId = req.params.teamId;

    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);
    const vedouci = await chat.jeVedouci(req.user.id, teamId);
    const naSoupisce = await prisma.teamRoster.findFirst({
      where: { teamId, playerId: hrac.id }, select: { id: true },
    });
    if (!jeSupervisor && !vedouci && !naSoupisce && hrac.teamId !== teamId) {
      return res.status(403).json({ error: 'Do chatu cizího týmu nevidíš' });
    }

    const season = await seasonSvc.currentSeason();
    if (season) await chat.synchronizujCleny(teamId, season);
    const konverzace = await chat.tymovaKonverzace(teamId);

    const clenove = await prisma.conversationMember.findMany({
      where: { conversationId: konverzace.id, removedAt: null },
      select: { playerId: true },
    });
    const lide = await prisma.player.findMany({
      where: { id: { in: clenove.map(c => c.playerId) } }, select: VYBER_AUTORA,
    });

    res.json({
      id: konverzace.id,
      kind: konverzace.kind,
      clenove: lide.map(p => chat.autorProKlienta(p)),
      spravujeClenstvi: vedouci || jeSupervisor,
    });
  } catch (err) { next(err); }
});

/** Kdo smí sahat na členy týmové konverzace: vedoucí, u otevřených supervisor. */
async function smiSpravovat(req, konverzace) {
  const hrac = req.user?.player;
  const jeSupervisor = Boolean(req.user?.isSupervisor || hrac?.isSupervisor);
  if (jeSupervisor) return true;
  if (!konverzace.teamId) return false;
  const tym = await prisma.team.findUnique({
    where: { id: konverzace.teamId }, select: { isOpen: true },
  });
  if (tym?.isOpen) return false;          // otevřený tým vedoucího nemá
  return chat.jeVedouci(req.user.id, konverzace.teamId);
}

router.post('/conversations/:id/members', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const konverzace = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!konverzace || konverzace.kind !== 'TEAM') {
      return res.status(404).json({ error: 'Týmová konverzace nenalezena' });
    }
    if (!(await smiSpravovat(req, konverzace))) {
      return res.status(403).json({ error: 'Členy týmové konverzace spravuje vedoucí' });
    }
    const playerId = req.body?.playerId;
    if (!playerId) return res.status(400).json({ error: 'Chybí hráč' });

    const pridavany = await prisma.player.findUnique({
      where: { id: playerId }, select: { id: true, teamId: true },
    });
    if (!pridavany) return res.status(404).json({ error: 'Hráč nenalezen' });

    const season = await seasonSvc.currentSeason();
    const naSoupisce = season
      ? await prisma.teamRoster.findFirst({
          where: { teamId: konverzace.teamId, playerId, season }, select: { id: true },
        })
      : null;
    if (!naSoupisce && pridavany.teamId !== konverzace.teamId) {
      return res.status(400).json({ error: 'Do týmového chatu patří jen hráči toho týmu' });
    }

    await prisma.conversationMember.upsert({
      where: { conversationId_playerId: { conversationId: konverzace.id, playerId } },
      create: { conversationId: konverzace.id, playerId, addedById: hrac.id },
      update: { removedAt: null, addedById: hrac.id },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Odebrání z týmové konverzace.
 *
 * **Není to vyřazení ze zápasu.** Přihlašování, uzávěrka i výzvy chodí
 * odebranému dál — vedoucí nesmí být schopen odstřihnout hráče od
 * informací k zápasu, za který zaplatil.
 */
router.delete('/conversations/:id/members/:playerId', requireAuth, async (req, res, next) => {
  try {
    const hrac = mujHrac(req, res); if (!hrac) return;
    const konverzace = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!konverzace || konverzace.kind !== 'TEAM') {
      return res.status(404).json({ error: 'Týmová konverzace nenalezena' });
    }
    if (!(await smiSpravovat(req, konverzace))) {
      return res.status(403).json({ error: 'Členy týmové konverzace spravuje vedoucí' });
    }
    await prisma.conversationMember.updateMany({
      where: { conversationId: konverzace.id, playerId: req.params.playerId },
      data: { removedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
