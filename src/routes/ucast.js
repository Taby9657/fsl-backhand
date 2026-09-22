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
const seasonSvc = require('../services/seasonTransition');

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

module.exports = router;
