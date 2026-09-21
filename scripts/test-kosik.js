/**
 * Test košíku — běží bez databáze, prisma je nahrazená mockem.
 *
 *   node scripts/test-kosik.js
 *
 * Košík existuje kvůli poplatkům: Stripe si u české karty bere
 * 1,5 % + 6,50 Kč a ta pevná část se platí za každou transakci zvlášť.
 * Testy hlídají to, co se u peněz nesmí pokazit:
 *
 *   1. Otevřený košík je nejvýš jeden, položky se do něj přidávají.
 *   2. Licence, superlicence ani registrace se v košíku neopakují.
 *      Balíček ano — dva balíčky naráz koupit jde.
 *   3. Cena se drží na položce. Když se mezitím změní ceník, člověk
 *      zaplatí to, co viděl.
 *   4. Zaúčtování projde všechny položky a nastaví je na PAID.
 *   5. Položka, která už zaplacená byla, se přeskočí a ohlásí se jako
 *      dvojí platba — nesmí tiše přepsat tu první.
 *   6. Zaúčtování je idempotentní: druhý webhook nic nezdvojí.
 *   7. Balíček vzniká až zaplacením, ne vložením do košíku.
 *   8. Vrácení peněz zruší všechny položky a zbytek balíčku.
 */
const Module = require('module');
const { hlidacPoli } = require('./lib/pole-modelu');

// ---------- mock databáze ----------

let db, idSeq;

function reset() {
  idSeq = 0;
  db = {
    carts: [], items: [], packs: [], payments: [], teamPayments: [], players: [],
    openEntries: [], uses: [], codes: [],
  };
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
  $transaction: async (fn) => fn(fakePrisma),
  cart: {
    findFirst: async ({ where }) => {
      const c = db.carts.find(x => shoda(x, where));
      return c ? { ...c, items: db.items.filter(i => i.cartId === c.id) } : null;
    },
    findUnique: async ({ where }) => {
      const c = db.carts.find(x => shoda(x, where));
      return c ? { ...c, items: db.items.filter(i => i.cartId === c.id) } : null;
    },
    create: async ({ data }) => {
      const c = { id: `K${++idSeq}`, status: 'PENDING', amount: 0, paidAmount: 0, ...data };
      db.carts.push(c);
      return c;
    },
    update: async ({ where, data }) => {
      const c = db.carts.find(x => x.id === where.id);
      Object.assign(c, data);
      return c;
    },
  },
  cartItem: {
    create: async ({ data }) => {
      const i = { id: `P${++idSeq}`, createdAt: new Date(), ...data };
      db.items.push(i);
      return i;
    },
    findUnique: async ({ where }) => {
      const i = db.items.find(x => x.id === where.id);
      return i ? { ...i, cart: db.carts.find(c => c.id === i.cartId) } : null;
    },
    delete: async ({ where }) => {
      const idx = db.items.findIndex(x => x.id === where.id);
      return db.items.splice(idx, 1)[0];
    },
  },
  playerPayment: {
    findUnique: async ({ where }) => db.payments.find(p => shoda(p, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const radky = db.payments.filter(p => shoda(p, where));
      radky.forEach(p => Object.assign(p, data));
      return { count: radky.length };
    },
  },
  player: {
    findUnique: async ({ where }) => db.players.find(x => x.id === where.id) ?? null,
    update: async ({ where, data }) => {
      const p = db.players.find(x => x.id === where.id) ?? { id: where.id };
      Object.assign(p, data);
      if (!db.players.includes(p)) db.players.push(p);
      return p;
    },
  },
  teamPayment: {
    findUnique: async ({ where }) => db.teamPayments.find(t => shoda(t, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const radky = db.teamPayments.filter(t => shoda(t, where));
      radky.forEach(t => Object.assign(t, data));
      return { count: radky.length };
    },
  },
  matchPack: {
    create: async ({ data }) => { const b = { id: `B${++idSeq}`, ...data }; db.packs.push(b); return b; },
    findMany: async ({ where }) => db.packs.filter(b => shoda(b, where)),
    update: async ({ where, data }) => {
      const b = db.packs.find(x => x.id === where.id);
      Object.assign(b, data);
      return b;
    },
  },
  openEntry: {
    findUnique: async ({ where }) => {
      const k = where.playerId_season;
      return db.openEntries.find(e => e.playerId === k.playerId && e.season === k.season) ?? null;
    },
    upsert: async ({ where, create, update }) => {
      const k = where.playerId_season;
      const uz = db.openEntries.find(e => e.playerId === k.playerId && e.season === k.season);
      if (uz) { Object.assign(uz, update); return uz; }
      const novy = { id: `O${++idSeq}`, ...create };
      db.openEntries.push(novy);
      return novy;
    },
    updateMany: async ({ where, data }) => {
      const radky = db.openEntries.filter(e => shoda(e, where));
      radky.forEach(e => Object.assign(e, data));
      return { count: radky.length };
    },
  },
  // Potvrzení platby chodí e-mailem; v testu se jen počítá, komu by šlo.
  user: { findUnique: async ({ where }) => ({ id: where.id, email: 'test@fsl.cz', player: null }) },
  referralUse:  { findUnique: async () => null, update: async () => ({}) },
  referralCode: { findUnique: async () => null },
};

// ---------- mock hlídá názvy sloupců ----------
//
// Mock bral dřív jakýkoli název pole, takže `method` místo `licMethod`
// prošlo testy a spadlo až na produkci u první reálné platby. Zápisy proto
// projdou proti `schema.prisma` — stejná kontrola, jakou dělá Prisma.
const overPole = hlidacPoli();
const ZAPISY   = ['create', 'update', 'updateMany', 'upsert'];

for (const [model, api] of Object.entries(fakePrisma)) {
  if (model.startsWith('$') || typeof api !== 'object') continue;
  for (const op of ZAPISY) {
    if (typeof api[op] !== 'function') continue;
    const puvodni = api[op].bind(api);
    api[op] = async (args = {}) => {
      for (const kde of ['data', 'create', 'update']) {
        if (args[kde]) overPole(model, args[kde]);
      }
      return puvodni(args);
    };
  }
}

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  return orig.apply(this, arguments);
};

const kosik = require('../src/services/kosik');

// ---------- pomocníci ----------

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const SEZONA = '2026/27';
const pridej = (data) => kosik.pridej('U1', SEZONA, { season: SEZONA, ...data });

// ---------- testy ----------

(async () => {
  // --- 1. skládání košíku ---
  reset();
  await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H1', amount: 300 });
  await pridej({ kind: 'MATCH_PACK', playerId: 'H1', packSize: 16, amount: 2600 });
  let cart = await kosik.otevreny('U1');
  ok(db.carts.length === 1, 'druhá položka nezaloží druhý košík');
  ok(cart.items.length === 2, 'v košíku jsou obě položky');
  ok(kosik.soucet(cart.items) === 2900, `součet je 2 900 Kč, je ${kosik.soucet(cart.items)}`);

  // --- 2. co se smí opakovat a co ne ---
  const podruhe = await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H1', amount: 300 });
  ok(podruhe.ok === false && podruhe.code === 'ALREADY_IN_CART', 'licence se do košíku nedá dvakrát');

  const jinyHrac = await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H2', amount: 300 });
  ok(jinyHrac.ok === true, 'licence jinému hráči ale ano — vedoucí platí za svoje lidi');

  const druhyBalicek = await pridej({ kind: 'MATCH_PACK', playerId: 'H1', packSize: 3, amount: 550 });
  ok(druhyBalicek.ok === true, 'dva balíčky naráz koupit jde');

  // --- 3. cena se drží na položce ---
  cart = await kosik.otevreny('U1');
  const licence = cart.items.find(i => i.kind === 'PLAYER_LICENSE');
  ok(licence.amount === 300, 'cena je uložená u položky, ne dotažená z ceníku při placení');

  // --- 4. vyhození položky ---
  const vyhozeni = await kosik.odeber('U1', druhyBalicek.item.id);
  ok(vyhozeni.ok === true, 'položka jde z košíku vyhodit');
  ok((await kosik.otevreny('U1')).items.length === 3, 'a v košíku po ní nic nezůstane');

  const cizi = await kosik.odeber('U9', licence.id);
  ok(cizi.ok === false && cizi.code === 'FORBIDDEN', 'cizí košík měnit nejde');

  // --- 5. zaúčtování ---
  reset();
  db.payments.push({ playerId: 'H1', licStatus: 'PENDING', superStatus: 'PENDING', season: SEZONA });
  db.teamPayments.push({ teamId: 'T1', status: 'PENDING', season: SEZONA });
  await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H1', amount: 300 });
  await pridej({ kind: 'TEAM_REG', teamId: 'T1', amount: 3000 });
  await pridej({ kind: 'MATCH_PACK', playerId: 'H1', packSize: 16, amount: 2600 });

  const otevreny = await kosik.otevreny('U1');
  ok(db.packs.length === 0, 'balíček při vložení do košíku ještě nevzniká');

  const vysledek = await kosik.zauctuj(otevreny.id, { method: 'stripe', stripeId: 'cs_1', castka: 5900 });
  ok(vysledek.ok && !vysledek.uzBylo, 'košík se zaúčtoval');
  ok(db.payments[0].licStatus === 'PAID', 'licence je zaplacená');
  ok(db.players.find(p => p.id === 'H1')?.licensed === true, 'a hráč je označený jako licencovaný');
  ok(db.teamPayments[0].status === 'PAID', 'registrace týmu je zaplacená');
  ok(db.packs.length === 1 && db.packs[0].status === 'PAID', 'balíček vznikl až zaplacením');
  ok(db.packs[0].remaining === 16, 'a má plný počet startů');
  ok(db.carts[0].status === 'PAID' && db.carts[0].paidAmount === 5900, 'košík je zaplacený');
  ok((vysledek.dvoji ?? []).length === 0, 'nic se nehlásí jako dvojí platba');

  // --- 6. idempotence ---
  const znovu = await kosik.zauctuj(otevreny.id, { method: 'stripe', stripeId: 'cs_1', castka: 5900 });
  ok(znovu.uzBylo === true, 'druhý webhook košík znovu nezaúčtuje');
  ok(db.packs.length === 1, 'a nevznikne druhý balíček');

  // --- 7. dvojí platba ---
  reset();
  db.payments.push({ playerId: 'H1', licStatus: 'PAID', superStatus: 'PENDING', season: SEZONA });
  await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H1', amount: 300 });
  await pridej({ kind: 'SUPER_LICENSE', playerId: 'H1', amount: 300 });
  const sDvoji = await kosik.otevreny('U1');
  const vysledek2 = await kosik.zauctuj(sDvoji.id, { method: 'bank', castka: 600 });
  ok(vysledek2.dvoji.length === 1, 'už zaplacená položka se ohlásí jako dvojí platba');
  ok(vysledek2.dvoji[0].kind === 'PLAYER_LICENSE', 'a je to ta licence');
  ok(db.payments[0].superStatus === 'PAID', 'zbytek košíku se přesto zaúčtuje');

  // --- 8. vrácení peněz ---
  reset();
  db.payments.push({ playerId: 'H1', licStatus: 'PENDING', superStatus: 'PENDING', season: SEZONA });
  await pridej({ kind: 'PLAYER_LICENSE', playerId: 'H1', amount: 300 });
  await pridej({ kind: 'MATCH_PACK', playerId: 'H1', packSize: 3, amount: 550 });
  const kVraceni = await kosik.otevreny('U1');
  await kosik.zauctuj(kVraceni.id, { method: 'stripe', stripeId: 'cs_2', castka: 850 });
  db.packs[0].remaining = 1; // dva starty se mezitím odehrály

  const vraceni = await kosik.vrat(kVraceni.id);
  ok(vraceni.ok === true, 'vrácení peněz projde');
  ok(db.payments[0].licStatus === 'PENDING', 'licence je zase nezaplacená');
  ok(db.players.find(p => p.id === 'H1')?.licensed === false, 'a hráč přišel o licenci');
  ok(db.packs[0].status === 'REFUNDED' && db.packs[0].remaining === 0, 'zbytek balíčku se zrušil');
  ok(vraceni.vycerpane.length === 1 && vraceni.vycerpane[0].vycerpano === 2,
    'odehrané starty se hlásí supervisorovi, zpátky se neberou');
  ok(db.carts[0].status === 'REFUNDED', 'košík je označený jako vrácený');

  // --- 9. balík „Virtuální vedoucí" ---
  //
  // Hlídá se hlavně to, že se licence nezaplatí dvakrát: uvnitř balíku je
  // a hráč po zaplacení musí být licencovaný, jinak zaplatí 800 Kč a systém
  // ho do sestavy stejně nepustí.
  reset();
  db.players.push({ id: 'H1', position: 'Brankář' });
  db.payments.push({ playerId: 'H1', licStatus: 'PENDING', superStatus: 'PENDING', season: SEZONA });
  await pridej({ kind: 'OPEN_ENTRY', playerId: 'H1', amount: 800 });
  const balik = await kosik.otevreny('U1');
  ok(kosik.nazev(balik.items[0]) === 'Virtuální vedoucí (startovné + licence)',
    'název položky říká, že je uvnitř licence');
  await kosik.zauctuj(balik.id, { method: 'stripe', stripeId: 'cs_v1', castka: 800 });

  const zapsany = db.openEntries[0];
  ok(zapsany?.status === 'PAID' && zapsany.paidAmount === 800, 'balík je zaplacený');
  ok(zapsany.entryFee === 500 && zapsany.licFee === 300,
    'a je vidět, že je to 500 startovné + 300 licence');
  ok(zapsany.slot === 'GOALKEEPER', 'brankář se zapíše jako brankář, ne jako hráč do pole');
  ok(db.payments[0].licStatus === 'PAID' && db.payments[0].licPaidAmount === 300,
    'licence uvnitř balíku se vystavila — jinak hráč zaplatí 800 a licenci nemá');
  ok(db.players.find(p => p.id === 'H1')?.licensed === true, 'a hráč je licencovaný');

  // Kdo licenci má, platí jen startovné — a licence se nesmí přepsat znovu.
  reset();
  db.players.push({ id: 'H2', position: 'Útočník' });
  db.payments.push({
    playerId: 'H2', licStatus: 'PAID', licPaidAmount: 300, superStatus: 'PENDING', season: SEZONA,
  });
  await pridej({ kind: 'OPEN_ENTRY', playerId: 'H2', amount: 500 });
  const samotne = await kosik.otevreny('U1');
  ok(kosik.nazev(samotne.items[0]) === 'Virtuální vedoucí (startovné)',
    'bez licence uvnitř se položka jmenuje jinak');
  await kosik.zauctuj(samotne.id, { method: 'transfer', castka: 500 });
  ok(db.openEntries[0].licFee === 0, 'licence se do balíku nezapočítá podruhé');
  ok(db.payments[0].licPaidAmount === 300, 'a zaplacená licence zůstala, jak byla');

  // Dvojí platba a vrácení.
  const znovuBalik = await kosik.zauctujPolozku(
    { kind: 'OPEN_ENTRY', playerId: 'H2', season: SEZONA, amount: 500 }, { method: 'stripe' }, fakePrisma);
  ok(znovuBalik === false, 'zaplacený balík se podruhé nezaúčtuje');

  reset();
  db.players.push({ id: 'H3', position: 'Útočník' });
  db.payments.push({ playerId: 'H3', licStatus: 'PENDING', superStatus: 'PENDING', season: SEZONA });
  await pridej({ kind: 'OPEN_ENTRY', playerId: 'H3', amount: 800 });
  const kVraceniBalik = await kosik.otevreny('U1');
  await kosik.zauctuj(kVraceniBalik.id, { method: 'stripe', stripeId: 'cs_v2', castka: 800 });
  await kosik.vrat(kVraceniBalik.id);
  ok(db.openEntries[0].status === 'REFUNDED', 'vrácený balík se označí jako vrácený');
  ok(db.payments[0].licStatus === 'PENDING' && db.players.find(p => p.id === 'H3').licensed === false,
    'a licence, která v něm byla, padá s ním');

  console.log(fail === 0 ? '\nVšechny testy prošly.' : `\n${fail} testů selhalo.`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
