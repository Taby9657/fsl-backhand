/**
 * Hraju / Nemůžu — přihlašování hráčů na zápas.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 1.7.
 *
 * **Tohle je ten nejdůležitější knoflík v celé aplikaci.** Z něj se počítá
 * „sejde se 7/9", na něm stojí uzávěrka i všechno, co Panda před zápasem
 * píše. Je proto obecný, ne jen pro otevřené týmy: klubový vedoucí ho
 * využije stejně a přestane honit sestavu po WhatsAppu.
 *
 * Dvě pravidla, která se tu vynucují:
 *   · **48 h před výkopem se zavírá.** Po uzávěrce už nikdo nemění, jinak
 *     by se sestava rozpadala na poslední chvíli.
 *   · **Přihlásit se smí jen člověk z toho týmu** — soupiska sezóny, nebo
 *     kmenový tým. Členství v chatu s tím nemá nic společného; kdo je
 *     z konverzace odebraný, na zápas se přihlásit může.
 */

const express = require('express');
const router  = express.Router();

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const chat = require('../services/chat');
const zapisovatel = require('../services/zapisovatel');
const seasonSvc = require('../services/seasonTransition');
const { createNotifications } = require('./notifications');

/** Za který tým hráč v tomhle zápase nastupuje? Null = za žádný. */
async function tymVZapase(zapas, playerId, playerTeamId) {
  const rostery = await prisma.teamRoster.findMany({
    where: {
      playerId,
      season: zapas.season,
      teamId: { in: [zapas.homeTeamId, zapas.awayTeamId] },
    },
    select: { teamId: true, slot: true },
  });
  if (rostery.length === 1) return rostery[0];
  if (rostery.length > 1) {
    // Hostující hráč může být na obou soupiskách; rozhodne kmenový tým.
    const kmenovy = rostery.find(r => r.teamId === playerTeamId);
    return kmenovy ?? rostery[0];
  }
  if (playerTeamId === zapas.homeTeamId || playerTeamId === zapas.awayTeamId) {
    return { teamId: playerTeamId, slot: 'FIELD' };
  }
  return null;
}

/** POST /matches/:id/signup — { playing: true | false } */
router.post('/:id/signup', requireAuth, async (req, res, next) => {
  try {
    const hrac = req.user?.player;
    if (!hrac) return res.status(400).json({ error: 'Na zápas se přihlašují hráči' });

    const zapas = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!zapas) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (zapas.status !== 'UPCOMING') {
      return res.status(409).json({ error: 'Tenhle zápas už se nehraje dopředu' });
    }

    const muj = await tymVZapase(zapas, hrac.id, hrac.teamId);
    if (!muj) return res.status(403).json({ error: 'V tomhle zápase nehraješ' });

    const konec = chat.uzaverka(zapas.date);
    if (Date.now() > konec.getTime()) {
      return res.status(409).json({
        error: 'Sestava je uzavřená — 48 hodin před zápasem se zamyká',
        uzaverka: konec,
      });
    }

    const playing = Boolean(req.body?.playing);
    await prisma.matchSignup.upsert({
      where: { matchId_playerId: { matchId: zapas.id, playerId: hrac.id } },
      create: { matchId: zapas.id, playerId: hrac.id, playing },
      update: { playing },
    });

    res.json({ playing, teamId: muj.teamId, uzaverka: konec });
  } catch (err) { next(err); }
});

/**
 * GET /matches/:id/signups?teamId=
 *
 * Stav sestavy jednoho týmu. **Vidí ho jen ten tým a supervisor** — kdo se
 * nepřihlásil, je vnitřní věc týmu a soupeři do toho nic není.
 */
router.get('/:id/signups', requireAuth, async (req, res, next) => {
  try {
    const hrac = req.user?.player;
    if (!hrac) return res.status(400).json({ error: 'Jen pro hráče' });
    const jeSupervisor = Boolean(req.user.isSupervisor || hrac.isSupervisor);

    const zapas = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!zapas) return res.status(404).json({ error: 'Zápas nenalezen' });

    const muj = await tymVZapase(zapas, hrac.id, hrac.teamId);
    const teamId = req.query.teamId || muj?.teamId;
    if (!teamId) return res.status(400).json({ error: 'Chybí tým' });

    const vedouci = await chat.jeVedouci(req.user.id, teamId);
    if (!jeSupervisor && !vedouci && muj?.teamId !== teamId) {
      return res.status(403).json({ error: 'Do sestavy cizího týmu nevidíš' });
    }

    const soupiska = await prisma.teamRoster.findMany({
      where: { teamId, season: zapas.season },
      select: { playerId: true, slot: true },
    });
    const idsSoupisky = soupiska.map(r => r.playerId);
    const kmenovi = await prisma.player.findMany({
      where: { teamId }, select: { id: true },
    });
    const vsichni = [...new Set([...idsSoupisky, ...kmenovi.map(p => p.id)])];

    const [lide, prihlasky] = await Promise.all([
      prisma.player.findMany({
        where: { id: { in: vsichni } },
        select: { id: true, firstName: true, lastName: true, photoUrl: true },
      }),
      prisma.matchSignup.findMany({
        where: { matchId: zapas.id, playerId: { in: vsichni } },
        select: { playerId: true, playing: true },
      }),
    ]);

    const slotPodleId = Object.fromEntries(soupiska.map(r => [r.playerId, r.slot]));
    const stavPodleId = Object.fromEntries(prihlasky.map(p => [p.playerId, p.playing]));

    const seznam = lide.map(p => ({
      ...chat.autorProKlienta(p),
      slot: slotPodleId[p.id] ?? 'FIELD',
      stav: p.id in stavPodleId ? (stavPodleId[p.id] ? 'HRAJU' : 'NEMUZU') : 'MLCI',
    }));

    const prihlaseni = seznam.filter(p => p.stav === 'HRAJU');
    const brankari  = prihlaseni.filter(p => p.slot === 'GOALKEEPER').length;

    res.json({
      matchId: zapas.id,
      teamId,
      datum: zapas.date,
      uzaverka: chat.uzaverka(zapas.date),
      uzavreno: Date.now() > chat.uzaverka(zapas.date).getTime(),
      pocet: prihlaseni.length,
      potreba: chat.MIN_HRACU,
      stav: `${prihlaseni.length}/${chat.MIN_HRACU}`,
      brankari,
      chybiBrankar: brankari < chat.MIN_BRANKARU,
      sejdeSe: prihlaseni.length >= chat.MIN_HRACU && brankari >= chat.MIN_BRANKARU,
      seznam,
    });
  } catch (err) { next(err); }
});

/* ═══════════════════════════════════════════════════════════════════
   ZAPISOVATEL — losování a přehled (zadání, oddíl 9)
   ═══════════════════════════════════════════════════════════════════ */

/** Jméno hráče do textu karty. */
const jmeno = (h) => `${h.firstName} ${h.lastName}`;

/**
 * Smí tenhle člověk losovat v tomhle týmu?
 *
 * Vedoucí daného týmu, nebo supervisor. **U otevřeného týmu supervisor** —
 * živého vedoucího tam nikdo nemá.
 */
async function smiLosovat(req, tym) {
  if (req.user?.isSupervisor || req.user?.player?.isSupervisor) return true;
  if (tym.isOpen) return false;
  return chat.jeVedouci(req.user.id, tym.id);
}

/**
 * POST /matches/:id/scorekeeper/draw
 * body: { teamId?, excludePlayerIds?: string[], reason?: string }
 *
 * `reason` se zapíše **předchozímu** vylosovanému — „nedorazil", jinak
 * „další los".
 */
router.post('/:id/scorekeeper/draw', requireAuth, async (req, res, next) => {
  try {
    const zapas = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!zapas) return res.status(404).json({ error: 'Zápas nenalezen' });

    const teamId = req.body?.teamId || req.user?.player?.teamId;
    if (!teamId) return res.status(400).json({ error: 'Chybí tým' });
    if (teamId !== zapas.homeTeamId && teamId !== zapas.awayTeamId) {
      return res.status(400).json({ error: 'Tenhle tým v zápase nehraje' });
    }

    const tym = await prisma.team.findUnique({ where: { id: teamId } });
    if (!tym) return res.status(404).json({ error: 'Tým nenalezen' });
    if (!(await smiLosovat(req, tym))) {
      return res.status(403).json({ error: 'Losovat smí vedoucí týmu nebo liga' });
    }

    // Z čeho se losuje: odeslaná sestava má přednost před přihláškami.
    const sestavaDb = await prisma.lineupSubmission.findUnique({
      where: { matchId_teamId: { matchId: zapas.id, teamId } },
      include: { players: { select: { playerId: true, isGoalkeeper: true } } },
    });
    const sestava = sestavaDb?.players ?? [];

    let prihlaseni = [];
    if (!sestava.length) {
      const rows = await prisma.matchSignup.findMany({
        where: { matchId: zapas.id, playing: true },
        select: { playerId: true },
      });
      const soupiska = await prisma.teamRoster.findMany({
        where: { teamId, season: zapas.season, playerId: { in: rows.map(r => r.playerId) } },
        select: { playerId: true, slot: true },
      });
      const kmenovi = await prisma.player.findMany({
        where: { teamId, id: { in: rows.map(r => r.playerId) } },
        select: { id: true },
      });
      // Přihlášky nenesou tým — profiltrují se soupiskou sezóny a kmenovým
      // týmem, jinak by se do losu dostal soupeř.
      const naseIds = new Set([...soupiska.map(r => r.playerId), ...kmenovi.map(p => p.id)]);
      const slot = Object.fromEntries(soupiska.map(r => [r.playerId, r.slot]));
      prihlaseni = rows
        .filter(r => naseIds.has(r.playerId))
        .map(r => ({ playerId: r.playerId, brankar: slot[r.playerId] === 'GOALKEEPER' }));
    }

    const predchozi = await prisma.matchScorekeeper.findMany({
      where: { matchId: zapas.id, teamId },
      orderBy: { drawNo: 'desc' },
    });
    const posledni = predchozi[0] ?? null;

    const vyrazeni = Array.isArray(req.body?.excludePlayerIds) ? req.body.excludePlayerIds : [];
    const seznam = zapisovatel.kandidati({
      sestava,
      prihlaseni,
      vyrazeni,
      drive: predchozi.map(p => p.playerId),
    });

    if (!seznam.length) {
      return res.status(409).json({
        error: sestava.length || prihlaseni.length
          ? 'Není z koho losovat — všichni z pole už losovaní nebo vyřazení'
          : 'Zatím se nikdo nepřihlásil, losovat není z koho',
      });
    }

    const vybranyId = zapisovatel.vyber(seznam);
    const drawNo = (posledni?.drawNo ?? 0) + 1;

    // Předchozímu se zapíše, proč skončil. Řádek se nemaže — bez historie
    // by z losu byl výběr.
    if (posledni && !posledni.replacedAt) {
      await prisma.matchScorekeeper.update({
        where: { id: posledni.id },
        data: {
          replacedAt: new Date(),
          replaceReason: (req.body?.reason || '').trim() || 'další los',
        },
      });
    }

    const zaznam = await prisma.matchScorekeeper.create({
      data: {
        matchId: zapas.id, teamId, playerId: vybranyId,
        source: 'DRAW', drawNo,
        candidates: seznam,
        excluded: vyrazeni.length ? vyrazeni : undefined,
        requestedById: req.user.id,
      },
    });

    const lide = await prisma.player.findMany({
      where: { id: { in: [vybranyId, posledni?.playerId].filter(Boolean) } },
      select: { id: true, firstName: true, lastName: true, userId: true },
    });
    const vybrany = lide.find(h => h.id === vybranyId);
    const drivejsi = posledni ? lide.find(h => h.id === posledni.playerId) : null;

    const text = zapisovatel.textKarty({
      jmeno: jmeno(vybrany),
      drawNo,
      pocetKandidatu: seznam.length,
      predchozi: drivejsi ? jmeno(drivejsi) : null,
      duvod: posledni && !posledni.replacedAt
        ? ((req.body?.reason || '').trim() || 'další los')
        : null,
    });

    // Karta jde do týmového chatu jako SYSTEM, ne jako Pandina zpráva:
    // losování běží i při vypnuté Pandě a nemá proč mluvit jejím hlasem.
    const konverzace = await chat.tymovaKonverzace(teamId);
    const karta = await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: null,
        kind: 'SYSTEM',
        class: 'PROVOZNI',
        body: text,
        payload: {
          typ: 'los', matchId: zapas.id, teamId, drawNo,
          vysledek: vybranyId, kandidati: seznam,
        },
      },
    });
    await prisma.conversation.update({
      where: { id: konverzace.id },
      data: { lastMessageAt: karta.createdAt },
    });

    // Vylosovaný to musí vědět, i kdyby chat neotevřel. E-mail se neposílá
    // (zadání, oddíl 7) — je to zpráva do aplikace, ne úřední dopis.
    if (vybrany.userId) {
      await createNotifications([{
        userId: vybrany.userId,
        title: 'Zapisuješ zápas',
        body: text,
        screen: 'chat',
      }]);
    }

    res.status(201).json({
      id: zaznam.id, matchId: zapas.id, teamId, drawNo,
      zapisuje: { id: vybrany.id, jmeno: jmeno(vybrany) },
      kandidatu: seznam.length,
      text,
    });
  } catch (err) { next(err); }
});

/**
 * GET /matches/:id/scorekeeper?teamId=
 *
 * Kdo zapisuje a jak se k tomu došlo. **Historie losů jde ven celá** —
 * to je celý smysl: kdo chce, ať si zpětně ověří, že se nelosovalo
 * dokolečka, dokud nevyšel ten pravý.
 */
router.get('/:id/scorekeeper', requireAuth, async (req, res, next) => {
  try {
    const zapas = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!zapas) return res.status(404).json({ error: 'Zápas nenalezen' });

    const teamId = req.query.teamId || req.user?.player?.teamId;
    if (!teamId) return res.status(400).json({ error: 'Chybí tým' });

    const jeSupervisor = Boolean(req.user?.isSupervisor || req.user?.player?.isSupervisor);
    const muj = req.user?.player?.teamId === teamId;
    const vedouci = await chat.jeVedouci(req.user.id, teamId);
    if (!jeSupervisor && !vedouci && !muj) {
      return res.status(403).json({ error: 'Do cizího týmu nevidíš' });
    }

    const radky = await prisma.matchScorekeeper.findMany({
      where: { matchId: zapas.id, teamId },
      orderBy: { drawNo: 'asc' },
    });
    const lide = await prisma.player.findMany({
      where: { id: { in: radky.map(r => r.playerId) } },
      select: { id: true, firstName: true, lastName: true, photoUrl: true },
    });
    const podleId = Object.fromEntries(lide.map(h => [h.id, h]));

    const historie = radky.map(r => ({
      drawNo: r.drawNo,
      source: r.source,
      hrac: podleId[r.playerId] ? chat.autorProKlienta(podleId[r.playerId]) : null,
      kandidatu: Array.isArray(r.candidates) ? r.candidates.length : 0,
      assignedAt: r.assignedAt,
      replacedAt: r.replacedAt,
      replaceReason: r.replaceReason,
    }));
    const platny = historie.filter(h => !h.replacedAt).pop() ?? null;

    res.json({ matchId: zapas.id, teamId, zapisuje: platny?.hrac ?? null, historie });
  } catch (err) { next(err); }
});

module.exports = router;
