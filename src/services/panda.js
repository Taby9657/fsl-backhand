/**
 * Panda — plánovač zpráv kolem zápasu.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 8.1.
 *
 * **Tady nerozhoduje žádný model.** Cron projde zápasy, spočítá stav
 * a vyrobí událost; text zatím skládá pevná šablona. Až přijde jazykový
 * model (E2), bude jen přepisovat tyhle texty — a když nebude dostupný,
 * odejde zase šablona. Proto se do Pandy nesmí dostat událost, pro kterou
 * šablona neexistuje.
 *
 * Dvě věci, na kterých to stojí:
 *
 * 1. **Každá událost se zapíše do `PandaEvent` a vyrobí se jednou.** Cron je
 *    budík, ne frekvence psaní.
 * 2. **Vypnutá Panda událost ZAHODÍ (`SKIPPED`), neodloží.** Bez toho by
 *    plánovač po zapnutí našel týden neobsloužených událostí a vysypal je
 *    naráz — a vedoucí by si ji podruhé nezapnul.
 */

const prisma = require('../lib/prisma');
const chat = require('./chat');
const { createNotification } = require('../routes/notifications');

const HODINA = 3600 * 1000;
const DEN = 24 * HODINA;

const { SABLONY, kdy } = require('./panda-texty');

// ---------------------------------------------------------------------------
// Doručení
// ---------------------------------------------------------------------------

/**
 * Pošle zprávu týmu podle vypínače.
 *
 *   FULL   → do týmového chatu
 *   LEADER → jen vedoucímu do jeho vlákna s Pandou (tým o ní neví)
 *   OFF    → nic, událost se zahodí
 */
async function posliTymu(teamId, text) {
  const tym = await prisma.team.findUnique({
    where: { id: teamId },
    select: { id: true, isOpen: true, pandaMode: true },
  });
  if (!tym) return { stav: 'SKIPPED', messageId: null };

  // Otevřený tým vedoucího nemá — tam Panda mluví vždycky.
  const rezim = tym.isOpen ? 'FULL' : tym.pandaMode;
  if (rezim === 'OFF') return { stav: 'SKIPPED', messageId: null };

  if (rezim === 'FULL') {
    const konverzace = await chat.tymovaKonverzace(teamId);
    const zprava = await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: chat.PANDA,
        class: 'PROVOZNI',
        body: text,
      },
    });
    await prisma.conversation.update({
      where: { id: konverzace.id }, data: { lastMessageAt: new Date() },
    });
    await upozorniCleny(konverzace.id, text);
    return { stav: 'SENT', messageId: zprava.id };
  }

  // LEADER
  const vedouci = await prisma.manager.findMany({
    where: { teamId },
    select: { userId: true, user: { select: { player: { select: { id: true } } } } },
  });
  let messageId = null;
  for (const v of vedouci) {
    const playerId = v.user?.player?.id;
    if (playerId) {
      const vlakno = await chat.vlaknoSPandou(playerId);
      const zprava = await prisma.message.create({
        data: {
          conversationId: vlakno.id,
          authorPlayerId: chat.PANDA,
          class: 'PROVOZNI',
          body: text,
        },
      });
      await prisma.conversation.update({
        where: { id: vlakno.id }, data: { lastMessageAt: new Date() },
      });
      messageId = messageId ?? zprava.id;
    }
    await createNotification(v.userId, 'Tvůj tým', text, 'chat');
  }
  return { stav: 'SENT', messageId };
}

/** Oznámení členům konverzace. Ne e-mail — ten řeší až uzávěrka a platby. */
async function upozorniCleny(conversationId, text) {
  const clenove = await prisma.conversationMember.findMany({
    where: { conversationId, removedAt: null },
    select: { playerId: true },
  });
  const hraci = await prisma.player.findMany({
    where: { id: { in: clenove.map(c => c.playerId) }, userId: { not: null } },
    select: { userId: true },
  });
  for (const h of hraci) {
    await createNotification(h.userId, 'Tvůj tým', text.slice(0, 120), 'chat');
  }
}

// ---------------------------------------------------------------------------
// Stav sestavy
// ---------------------------------------------------------------------------

async function stavSestavy(zapas, teamId) {
  const soupiska = await prisma.teamRoster.findMany({
    where: { teamId, season: zapas.season },
    select: { playerId: true, slot: true },
  });
  const kmenovi = await prisma.player.findMany({ where: { teamId }, select: { id: true } });
  const vsichni = [...new Set([...soupiska.map(r => r.playerId), ...kmenovi.map(p => p.id)])];

  const prihlasky = await prisma.matchSignup.findMany({
    where: { matchId: zapas.id, playerId: { in: vsichni }, playing: true },
    select: { playerId: true },
  });
  const slot = Object.fromEntries(soupiska.map(r => [r.playerId, r.slot]));
  const brankari = prihlasky.filter(p => slot[p.playerId] === 'GOALKEEPER').length;

  return {
    pocet: prihlasky.length,
    brankari,
    stav: `${prihlasky.length}/${chat.MIN_HRACU}`,
    sejdeSe: prihlasky.length >= chat.MIN_HRACU && brankari >= chat.MIN_BRANKARU,
  };
}

// ---------------------------------------------------------------------------
// Plánovač
// ---------------------------------------------------------------------------

/** Vyrobí událost, pokud ještě nebyla. Vrací true, když se něco stalo. */
async function jednou(key, teamId, akce) {
  const uz = await prisma.pandaEvent.findUnique({ where: { key }, select: { key: true } });
  if (uz) return false;

  const { stav, messageId } = await akce();
  await prisma.pandaEvent.create({ data: { key, teamId, state: stav, messageId } });
  return stav === 'SENT';
}

/**
 * Jeden průchod. Bere zápasy v příštích osmi dnech a pro každý tým zvlášť
 * dopočítá, co už mělo odejít.
 *
 * Prahy se testují jako „už nastal čas a ještě se to nestalo", ne jako okno —
 * když cron hodinu vynechá, zpráva odejde se zpožděním, ne nikdy.
 */
async function zpracujZapasy(ted = new Date()) {
  const zapasy = await prisma.match.findMany({
    where: {
      status: 'UPCOMING',
      date: { gte: new Date(ted.getTime() - 12 * HODINA), lte: new Date(ted.getTime() + 8 * DEN) },
    },
    select: { id: true, date: true, season: true, venue: true, homeTeamId: true, awayTeamId: true },
  });

  let odeslano = 0;
  for (const zapas of zapasy) {
    const vykop = new Date(zapas.date).getTime();
    const uzaverka = chat.uzaverka(zapas.date).getTime();

    for (const teamId of [zapas.homeTeamId, zapas.awayTeamId]) {
      const stav = await stavSestavy(zapas, teamId);
      const klic = k => `${k}:${zapas.id}:${teamId}`;

      if (ted.getTime() >= vykop - 7 * DEN) {
        if (await jednou(klic('OTEVRENO'), teamId, () =>
          posliTymu(teamId, SABLONY.OTEVRENO({ zapas, hala: zapas.venue })))) odeslano++;
      }

      if (ted.getTime() >= vykop - 5 * DEN && ted.getTime() < uzaverka && stav.brankari === 0) {
        if (await jednou(klic('CHYBI_BRANKAR'), teamId, () =>
          posliTymu(teamId, SABLONY.CHYBI_BRANKAR(stav)))) odeslano++;
      }

      if (ted.getTime() >= uzaverka) {
        if (await jednou(klic('UZAVERKA'), teamId, () =>
          posliTymu(teamId, SABLONY.UZAVERKA(stav)))) odeslano++;
      }

      if (ted.getTime() >= vykop - 12 * HODINA && ted.getTime() < vykop) {
        if (await jednou(klic('DEN_D'), teamId, () =>
          posliTymu(teamId, SABLONY.DEN_D({ zapas, hala: zapas.venue, stav: stav.stav })))) odeslano++;
      }
    }
  }
  return { zapasu: zapasy.length, odeslano };
}

module.exports = { zpracujZapasy, posliTymu, stavSestavy, SABLONY, kdy, jednou };
