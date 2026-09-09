/**
 * Test balíčků zápasů — rezervace, zúčtování, vracení a odměny.
 *
 * Běží bez databáze: prisma je nahrazená mockem přes Module._load, takže
 * `npm run test:kredit` jde spustit kdekoli a trvá vteřinu.
 *
 * Hlídá pravidla, na kterých stojí celý platební model:
 *   1. Kredit dává jen zaplacený balíček; rezervace ho snižuje hned, ať hráč
 *      vidí správný zůstatek ještě před zápasem.
 *   2. Za jeden zápas se nesmí strhnout dvakrát.
 *   3. Odhlášení do 12 h vrací start, po uzávěrce ne.
 *   4. Zrušený zápas vrací i zúčtované starty — za nekonaný zápas nikdo neplatí.
 *   5. Kontumace vrací startu tomu, kdo sestavu sehnal, a bere tomu, kdo ne.
 *   6. Utrácí se nejdřív to, čemu dřív končí platnost.
 *   7. Odměna za doporučení se vyplácí jen u balíčku od tří zápasů výš
 *      a jen jednou.
 *   8. Rozhodčí nespustí zápas, dokud má někdo v sestavě nezaplacený start.
 *      Tohle nahradilo kontrolu poplatku za domácí zápas, zrušeného 9. 9. 2026.
 */
const Module = require('module');

// ---------- mock databáze ----------

let db, idSeq;
const dalsiId = (p) => `${p}${++idSeq}`;

function reset() {
  idSeq = 0;
  db = { packs: [], entries: [], codes: [], uses: [], payments: [], matches: {} };
}

const shoda = (radek, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('in'  in v) return v.in.includes(radek[k]);
    if ('not' in v) return radek[k] !== v.not;
    if ('gt'  in v) return radek[k] > v.gt;
    if ('lte' in v) return new Date(radek[k]) <= new Date(v.lte);
    return true;
  }
  return radek[k] === v;
});

function tabulka(jmeno) {
  return {
    findMany:   async ({ where } = {}) => db[jmeno].filter(r => shoda(r, where)),
    findFirst:  async ({ where } = {}) => db[jmeno].find(r => shoda(r, where)) ?? null,
    findUnique: async ({ where }) => {
      const klic = where.playerId_matchId;
      if (klic) {
        return db[jmeno].find(r => r.playerId === klic.playerId && r.matchId === klic.matchId) ?? null;
      }
      return db[jmeno].find(r => shoda(r, where)) ?? null;
    },
    create: async ({ data }) => {
      const r = { id: dalsiId(jmeno[0].toUpperCase()), createdAt: new Date(), ...data };
      db[jmeno].push(r);
      return r;
    },
    update: async ({ where, data }) => {
      const r = db[jmeno].find(x => x.id === where.id);
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in v) r[k] += v.increment;
        else if (v && typeof v === 'object' && 'decrement' in v) r[k] -= v.decrement;
        else r[k] = v;
      }
      return r;
    },
    updateMany: async ({ where, data }) => {
      const radky = db[jmeno].filter(r => shoda(r, where));
      for (const r of radky) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) r[k] += v.increment;
          else if (v && typeof v === 'object' && 'decrement' in v) r[k] -= v.decrement;
          else r[k] = v;
        }
      }
      return { count: radky.length };
    },
  };
}

const fakePrisma = {
  matchPack:  tabulka('packs'),
  matchEntry: tabulka('entries'),
  referralCode: {
    ...tabulka('codes'),
  },
  referralUse: {
    ...tabulka('uses'),
    findUnique: async ({ where, include }) => {
      const u = db.uses.find(x => x.newPlayerId === where.newPlayerId) ?? null;
      if (u && include?.code) return { ...u, code: db.codes.find(c => c.id === u.codeId) };
      return u;
    },
  },
  match: { findMany: async ({ where }) => Object.values(db.matches).filter(m => shoda(m, where)) },
  // Přenos balíčku do další sezóny se potvrzuje zaplacenou licencí.
  playerPayment: {
    findUnique: async ({ where }) => db.payments.find(p => p.playerId === where.playerId) ?? null,
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  return orig.apply(this, arguments);
};

const kredit = require('../src/services/kredit');

// ---------- pomocníci ----------

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const zaHodin = (h) => new Date(Date.now() + h * 3_600_000);

async function koupBalicek(playerId, size, { status = 'PAID', validUntil = null, season = '2026/27' } = {}) {
  return fakePrisma.matchPack.create({
    data: {
      playerId, season, size, remaining: size, price: 0,
      status, validUntil, isReward: false,
    },
  });
}

function zapas(id, { hodin = 48, season = '2026/27' } = {}) {
  const m = { id, date: zaHodin(hodin), season, status: 'UPCOMING' };
  db.matches[id] = m;
  return m;
}

// ---------- testy ----------

(async () => {
  // --- 1. zůstatek a rezervace ---
  reset();
  await koupBalicek('P1', 3);
  await koupBalicek('P1', 7, { status: 'PENDING' });
  ok(await kredit.zustatek('P1', '2026/27') === 3, 'nezaplacený balíček se do zůstatku nepočítá');

  const m1 = zapas('M1');
  const r1 = await kredit.rezervuj('P1', m1, 'T1');
  ok(r1.ok, 'rezervace projde');
  ok(await kredit.zustatek('P1', '2026/27') === 2,
    'rezervace sníží zůstatek hned, ne až po zápase');

  const r2 = await kredit.rezervuj('P1', m1, 'T1');
  ok(r2.ok && r2.uzBylo, 'druhá rezervace na týž zápas nestrhne podruhé');
  ok(await kredit.zustatek('P1', '2026/27') === 2, 'a zůstatek se nezměnil');

  // --- 2. došlý kredit ---
  await kredit.rezervuj('P1', zapas('M2'), 'T1');
  await kredit.rezervuj('P1', zapas('M3'), 'T1');
  const prazdny = await kredit.rezervuj('P1', zapas('M4'), 'T1');
  ok(!prazdny.ok && prazdny.code === 'NO_CREDIT', 'bez volného startu vrátí NO_CREDIT');

  // --- 3. odhlášení ---
  reset();
  await koupBalicek('P1', 3);
  const vcas = zapas('M1', { hodin: 48 });
  await kredit.rezervuj('P1', vcas, 'T1');
  const o1 = await kredit.odhlas('P1', vcas);
  ok(o1.vraceno === true, 'odhlášení 48 h předem vrátí start');
  ok(await kredit.zustatek('P1', '2026/27') === 3, 'a zůstatek je zpátky na třech');

  const pozde = zapas('M2', { hodin: 6 });
  await kredit.rezervuj('P1', pozde, 'T1');
  const o2 = await kredit.odhlas('P1', pozde);
  ok(o2.vraceno === false && o2.code === 'LATE_WITHDRAWAL',
    'odhlášení 6 h předem start nevrací');
  ok(await kredit.zustatek('P1', '2026/27') === 2, 'a zůstatek zůstal snížený');

  // --- 4. zamčení sestavy ---
  reset();
  await koupBalicek('P1', 3);
  const blizky = zapas('M1', { hodin: 5 });
  const daleky = zapas('M2', { hodin: 72 });
  await kredit.rezervuj('P1', blizky, 'T1');
  await kredit.rezervuj('P1', daleky, 'T1');
  const zamceno = await kredit.zamkniSestavy();
  ok(zamceno.startu === 1, 'zamkne se jen zápas do 12 h, ten vzdálený ne');
  ok(db.entries.find(e => e.matchId === 'M1').status === 'SPENT', 'blízký zápas je zúčtovaný');
  ok(db.entries.find(e => e.matchId === 'M2').status === 'RESERVED', 'vzdálený zůstal rezervovaný');

  const poZamceni = await kredit.odhlas('P1', blizky);
  ok(poZamceni.vraceno === false, 'po zamčení už odhlášení start nevrátí');

  // Kdo se po uzávěrce vrátí, neplatí znovu — zúčtovaný záznam zůstal.
  const pred = await kredit.zustatek('P1', '2026/27');
  const navrat = await kredit.rezervuj('P1', blizky, 'T1');
  ok(navrat.ok && navrat.uzBylo, 'návrat na týž zápas projde');
  ok(await kredit.zustatek('P1', '2026/27') === pred,
    'a nestrhne se za něj podruhé');

  // --- 5. zrušený zápas vrací i zúčtované ---
  ok(await kredit.zustatek('P1', '2026/27') === 1, 'před zrušením zbývá jeden start');
  await kredit.vratZapas('M1');
  ok(await kredit.zustatek('P1', '2026/27') === 2,
    'zrušený zápas vrátí i zúčtovaný start — za nekonaný zápas nikdo neplatí');

  // --- 6. kontumace ---
  reset();
  await koupBalicek('P1', 3);   // tým, který se nedostavil
  await koupBalicek('P2', 3);   // soupeř
  const km = zapas('M1', { hodin: 2 });
  await kredit.rezervuj('P1', km, 'VINIK');
  await kredit.rezervuj('P2', km, 'SOUPER');
  const kont = await kredit.vyresKontumaci('M1', 'VINIK');
  ok(kont.propadlo === 1 && kont.vraceno === 1, 'kontumace: jednomu propadlo, druhému vráceno');
  ok(await kredit.zustatek('P1', '2026/27') === 2, 'kdo se nedostavil, o start přišel');
  ok(await kredit.zustatek('P2', '2026/27') === 3, 'soupeř má start zpátky');

  // --- 7. pořadí spotřeby ---
  reset();
  await koupBalicek('P1', 5, { validUntil: null });        // bez omezení
  const konciciId = (await koupBalicek('P1', 5, { validUntil: '2026/27' })).id;
  await kredit.rezervuj('P1', zapas('M1'), 'T1');
  ok(db.packs.find(p => p.id === konciciId).remaining === 4,
    'utrácí se nejdřív balíček, kterému dřív končí platnost');

  // --- 8. přenos do další sezóny se potvrzuje licencí ---
  reset();
  await koupBalicek('P1', 3, { season: '2026/27' });
  const dalsiSezona = zapas('M1', { season: '2027/28' });

  db.payments = [{ playerId: 'P1', season: '2026/27', licStatus: 'PAID' }];
  ok(await kredit.zustatek('P1', '2027/28') === 0,
    'bez zaplacené licence na novou sezónu balíček propadá');

  db.payments = [{ playerId: 'P1', season: '2027/28', licStatus: 'PAID' }];
  ok(await kredit.zustatek('P1', '2027/28') === 3,
    'se zaplacenou licencí na novou sezónu se balíček přenese');
  const prenos = await kredit.rezervuj('P1', dalsiSezona, 'T1');
  ok(prenos.ok, 'a jde z něj v nové sezóně čerpat');

  // --- 9. odměna za doporučení ---
  reset();
  await fakePrisma.referralCode.create({ data: { playerId: 'P1', code: 'FSL-NOV-AAAA' } });
  await fakePrisma.referralUse.create({ data: { codeId: 'C1', newPlayerId: 'P2' } });

  const maly = await koupBalicek('P2', 1);
  ok(await kredit.odmenZaDoporuceni('P2', maly) === null,
    'balíček za jeden zápas odměnu nespouští');

  const velky = await koupBalicek('P2', 3);
  const odmena = await kredit.odmenZaDoporuceni('P2', velky);
  ok(odmena && odmena.playerId === 'P1', 'trojka odměnu vyplatí tomu, kdo hráče přivedl');
  ok(await kredit.zustatek('P1', '2026/27') === 1, 'a je to jeden zápas zdarma');

  const podruhe = await koupBalicek('P2', 12);
  ok(await kredit.odmenZaDoporuceni('P2', podruhe) === null,
    'druhý balíček už odměnu nevyplatí');

  // --- 10. brána rozhodčího: kdo v sestavě nemá start ---
  // Nahradilo kontrolu „domácí tým zaplatil 2 200 Kč". Zápas se nesmí
  // rozjet s někým, kdo za něj nezaplatil.
  reset();
  await koupBalicek('P1', 1);
  const zapasBrany = zapas('M9', { hodin: 30 });
  await kredit.rezervuj('P1', zapasBrany, 'T1');

  ok((await kredit.chybejiciStarty('M9', ['P1'])).length === 0,
    'kdo má rezervaci, bránou projde');
  ok((await kredit.chybejiciStarty('M9', ['P1', 'P2'])).join() === 'P2',
    'kdo v sestavě je a start nemá, je vidět jménem');
  ok((await kredit.chybejiciStarty('M9', [])).length === 0,
    'prázdná sestava se na kredit neptá');

  await kredit.zamkniSestavu('M9');
  ok((await kredit.chybejiciStarty('M9', ['P1'])).length === 0,
    'zúčtovaný start bránou projde stejně jako rezervace');

  await kredit.odhlas('P1', zapasBrany);
  ok((await kredit.chybejiciStarty('M9', ['P1'])).length === 0,
    'kdo se po uzávěrce odhlásil a vrátil, platit znovu nemusí');

  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
})();
