/**
 * Balíčky zápasů — kdo kolik startů zaplatil a kolik mu jich zbývá.
 *
 * Zápasy si platí hráč, ne tým. Balíček patří hráči; kdo hostuje ve třech
 * týmech, čerpá pořád z jednoho pytle.
 *
 * ── Životní cyklus jednoho startu ───────────────────────────────────────
 *
 *   REZERVACE   zařazení do sestavy. `remaining` klesne hned, takže hráč
 *               vidí správný zůstatek od té chvíle, ne až po zápase.
 *   ZÚČTOVÁNÍ   **12 hodin před výkopem** se sestava zamkne a starty se
 *               zúčtují (SPENT). Do té doby se dá odhlásit bez ztráty.
 *   VRÁCENÍ     jen zrušený zápas nebo kontumace ve prospěch týmu.
 *
 * ── Po uzávěrce ─────────────────────────────────────────────────────────
 * Odhlásit se jde pořád — jen to hráče stojí ten zápas z balíčku.
 * Přihlásit se jde taky pořád. A když se odhlášený hráč na týž zápas vrátí,
 * **neplatí znovu**: za jeden zápas se strhává nejvýš jednou, o což se
 * stará unikát [playerId, matchId] a záznam, který po odhlášení zůstává.
 *
 * ── Přenos mezi sezónami ────────────────────────────────────────────────
 * Nevyužité starty se přenášejí do playoff vždycky. Do další sezóny se
 * přenesou teprve tehdy, když si hráč **zaplatí licenci na novou sezónu** —
 * jinak propadají. Bez téhle podmínky by prodaný a nevyčerpaný balíček byl
 * závazek, který z účetnictví nikdy nezmizí.
 */

const prisma = require('../lib/prisma');

/** Lhůta, do kdy se jde odhlásit bez ztráty startu. */
const LHUTA_ODHLASENI_H = 12;

/**
 * Ceník balíčků. Ceny jsou konečné; liga není plátce DPH, takže se k nim
 * nic nepřipočítává a daň se nikde neuvádí.
 *
 * Ze startů se platí hala, rozhodčí a zdravotník. Sazby jsou postavené tak,
 * že i nejtenčí sestava zápas pokryje: 9 hráčů na každé straně po 162,50 Kč
 * (šestnáctka) dá 2 925 Kč proti nákladu 2 200 Kč na zápas.
 *
 * Nejmenší balíček stojí 200 Kč a s velikostí cena za zápas klesá na 150.
 */
const BALICKY = [
  { size: 1,  price: 200  },
  { size: 3,  price: 550  },
  { size: 7,  price: 1200 },
  { size: 12, price: 2000 },
  { size: 16, price: 2600 },
  // Dvacítka míří na hráče se superlicencí, kteří chodí doplňovat sestavy.
  // Vychází na 150 Kč za zápas — o čtvrtinu líp než jednotlivý start,
  // což je přesně ta pobídka, aby v lize byl kdo zaskočit.
  { size: 20, price: 3000 },
];

/** Od kolika zápasů se balíček počítá jako „přivedení hráče do ligy". */
const MIN_BALICEK_PRO_ODMENU = 3;

/** Vrátí definici balíčku podle počtu zápasů, nebo null. */
function balicek(size) {
  return BALICKY.find(b => b.size === Number(size)) ?? null;
}

/** Balíček je použitelný, jen když je doopravdy zaplacený. */
const ZAPLACENO = ['PAID', 'WAIVED'];

/**
 * Má hráč zaplacenou licenci na tuhle sezónu?
 *
 * Rozhoduje o přenosu nevyčerpaných balíčků: kdo se do nové sezóny
 * nepřihlásí, o zbytek přijde.
 */
async function maLicenciNaSezonu(playerId, season, tx = prisma) {
  const payment = await tx.playerPayment.findUnique({ where: { playerId } });
  if (!payment) return false;
  return ZAPLACENO.includes(payment.licStatus) && payment.season === season;
}

/**
 * Balíčky, ze kterých se dá čerpat, v pořadí spotřeby.
 *
 * Nejdřív to, čemu dřív končí platnost (`validUntil`), pak od nejstaršího.
 * Dneska nic neexpiruje, ale kdyby se platnost někdy omezila, musí se
 * utrácet to, co by jinak propadlo.
 */
async function pouzitelneBalicky(playerId, season, tx = prisma) {
  const balicky = await tx.matchPack.findMany({
    where: {
      playerId,
      status:    { in: ZAPLACENO },
      remaining: { gt: 0 },
    },
  });

  // Balíček z minulé sezóny ožije, jen když má hráč zaplacenou licenci
  // na tu současnou. Ověřuje se to teprve tehdy, když je co ověřovat.
  const jsouStare = balicky.some(b => b.season !== season);
  const prenosPotvrzen = jsouStare ? await maLicenciNaSezonu(playerId, season, tx) : true;

  return balicky
    .filter(b => !b.validUntil || !season || b.validUntil >= season)
    .filter(b => b.season === season || prenosPotvrzen)
    .sort((a, b) => {
      const pa = a.validUntil ?? '9999/99';
      const pb = b.validUntil ?? '9999/99';
      if (pa !== pb) return pa < pb ? -1 : 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
}

/** Kolik startů hráči zbývá. */
async function zustatek(playerId, season) {
  const balicky = await pouzitelneBalicky(playerId, season);
  return balicky.reduce((soucet, b) => soucet + b.remaining, 0);
}

/**
 * Přehled pro obrazovku plateb — co má hráč koupené, co mu zbývá a na které
 * zápasy je přihlášený. Klient si tím vystačí s jedním voláním.
 */
async function prehled(playerId, season) {
  const vsechny = await prisma.matchPack.findMany({
    where:   { playerId },
    orderBy: { createdAt: 'desc' },
  });
  const zaplacene = vsechny.filter(b => ZAPLACENO.includes(b.status));

  const prihlaseny = await prisma.matchEntry.findMany({
    where: {
      playerId,
      status: { in: ['RESERVED', 'SPENT'] },
      match:  { status: { in: ['UPCOMING', 'LIVE'] } },
    },
    include: {
      match: {
        select: {
          id: true, date: true, venue: true, status: true,
          homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
          awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
        },
      },
    },
  });

  return {
    season,
    packs:     vsechny,
    remaining: zaplacene.reduce((s, b) => s + b.remaining, 0),
    spent:     zaplacene.reduce((s, b) => s + (b.size - b.remaining), 0),
    withdrawalHours: LHUTA_ODHLASENI_H,
    upcoming: prihlaseny
      .map(e => ({
        matchId:   e.matchId,
        teamId:    e.teamId,
        status:    e.status,
        // Po zamčení už odhlášení start nevrátí — klient to má říct dopředu.
        locked:    e.status === 'SPENT' || hodinDoVykopu(e.match) < LHUTA_ODHLASENI_H,
        hoursLeft: Math.round(hodinDoVykopu(e.match) * 10) / 10,
        match:     e.match,
      }))
      .sort((a, b) => new Date(a.match.date) - new Date(b.match.date)),
  };
}

/**
 * Zarezervuje hráči start na zápas.
 *
 * Když rezervace pro tuhle dvojici (hráč, zápas) už existuje, nic se nestrhne
 * podruhé. Bez volného startu vrací `NO_CREDIT`.
 */
async function rezervuj(playerId, match, teamId, tx = prisma) {
  const uz = await tx.matchEntry.findUnique({
    where: { playerId_matchId: { playerId, matchId: match.id } },
  });
  if (uz && uz.status !== 'RELEASED') return { ok: true, entry: uz, uzBylo: true };

  const [pack] = await pouzitelneBalicky(playerId, match.season, tx);
  if (!pack) {
    return { ok: false, code: 'NO_CREDIT', error: 'Hráč nemá volný zápas v balíčku' };
  }

  // Odečteme jen tehdy, když tam pořád něco je — dva souběžné požadavky
  // by jinak mohly stáhnout stejný poslední start dvakrát.
  const odecteno = await tx.matchPack.updateMany({
    where: { id: pack.id, remaining: { gt: 0 } },
    data:  { remaining: { decrement: 1 } },
  });
  if (odecteno.count === 0) {
    return { ok: false, code: 'NO_CREDIT', error: 'Balíček se právě vyčerpal, zkus to znovu' };
  }

  const entry = uz
    ? await tx.matchEntry.update({
        where: { id: uz.id },
        data:  { status: 'RESERVED', packId: pack.id, teamId, settledAt: null },
      })
    : await tx.matchEntry.create({
        data: { playerId, matchId: match.id, teamId, packId: pack.id, status: 'RESERVED' },
      });

  return { ok: true, entry, pack };
}

/** Vrátí rezervaci zpět do balíčku. Zúčtovaný start se nevrací. */
async function uvolni(playerId, matchId, tx = prisma) {
  const entry = await tx.matchEntry.findUnique({
    where: { playerId_matchId: { playerId, matchId } },
  });
  if (!entry || entry.status !== 'RESERVED') return { ok: true, nicSeNestalo: true };

  await tx.matchEntry.update({
    where: { id: entry.id },
    data:  { status: 'RELEASED', settledAt: new Date() },
  });
  if (entry.packId) {
    await tx.matchPack.update({
      where: { id: entry.packId },
      data:  { remaining: { increment: 1 } },
    });
  }
  return { ok: true, entry };
}

/** Kolik hodin zbývá do výkopu. */
function hodinDoVykopu(match, ted = new Date()) {
  return (new Date(match.date) - ted) / 3_600_000;
}

/**
 * Odhlášení ze zápasu hráčem.
 *
 * Do 12 h před výkopem se start vrátí do balíčku. Po uzávěrce se odhlásit
 * dá pořád — jen to hráče stojí ten zápas. Vrátit se na něj může kdykoli
 * a nic dalšího se mu nestrhne.
 */
async function odhlas(playerId, match, tx = prisma) {
  if (hodinDoVykopu(match) >= LHUTA_ODHLASENI_H) {
    await uvolni(playerId, match.id, tx);
    return { ok: true, vraceno: true };
  }
  // Po uzávěrce se odhlásit dá pořád, jen to stojí ten zápas. Záznam
  // zůstává zúčtovaný — kdyby se hráč na týž zápas vrátil, nezaplatí znovu.
  return {
    ok: true, vraceno: false, code: 'LATE_WITHDRAWAL',
    error: `Odhlášení míň než ${LHUTA_ODHLASENI_H} h před výkopem — `
         + 'tenhle zápas ti z balíčku propadá. Když se na něj vrátíš, '
         + 'nic dalšího se ti nestrhne.',
  };
}

/**
 * Srovná rezervace se skutečnou sestavou.
 *
 * `PUT /matches/:id/lineup/:teamId` sestavu přepisuje celou, takže se musí
 * přepsat i rezervace. Vrací hráče, kterým chybí kredit — ti se do sestavy
 * nedostanou.
 */
async function srovnejRezervace(match, teamId, playerIds, tx = prisma) {
  const stavajici = await tx.matchEntry.findMany({
    where: { matchId: match.id, teamId, status: 'RESERVED' },
  });

  const pozde = hodinDoVykopu(match) < LHUTA_ODHLASENI_H;
  for (const e of stavajici) {
    // Po uzávěrce se start nevrací ani tehdy, když hráče vedoucí ze sestavy
    // vyškrtne — jinak by uzávěrka nic neznamenala.
    if (!playerIds.includes(e.playerId) && !pozde) await uvolni(e.playerId, match.id, tx);
  }

  const bezKreditu = [];
  for (const playerId of playerIds) {
    const r = await rezervuj(playerId, match, teamId, tx);
    if (!r.ok) bezKreditu.push({ playerId, code: r.code, error: r.error });
  }
  return bezKreditu;
}

/**
 * Zamkne sestavu a zúčtuje starty — volá se 12 h před výkopem.
 *
 * Od téhle chvíle hráč v přehledu vidí zápas jako utracený, ne jen
 * zablokovaný, a odhlášením ho už nezíská zpátky.
 */
async function zamkniSestavu(matchId, tx = prisma) {
  const { count } = await tx.matchEntry.updateMany({
    where: { matchId, status: 'RESERVED' },
    data:  { status: 'SPENT', settledAt: new Date() },
  });
  return count;
}

/**
 * Kdo je v sestavě, ale nemá za zápas zaplacený start.
 *
 * Tohle je podmínka, na které rozhodčí zápas spouští. Dřív se hlídalo, že
 * domácí tým poslal 2 200 Kč; od chvíle, kdy zápasy platí hráči, musí sedět
 * něco jiného — každý na hřišti má start z balíčku.
 *
 * Za normálních okolností je seznam prázdný: `srovnejRezervace` bez kreditu
 * do sestavy nikoho nepustí. Vyplní se jen tehdy, když se sestava obešla
 * (ruční zápis do databáze, chyba v pořadí zápisů), a to je přesně ten
 * případ, kdy má rozhodčí zastavit.
 *
 * @param {string[]} playerIds hráči v sestavách obou týmů
 * @returns {Promise<string[]>} id hráčů bez startu
 */
async function chybejiciStarty(matchId, playerIds, tx = prisma) {
  if (playerIds.length === 0) return [];
  const zaplacene = await tx.matchEntry.findMany({
    where:  { matchId, playerId: { in: playerIds }, status: { in: ['RESERVED', 'SPENT'] } },
    select: { playerId: true },
  });
  const maStart = new Set(zaplacene.map(e => e.playerId));
  return playerIds.filter(id => !maStart.has(id));
}

/**
 * Projde zápasy, kterým do výkopu zbývá míň než 12 h, a zamkne jim sestavy.
 * Pouští se z plánovače v `server.js`.
 */
async function zamkniSestavy(ted = new Date()) {
  const hranice = new Date(ted.getTime() + LHUTA_ODHLASENI_H * 3_600_000);
  const zapasy = await prisma.match.findMany({
    where:  { status: { in: ['UPCOMING', 'LIVE'] }, date: { lte: hranice } },
    select: { id: true },
  });
  let zamceno = 0;
  for (const z of zapasy) zamceno += await zamkniSestavu(z.id);
  return { zapasu: zapasy.length, startu: zamceno };
}

/**
 * Zúčtuje odehraný zápas — pojistka pro případ, že plánovač neběžel.
 */
async function zuctujZapas(matchId, tx = prisma) {
  return zamkniSestavu(matchId, tx);
}

/**
 * Vrátí starty všem — zrušený zápas nikdo neodehrál.
 * Vrací i to, co už bylo zúčtované: za zápas, který se nekonal, nikdo neplatí.
 */
async function vratZapas(matchId, tx = prisma) {
  const entries = await tx.matchEntry.findMany({
    where: { matchId, status: { in: ['RESERVED', 'SPENT'] } },
  });
  for (const e of entries) {
    await tx.matchEntry.update({
      where: { id: e.id },
      data:  { status: 'RELEASED', settledAt: new Date() },
    });
    if (e.packId) {
      await tx.matchPack.update({
        where: { id: e.packId },
        data:  { remaining: { increment: 1 } },
      });
    }
  }
  return entries.length;
}

/**
 * Kontumace — starty se vrací týmu, který sestavu sehnal, a propadají tomu,
 * kdo ji nesehnal. `vinikTeamId` je tým, který se nedostavil.
 */
async function vyresKontumaci(matchId, vinikTeamId, tx = prisma) {
  const entries = await tx.matchEntry.findMany({
    where: { matchId, status: { in: ['RESERVED', 'SPENT'] } },
  });
  let vraceno = 0, propadlo = 0;
  for (const e of entries) {
    if (e.teamId === vinikTeamId) {
      await tx.matchEntry.update({
        where: { id: e.id },
        data:  { status: 'SPENT', settledAt: new Date() },
      });
      propadlo += 1;
    } else {
      await tx.matchEntry.update({
        where: { id: e.id },
        data:  { status: 'RELEASED', settledAt: new Date() },
      });
      if (e.packId) {
        await tx.matchPack.update({
          where: { id: e.packId },
          data:  { remaining: { increment: 1 } },
        });
      }
      vraceno += 1;
    }
  }
  return { vraceno, propadlo };
}

// ==================== DOPORUČENÍ ====================

/**
 * Vyplatí odměnu za přivedení hráče.
 *
 * Volá se ve chvíli, kdy nový hráč zaplatí balíček. Odměna se vyplácí jen
 * jednou a jen tehdy, když je balíček aspoň za `MIN_BALICEK_PRO_ODMENU`
 * zápasů — jinak by stačilo koupit nejmenší balíček a kód se vyplatil sám.
 */
async function odmenZaDoporuceni(playerId, pack, tx = prisma) {
  if (!pack || pack.size < MIN_BALICEK_PRO_ODMENU || pack.isReward) return null;

  const uziti = await tx.referralUse.findUnique({
    where:   { newPlayerId: playerId },
    include: { code: true },
  });
  if (!uziti || uziti.rewardedAt) return null;

  const odmena = await tx.matchPack.create({
    data: {
      playerId:  uziti.code.playerId,
      season:    pack.season,
      size:      1,
      remaining: 1,
      price:     0,
      isReward:  true,
      status:    'PAID',
      paidAt:    new Date(),
      method:    'referral',
    },
  });

  await tx.referralUse.update({
    where: { id: uziti.id },
    data:  { rewardPackId: odmena.id, rewardedAt: new Date() },
  });

  return { rewardPackId: odmena.id, playerId: uziti.code.playerId };
}

module.exports = {
  BALICKY, balicek, ZAPLACENO, LHUTA_ODHLASENI_H, MIN_BALICEK_PRO_ODMENU,
  maLicenciNaSezonu,
  zustatek, prehled, rezervuj, uvolni, odhlas, hodinDoVykopu,
  srovnejRezervace, chybejiciStarty, zamkniSestavu, zamkniSestavy, zuctujZapas,
  vratZapas, vyresKontumaci, odmenZaDoporuceni,
};
