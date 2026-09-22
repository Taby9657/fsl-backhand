/**
 * Chat: kdo smí komu psát, kde konverzace vznikají a jak se počítá termín.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`.
 *
 * **Jedno pravidlo, jedno místo.** `muzePsat()` je jediná funkce, která
 * rozhoduje o oslovení. Volá ji odeslání zprávy (závazně) i vyhledávání lidí
 * (kvůli příznaku `canMessage` pro UI) — kdyby si to UI rozhodovalo samo,
 * rozejde se to hned, jak se pravidlo změní.
 */

const prisma = require('../lib/prisma');
const seasonSvc = require('./seasonTransition');

/** Zpráva od Pandy nemá autora — `authorPlayerId = null`. */
const PANDA = null;

// ---------------------------------------------------------------------------
// Pražský čas
// ---------------------------------------------------------------------------

const CASTI = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/** Rozloží okamžik na pražské datum a čas. */
function prazskeCasti(d) {
  const o = {};
  for (const { type, value } of CASTI.formatToParts(d)) o[type] = value;
  return {
    rok: Number(o.year), mesic: Number(o.month), den: Number(o.day),
    hodina: Number(o.hour === '24' ? '0' : o.hour),
    minuta: Number(o.minute), sekunda: Number(o.second),
  };
}

/** O kolik minut je Praha před UTC v daný okamžik (60 v zimě, 120 v létě). */
function offsetPrahy(d) {
  const c = prazskeCasti(d);
  const jakoUTC = Date.UTC(c.rok, c.mesic - 1, c.den, c.hodina, c.minuta, c.sekunda);
  return Math.round((jakoUTC - d.getTime()) / 60000);
}

/**
 * Konec NÁSLEDUJÍCÍHO kalendářního dne v Praze.
 *
 * Termín odpovědi ligy. **Počítá se v pražském čase, ne v UTC** — server
 * běží v UTC a zpráva z úterý 23:50 by jinak dostala termín o den vedle.
 * Offset se dopočítává dvakrát kvůli přechodu na zimní čas: první odhad
 * použije offset dneška, druhý offset cílového dne.
 */
function konecDalsihoDne(ted = new Date()) {
  const c = prazskeCasti(ted);
  const cil = Date.UTC(c.rok, c.mesic - 1, c.den + 1, 23, 59, 59, 999);
  const prvni = new Date(cil - offsetPrahy(ted) * 60000);
  return new Date(cil - offsetPrahy(prvni) * 60000);
}

// ---------------------------------------------------------------------------
// Sankce
// ---------------------------------------------------------------------------

/** Platné sankce hráče (nezrušené a neprošlé). */
async function sankce(playerId) {
  const ted = new Date();
  const radky = await prisma.chatSanction.findMany({
    where: {
      playerId,
      revokedAt: null,
      OR: [{ until: null }, { until: { gt: ted } }],
    },
    select: { kind: true, teamId: true, reason: true, until: true },
  });
  return radky;
}

async function maSankci(playerId, kind) {
  const vsechny = await sankce(playerId);
  return vsechny.some(s => s.kind === kind);
}

// ---------------------------------------------------------------------------
// muzePsat
// ---------------------------------------------------------------------------

/**
 * Smí `fromPlayerId` napsat `toPlayerId`?
 *
 *   ROVNOU — píše se rovnou do přímé konverzace
 *   ZADOST — pošle se jedna zpráva jako žádost o chat
 *   NE     — nesmí
 *
 * **Pořadí podmínek je součást pravidla.** Sankce jsou nahoře; „nechci
 * zprávy od cizích" je až za spoluhráči a soupeři, protože ten přepínač má
 * odříznout cizí lidi, ne vlastní tým.
 *
 * Na konverzaci s ligou (`SUPPORT`) se tahle funkce nevolá vůbec — tam se
 * dostane i umlčený a zablokovaný člověk, jinak by se neměl jak bránit.
 */
async function muzePsat(fromPlayerId, toPlayerId) {
  if (!fromPlayerId || !toPlayerId) return 'NE';
  if (fromPlayerId === toPlayerId) return 'ROVNOU';

  const [od, komu] = await Promise.all([
    prisma.player.findUnique({
      where: { id: fromPlayerId },
      select: { id: true, teamId: true, isSupervisor: true },
    }),
    prisma.player.findUnique({
      where: { id: toPlayerId },
      select: { id: true, teamId: true, dmPolicy: true },
    }),
  ]);
  if (!od || !komu) return 'NE';

  // 1. umlčený nepíše nikomu
  if (await maSankci(fromPlayerId, 'MUTE')) return 'NE';

  // 2. blokace platí v obou směrech
  const blok = await prisma.chatBlock.findFirst({
    where: {
      OR: [
        { blockerId: fromPlayerId, blockedId: toPlayerId },
        { blockerId: toPlayerId,   blockedId: fromPlayerId },
      ],
    },
    select: { blockerId: true },
  });
  if (blok) return 'NE';

  // 3. supervisor
  if (od.isSupervisor) return 'ROVNOU';

  const season = await seasonSvc.currentSeason();

  // 4. spoluhráč — společná soupiska v běžící sezóně
  if (season) {
    const spolu = await prisma.teamRoster.findFirst({
      where: {
        season,
        playerId: fromPlayerId,
        teamId: { in: (await prisma.teamRoster.findMany({
          where: { season, playerId: toPlayerId },
          select: { teamId: true },
        })).map(r => r.teamId) },
      },
      select: { id: true },
    });
    if (spolu) return 'ROVNOU';
  }
  // Záloha pro sezónu, kde se soupisky teprve skládají: kmenový tým.
  if (od.teamId && od.teamId === komu.teamId) return 'ROVNOU';

  // 5. soupeř z odehraného zápasu
  if (await hraliProtiSobe(fromPlayerId, toPlayerId, season)) return 'ROVNOU';

  // 6. zákaz psát cizím
  if (await maSankci(fromPlayerId, 'NO_STRANGER_DM')) return 'NE';

  // 7. příjemce nechce zprávy od cizích
  if (komu.dmPolicy === 'NONE') return 'NE';

  // 8. zbytek jde přes žádost
  return 'ZADOST';
}

/** Byli oba v sestavě téhož odehraného zápasu? */
async function hraliProtiSobe(a, b, season) {
  const zapasyA = await prisma.lineupPlayer.findMany({
    where: {
      playerId: a,
      submission: { match: { status: 'DONE', ...(season ? { season } : {}) } },
    },
    select: { submission: { select: { matchId: true } } },
  });
  const ids = [...new Set(zapasyA.map(r => r.submission.matchId))];
  if (ids.length === 0) return false;

  const spolecny = await prisma.lineupPlayer.findFirst({
    where: { playerId: b, submission: { matchId: { in: ids } } },
    select: { id: true },
  });
  return Boolean(spolecny);
}

// ---------------------------------------------------------------------------
// Konverzace
// ---------------------------------------------------------------------------

/**
 * Týmová konverzace. **Bez sezóny** — chat týmu je trvalý a přechod ročníku
 * se ho nesmí dotknout.
 */
async function tymovaKonverzace(teamId) {
  const je = await prisma.conversation.findUnique({ where: { teamId } });
  if (je) return je;
  return prisma.conversation.create({ data: { kind: 'TEAM', teamId } });
}

/** Vlákno hráče s ligou. Jedno na hráče, nezakládá se ke každému dotazu nové. */
async function vlaknoSLigou(playerId) {
  const je = await prisma.conversation.findUnique({
    where: { ownerPlayerId_kind: { ownerPlayerId: playerId, kind: 'SUPPORT' } },
  });
  if (je) return je;
  const nova = await prisma.conversation.create({
    data: { kind: 'SUPPORT', ownerPlayerId: playerId },
  });
  await prisma.conversationMember.create({
    data: { conversationId: nova.id, playerId },
  });
  return nova;
}

/** Soukromé vlákno hráče s Pandou. Jedno na hráče. */
async function vlaknoSPandou(playerId) {
  const je = await prisma.conversation.findUnique({
    where: { ownerPlayerId_kind: { ownerPlayerId: playerId, kind: 'PANDA' } },
  });
  if (je) return je;
  const nova = await prisma.conversation.create({
    data: { kind: 'PANDA', ownerPlayerId: playerId },
  });
  await prisma.conversationMember.create({
    data: { conversationId: nova.id, playerId },
  });
  return nova;
}

/** Přímá konverzace dvou lidí. Hledá se podle dvojice členů. */
async function primaKonverzace(a, b) {
  const kandidati = await prisma.conversationMember.findMany({
    where: { playerId: a, conversation: undefined },
    select: { conversationId: true },
  });
  const ids = kandidati.map(k => k.conversationId);
  if (ids.length) {
    const spolecna = await prisma.conversation.findFirst({
      where: { id: { in: ids }, kind: 'DIRECT' },
      select: { id: true },
    });
    if (spolecna) {
      const druhy = await prisma.conversationMember.findFirst({
        where: { conversationId: spolecna.id, playerId: b },
        select: { id: true },
      });
      if (druhy) return prisma.conversation.findUnique({ where: { id: spolecna.id } });
    }
  }
  const nova = await prisma.conversation.create({ data: { kind: 'DIRECT' } });
  await prisma.conversationMember.createMany({
    data: [
      { conversationId: nova.id, playerId: a },
      { conversationId: nova.id, playerId: b },
    ],
  });
  return nova;
}

/** Je hráč aktivním členem konverzace? Odebraný člen historii nevidí. */
async function jeClen(conversationId, playerId) {
  const m = await prisma.conversationMember.findUnique({
    where: { conversationId_playerId: { conversationId, playerId } },
    select: { removedAt: true },
  });
  return Boolean(m && !m.removedAt);
}

// ---------------------------------------------------------------------------
// Autor zprávy pro klienta
// ---------------------------------------------------------------------------

/** Osm barev pro iniciály. U každé je text volený na kontrast. */
const BARVY = [
  { pozadi: '#7C5CFF', text: '#FFFFFF' },
  { pozadi: '#E0417A', text: '#FFFFFF' },
  { pozadi: '#F5A524', text: '#1A0B33' },
  { pozadi: '#2DD4A7', text: '#10261F' },
  { pozadi: '#4AA8FF', text: '#0A1C2E' },
  { pozadi: '#B15CFF', text: '#FFFFFF' },
  { pozadi: '#FF8A5B', text: '#2B1005' },
  { pozadi: '#6FD36F', text: '#12280F' },
];

/**
 * Jak se autor ukáže v chatu.
 *
 * **Fotka se drží u hráče, ne u zprávy** — kdyby se kopírovala do zprávy,
 * zůstaly by v historii jeho staré profilovky. Barvu a iniciály počítá
 * backend z id, aby web i pozdější appka ukazovaly totéž.
 */
function autorProKlienta(player) {
  if (!player) {
    return { id: null, jmeno: 'Panda', panda: true, photoUrl: null };
  }
  const jmeno = `${player.firstName} ${player.lastName}`.trim();
  let soucet = 0;
  for (const z of player.id) soucet = (soucet + z.charCodeAt(0)) % 100000;
  const barva = BARVY[soucet % BARVY.length];
  return {
    id: player.id,
    jmeno,
    panda: false,
    photoUrl: player.photoUrl ?? null,
    iniciely: (player.firstName?.[0] ?? '') + (player.lastName?.[0] ?? ''),
    barva: barva.pozadi,
    barvaTextu: barva.text,
  };
}


// ---------------------------------------------------------------------------
// Členství v týmové konverzaci
// ---------------------------------------------------------------------------

/**
 * Doplní do týmového chatu hráče ze soupisky.
 *
 * **Koho vedoucí odebral, nevrací zpátky.** Odebraný člen má řádek
 * s `removedAt` a ten se při synchronizaci nechává být — jinak by ho každé
 * doplnění soupisky vrátilo do konverzace, ze které ho vedoucí vyhodil.
 *
 * Vrací, kolik lidí přibylo.
 */
async function synchronizujCleny(teamId, season) {
  const konverzace = await tymovaKonverzace(teamId);

  const soupiska = await prisma.teamRoster.findMany({
    where: { teamId, season },
    select: { playerId: true },
  });
  const kmenovi = await prisma.player.findMany({
    where: { teamId }, select: { id: true },
  });
  const maByt = [...new Set([...soupiska.map(r => r.playerId), ...kmenovi.map(p => p.id)])];
  if (!maByt.length) return 0;

  const uz = await prisma.conversationMember.findMany({
    where: { conversationId: konverzace.id, playerId: { in: maByt } },
    select: { playerId: true },
  });
  const uzJsou = new Set(uz.map(m => m.playerId));
  const chybi = maByt.filter(id => !uzJsou.has(id));
  if (!chybi.length) return 0;

  await prisma.conversationMember.createMany({
    data: chybi.map(playerId => ({ conversationId: konverzace.id, playerId })),
    skipDuplicates: true,
  });
  return chybi.length;
}

/** Je ten účet vedoucím daného týmu? */
async function jeVedouci(userId, teamId) {
  if (!userId || !teamId) return false;
  const m = await prisma.manager.findFirst({
    where: { userId, teamId }, select: { id: true },
  });
  return Boolean(m);
}

// ---------------------------------------------------------------------------
// Zápas
// ---------------------------------------------------------------------------

/** 48 h před výkopem se sestava uzavírá. */
const UZAVERKA_MS = 48 * 3600 * 1000;

function uzaverka(datumZapasu) {
  return new Date(new Date(datumZapasu).getTime() - UZAVERKA_MS);
}

/** Minimum, bez kterého zápas nezačne: 8 do pole + brankář. */
const MIN_HRACU = 9;
const MIN_BRANKARU = 1;

module.exports = {
  PANDA,
  synchronizujCleny, jeVedouci,
  uzaverka, UZAVERKA_MS, MIN_HRACU, MIN_BRANKARU,
  prazskeCasti, offsetPrahy, konecDalsihoDne,
  sankce, maSankci,
  muzePsat, hraliProtiSobe,
  tymovaKonverzace, vlaknoSLigou, vlaknoSPandou, primaKonverzace, jeClen,
  autorProKlienta, BARVY,
};
