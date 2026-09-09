/**
 * Test kontumací a pokut — běží bez databáze, prisma je nahrazená mockem.
 *
 *   node scripts/test-pokuty.js
 *
 * Hlídá pravidla, na kterých kontumace stojí:
 *   1. Jedna kontumace = jedna pokuta. Opakované předepsání nic nezdvojí.
 *   2. Pokuta je plochá. Nezávisí na tom, kolik hráčů se do sestavy
 *      přihlásilo — jinak by tým, kterému se nepřihlásil nikdo, nezaplatil
 *      nic, přestože zápas zmařil nejvíc.
 *   3. Nezaplacená pokuta drží — dokud visí, tým další zápas nerozehraje.
 *      Zaplacená ani odpuštěná už ne.
 *   4. Kontumace se počítají po sezónách; třetí je ta, po které tým končí.
 */
const Module = require('module');

// ---------- mock databáze ----------

let db, idSeq;

function reset() {
  idSeq = 0;
  db = { fines: [], matches: [] };
}

const shoda = (radek, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('in'    in v) return v.in.includes(radek[k]);
    if ('notIn' in v) return !v.notIn.includes(radek[k]);
    if ('not'   in v) return radek[k] !== v.not;
    return true;
  }
  return radek[k] === v;
});

const fakePrisma = {
  fine: {
    findUnique: async ({ where }) => db.fines.find(f => shoda(f, where)) ?? null,
    findMany:   async ({ where } = {}) => db.fines.filter(f => shoda(f, where)),
    create: async ({ data }) => {
      const f = {
        id: `F${++idSeq}`, status: 'PENDING', paidAmount: 0, paidAt: null,
        method: null, variableSymbol: null, createdAt: new Date(), ...data,
      };
      db.fines.push(f);
      return f;
    },
    update: async ({ where, data }) => {
      const f = db.fines.find(x => x.id === where.id);
      Object.assign(f, data);
      return f;
    },
  },
  match: {
    count: async ({ where }) => db.matches.filter(m => shoda(m, where)).length,
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  return orig.apply(this, arguments);
};

const pokuty = require('../src/services/pokuty');

// ---------- pomocníci ----------

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const zapas = (id, season = '2026/27') => ({
  id, season, date: new Date('2026-10-04T18:00:00Z'),
});

// ---------- testy ----------

(async () => {
  // --- 1. předpis pokuty ---
  reset();
  const m1 = zapas('M1');
  const prvni = await pokuty.predepis(m1, 'VINIK');
  ok(prvni.uzBylo === false, 'první kontumace pokutu předepíše');
  ok(prvni.pokuta.amount === 2200, `pokuta je 2 200 Kč, je ${prvni.pokuta.amount}`);
  ok(prvni.pokuta.teamId === 'VINIK', 'pokutu platí ten, kdo se nedostavil');
  ok(prvni.pokuta.status === 'PENDING', 'nová pokuta je nezaplacená');
  ok(/04\.10\.2026|4\. 10\. 2026/.test(prvni.pokuta.reason.replace(/\s/g, ' ')),
    `důvod nese datum zápasu: ${prvni.pokuta.reason}`);

  const druhy = await pokuty.predepis(m1, 'VINIK');
  ok(druhy.uzBylo === true, 'druhé předepsání téže kontumace pokutu nezdvojí');
  ok(db.fines.length === 1, `v databázi je jedna pokuta, je jich ${db.fines.length}`);

  // --- 2. plochá částka ---
  // Kdyby se pokuta počítala z propadlých startů, tenhle případ by stál nulu.
  reset();
  const bezSestavy = await pokuty.predepis(zapas('M2'), 'NIKDO_SE_NEPRIHLASIL');
  ok(bezSestavy.pokuta.amount === 2200,
    'tým, kterému se do sestavy nikdo nepřihlásil, platí stejně jako ostatní');

  // --- 3. brána: co drží a co pustí ---
  reset();
  await pokuty.predepis(zapas('M3'), 'T1');
  ok((await pokuty.nezaplacene('T1')).length === 1, 'nezaplacená pokuta se najde');
  ok((await pokuty.nezaplacene('T2')).length === 0, 'cizí tým pokutu nedrží');

  db.fines[0].status = 'PAID';
  ok((await pokuty.nezaplacene('T1')).length === 0, 'zaplacená pokuta už nedrží');

  db.fines[0].status = 'WAIVED';
  ok((await pokuty.nezaplacene('T1')).length === 0, 'odpuštěná pokuta taky nedrží');

  db.fines[0].status = 'OVERDUE';
  ok((await pokuty.nezaplacene('T1')).length === 1, 'pokuta po splatnosti drží dál');

  // --- 4. tři a dost ---
  reset();
  db.matches = [
    { id: 'A', forfeitTeamId: 'T1', season: '2026/27' },
    { id: 'B', forfeitTeamId: 'T1', season: '2026/27' },
    { id: 'C', forfeitTeamId: 'T1', season: '2025/26' },
    { id: 'D', forfeitTeamId: 'T2', season: '2026/27' },
  ];
  ok(await pokuty.pocetKontumaci('T1', '2026/27') === 2,
    'kontumace z minulé sezóny se do počtu nepletou');
  ok(await pokuty.pocetKontumaci('T2', '2026/27') === 1, 'cizí kontumace se nepočítají');

  db.matches.push({ id: 'E', forfeitTeamId: 'T1', season: '2026/27' });
  ok(await pokuty.pocetKontumaci('T1', '2026/27') === 3,
    'třetí kontumace v sezóně je vidět — po ní tým podle pravidel končí');

  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
})();
