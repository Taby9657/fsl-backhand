/**
 * Test párování bankovních plateb – běží proti in-memory náhradě Prismy,
 * takže nepotřebuje databázi:
 *
 *   node scripts/test-payment-matching.js
 *
 * Ověřuje hlavně to, kvůli čemu vznikl sloupec superVariableSymbol: že se
 * převod na superlicenci nezaúčtuje jako běžná licence a nesníží dluh
 * za registraci týmu.
 *
 * Od 7. 9. navíc dvě věci, kvůli kterým se ztrácely peníze:
 *   - částečná platba se připíše a doplatek ji dorovná (dřív se obojí zahodilo)
 *   - registrace týmu zaplacená v minulé sezóně neplatí pro tu aktuální
 *
 * Od 9. 9. místo poplatku za domácí zápas (prefix 4, zrušen) balíčky
 * zápasů (prefix 7). U nich na převodu záleží nejvíc: karta ukousne
 * z každého balíčku 1,5 % + 6,50 Kč, převod nic.
 */

const path = require('path');

/* ---------- in-memory data ---------- */

function freshDb() {
  return {
    playerPayments: [
      {
        id: 'pp1',
        playerId: 'p1',
        season: '2026/27',
        licFee: 300,
        licStatus: 'PENDING',
        licPaidAt: null,
        licMethod: null,
        licPaidAmount: 0,
        superFee: 300,
        superStatus: 'PENDING',
        superPaidAt: null,
        superLic: false,
        superPaidAmount: 0,
        variableSymbol: '1000001',
        superVariableSymbol: '2000001',
        player: { id: 'p1', firstName: 'Tomáš', lastName: 'Novák', userId: 'u1' },
      },
    ],
    teamPayments: [
      {
        id: 'tp1',
        teamId: 't1',
        season: '2026/27',
        amount: 3000,
        status: 'PENDING',
        paidAmount: 0,
        paidAt: null,
        method: null,
        variableSymbol: '3000001',
        team: { id: 't1', name: 'Benavidez Eagles' },
      },
    ],
    matches: [
      {
        id: 'm1',
        homeTeamId: 't1',
        date: new Date('2026-09-10T18:00:00Z'),
        homeTeam: { id: 't1', name: 'Benavidez Eagles' },
      },
    ],
    fines: [
      {
        id: 'f1',
        teamId: 't1',
        matchId: 'm1',
        season: '2026/27',
        amount: 3000,
        reason: 'Kontumace zápasu 4. 10. 2026',
        status: 'PENDING',
        paidAmount: 0,
        paidAt: null,
        method: null,
        variableSymbol: '5000001',
        team: { id: 't1', name: 'Benavidez Eagles', abbr: 'BEN' },
      },
    ],
    matchPacks: [
      {
        id: 'mp1',
        playerId: 'p1',
        season: '2026/27',
        size: 7,
        remaining: 7,
        price: 1600,
        status: 'PENDING',
        paidAmount: 0,
        paidAt: null,
        method: null,
        isReward: false,
        variableSymbol: '7000001',
        player: { id: 'p1', firstName: 'Tomáš', lastName: 'Novák', userId: 'u1' },
      },
    ],
    players: [{ id: 'p1', licensed: false }],
    managers: [{ userId: 'u9', teamId: 't1' }],
    users: [{ id: 'u-super', isSupervisor: true }],
    settings: { id: 'singleton', currentSeason: '2026/27' },
    notifications: [],
  };
}

let db = freshDb();

const whereMatch = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'notIn' in v) return !v.notIn.includes(row[k]);
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });

const fakePrisma = {
  playerPayment: {
    findUnique: async ({ where }) =>
      db.playerPayments.find((r) => whereMatch(r, where)) ?? null,
    findFirst: async ({ where }) =>
      db.playerPayments.find((r) => whereMatch(r, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const rows = db.playerPayments.filter((r) => whereMatch(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  // Balíčky zápasů (prefix 7). Kredit vzniká teprve při plné částce, stejně
  // jako u licencí — proto tu musí být i updateMany, ne jen čtení.
  matchPack: {
    findUnique: async ({ where }) => db.matchPacks.find((r) => whereMatch(r, where)) ?? null,
    findFirst: async ({ where }) => db.matchPacks.find((r) => whereMatch(r, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const rows = db.matchPacks.filter((r) => whereMatch(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    update: async ({ where, data }) => {
      const row = db.matchPacks.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  // Pokuty za kontumaci (prefix 5).
  // Košík (VS s prefixem 8). V těchhle testech žádný není — ale párování se
  // na něj ptá, takže tabulka musí existovat, jinak spadne dotaz, ne test.
  cart: {
    findUnique: async ({ where }) => db.carts?.find((r) => whereMatch(r, where)) ?? null,
    updateMany: async () => ({ count: 0 }),
  },
  fine: {
    findUnique: async ({ where }) => db.fines.find((r) => whereMatch(r, where)) ?? null,
    findMany:   async ({ where }) => db.fines.filter((r) => whereMatch(r, where)),
    updateMany: async ({ where, data }) => {
      const rows = db.fines.filter((r) => whereMatch(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  // Odměna za doporučení: v tomhle testu nikdo nikoho nepřivedl.
  referralUse: {
    findUnique: async () => null,
  },
  teamPayment: {
    findUnique: async ({ where }) =>
      db.teamPayments.find((r) => whereMatch(r, where)) ?? null,
    findFirst: async ({ where }) =>
      db.teamPayments.find((r) => whereMatch(r, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const rows = db.teamPayments.filter((r) => whereMatch(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  match: {
    findFirst: async ({ where }) => db.matches.find((r) => whereMatch(r, where)) ?? null,
    findUnique: async ({ where }) => db.matches.find((r) => whereMatch(r, where)) ?? null,
    updateMany: async ({ where, data }) => {
      const rows = db.matches.filter((r) => whereMatch(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  player: {
    update: async ({ where, data }) => {
      const row = db.players.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  manager: {
    findMany: async ({ where }) => db.managers.filter((r) => whereMatch(r, where)),
  },
  user: {
    findMany: async ({ where }) => db.users.filter((r) => whereMatch(r, where)),
  },
  // Aktuální sezóna – bez ní by párování registrace týmu nevědělo,
  // za jaký ročník se zrovna platí.
  settings: {
    findUnique: async () => db.settings,
    // Zdraví párování se zapisuje do Settings. Bez upsertu by `bankSync`
    // spadl na neexistující metodě dřív, než by cokoli spároval.
    upsert: async ({ create, update }) => {
      if (!db.settings) {
        db.settings = { ...create };
        return db.settings;
      }
      for (const [k, v] of Object.entries(update)) {
        db.settings[k] = v && typeof v === 'object' && 'increment' in v
          ? (db.settings[k] ?? 0) + v.increment
          : v;
      }
      return db.settings;
    },
  },
};

/* ---------- injekce falešné Prismy ---------- */

const prismaPath = require.resolve(path.join(__dirname, '..', 'src', 'lib', 'prisma.js'));
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };

const notifPath = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'notifications.js'));
require.cache[notifPath] = {
  id: notifPath,
  filename: notifPath,
  loaded: true,
  exports: {
    createNotification: async (userId, title, body) => {
      db.notifications.push({ userId, title, body });
    },
  },
};

const { matchTransaction, parseTransaction, bankSync, stavParovani, jeChybaTokenu } =
  require('../src/services/bankSync');
const { smiKPlatbe } = require('../src/utils/opravneniPlatby');

/* ---------- testovací runner ---------- */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  db = freshDb();
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tx = (vs, amount) => ({
  transactionId: `tx-${vs}`,
  amount,
  variableSymbol: vs,
  date: new Date('2026-08-24T10:00:00Z'),
});

/* ---------- testy ---------- */

(async () => {
  await test('licence: VS s prefixem 1 zaplatí licenci', async () => {
    const r = await matchTransaction(tx('1000001', 300));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'PLAYER_LICENSE', `typ ${r.type}`);
    assert(db.playerPayments[0].licStatus === 'PAID', 'licStatus není PAID');
    assert(db.playerPayments[0].superStatus === 'PENDING', 'omylem zaplacena superlicence');
    assert(db.players[0].licensed === true, 'hráč nemá licensed=true');
  });

  await test('superlicence: VS s prefixem 2 zaplatí superlicenci, ne licenci', async () => {
    const r = await matchTransaction(tx('2000001', 300));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'SUPER_LICENSE', `typ ${r.type}`);
    assert(db.playerPayments[0].superStatus === 'PAID', 'superStatus není PAID');
    assert(db.playerPayments[0].superLic === true, 'superLic není true');
    assert(db.playerPayments[0].licStatus === 'PENDING', 'omylem zaplacena běžná licence');
  });

  await test('registrace týmu: VS s prefixem 3', async () => {
    const r = await matchTransaction(tx('3000001', 3000));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'TEAM_REG', `typ ${r.type}`);
    assert(db.teamPayments[0].status === 'PAID', 'status není PAID');
    assert(db.matchPacks[0].status === 'PENDING', 'omylem zaplacen balíček');
  });

  await test('balíček zápasů: VS s prefixem 7 zaplatí balíček, ne registraci', async () => {
    const r = await matchTransaction(tx('7000001', 1600));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'MATCH_PACK', `typ ${r.type}`);
    assert(db.matchPacks[0].status === 'PAID', 'balíček není PAID');
    assert(db.teamPayments[0].status === 'PENDING', 'omylem zaplacena registrace týmu');
  });

  await test('balíček zápasů: notifikace jde hráči, ne vedoucímu', async () => {
    await matchTransaction(tx('7000001', 1600));
    assert(db.notifications.some((n) => n.userId === 'u1'), 'hráč nedostal oznámení');
    assert(!db.notifications.some((n) => n.userId === 'u9'), 'oznámení šlo vedoucímu týmu');
  });

  await test('pokuta: VS s prefixem 5 zaplatí pokutu, ne registraci', async () => {
    const r = await matchTransaction(tx('5000001', 3000));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'FINE', `typ ${r.type}`);
    assert(db.fines[0].status === 'PAID', 'pokuta není PAID');
    assert(db.teamPayments[0].status === 'PENDING', 'omylem zaplacena registrace týmu');
  });

  await test('pokuta: částečná platba tým hrát nepustí', async () => {
    // Zbytek se dopočítává z fixture, ne natvrdo: ceník se mění a tenhle
    // test už kvůli tomu spadl několikrát.
    const celkem   = db.fines[0].amount;
    const zaloha   = 1000;
    const zbyva    = celkem - zaloha;
    const r = await matchTransaction(tx('5000001', zaloha));
    assert(r.matched && r.partial, `částka se nepřipsala: ${r.reason}`);
    assert(db.fines[0].status === 'PENDING', 'pokuta označena jako zaplacená');
    assert(db.fines[0].paidAmount === zaloha, `připsáno ${db.fines[0].paidAmount}`);
    const n = db.notifications.find((x) => x.userId === 'u9');
    assert(n && new RegExp(String(zbyva)).test(n.body),
      `vedoucí nedostal zprávu, kolik chybí: ${n?.body}`);
    const r2 = await matchTransaction({ ...tx('5000001', zbyva), transactionId: 'tx-doplatek' });
    assert(r2.matched && !r2.partial, `doplatek neprošel: ${r2.reason}`);
    assert(db.fines[0].status === 'PAID', 'pokuta není zaplacená ani po doplacení');
  });

  await test('pokuta: odpuštěnou už převod nepřepíše', async () => {
    db.fines[0].status = 'WAIVED';
    const r = await matchTransaction(tx('5000001', 3000));
    assert(!r.matched, 'odpuštěná pokuta se znovu zaplatila');
    assert(db.fines[0].status === 'WAIVED', 'stav se přepsal');
  });

  // Poplatek za domácí zápas skončil 9. 9. 2026. Prefix 4 se nerecykluje,
  // takže starý převod nesmí zaplatit nic jiného — jen spadnout mezi
  // nespárované, kde se na něj podívá supervisor.
  await test('zrušený poplatek: VS s prefixem 4 se už nespáruje', async () => {
    const r = await matchTransaction(tx('4000001', 3000));
    assert(!r.matched, 'prefix 4 se pořád páruje');
    assert(db.teamPayments[0].status === 'PENDING', 'zaplatil omylem registraci');
    assert(db.matchPacks[0].status === 'PENDING', 'zaplatil omylem balíček');
  });

  // ---------- částečné platby ----------
  // Dřív se nižší částka zahodila („nedostatečná částka") a nikam se nezapsala.
  // Kdo poslal 200 Kč a doplatil 50, zůstal napořád nezaplacený a peníze
  // ležely na účtu ligy bez majitele.

  await test('nízká částka na licenci se připíše, ale nezaplatí ji', async () => {
    const r = await matchTransaction(tx('1000001', 200));
    assert(r.matched, `částka se nepřipsala: ${r.reason}`);
    assert(r.partial === true, 'chybí příznak částečné platby');
    assert(r.missing === 100, `chybí má být 100, je ${r.missing}`);
    assert(db.playerPayments[0].licPaidAmount === 200, `připsáno ${db.playerPayments[0].licPaidAmount}`);
    assert(db.playerPayments[0].licStatus === 'PENDING', 'licence označena jako zaplacená');
    assert(db.players[0].licensed === false, 'hráč dostal licenci po částečné platbě');
  });

  await test('doplatek dorovná částečnou platbu licence', async () => {
    await matchTransaction(tx('1000001', 200));
    const r = await matchTransaction({ ...tx('1000001', 100), transactionId: 'tx-doplatek' });
    assert(r.matched && !r.partial, `doplatek neprošel: ${r.reason}`);
    assert(db.playerPayments[0].licStatus === 'PAID', 'licence není PAID ani po doplacení');
    assert(db.playerPayments[0].licPaidAmount === 300, `celkem ${db.playerPayments[0].licPaidAmount}`);
    assert(db.players[0].licensed === true, 'hráč nemá licensed=true');
  });

  await test('částečná platba na superlicenci se nepřičte k licenci', async () => {
    await matchTransaction(tx('2000001', 100));
    assert(db.playerPayments[0].superPaidAmount === 100, 'nepřipsáno na superlicenci');
    assert(db.playerPayments[0].licPaidAmount === 0, 'přičteno omylem k licenci');
  });

  // Registrace stojí 3 000 Kč, takže se platí 1 000 + 2 000. Částky tu musí
  // sedět s ceníkem: se starými osmi tisíci by první „částečná" platba
  // registraci rovnou přeplatila a test by ověřoval něco jiného, než tvrdí.
  await test('doplatek dorovná registraci týmu', async () => {
    await matchTransaction(tx('3000001', 1000));
    assert(db.teamPayments[0].status === 'PENDING', 'registrace zaplacena z části');
    assert(db.teamPayments[0].paidAmount === 1000, `připsáno ${db.teamPayments[0].paidAmount}`);
    const r = await matchTransaction({ ...tx('3000001', 2000), transactionId: 'tx-doplatek' });
    assert(r.matched && !r.partial, `doplatek neprošel: ${r.reason}`);
    assert(db.teamPayments[0].status === 'PAID', 'registrace není PAID');
    assert(db.teamPayments[0].paidAmount === 3000, `celkem ${db.teamPayments[0].paidAmount}`);
  });

  await test('nízká částka na balíček se připíše, ale kredit nedá', async () => {
    const r = await matchTransaction(tx('7000001', 600));
    assert(r.matched && r.partial, `částka se nepřipsala: ${r.reason}`);
    assert(db.matchPacks[0].status === 'PENDING', 'balíček označen jako zaplacený');
    assert(db.matchPacks[0].paidAmount === 600, `připsáno ${db.matchPacks[0].paidAmount}`);
    const r2 = await matchTransaction({ ...tx('7000001', 1000), transactionId: 'tx-doplatek' });
    assert(r2.matched && !r2.partial, `doplatek neprošel: ${r2.reason}`);
    assert(db.matchPacks[0].status === 'PAID', 'balíček není zaplacený ani po doplacení');
    assert(db.matchPacks[0].remaining === 7, 'doplacení sáhlo na zbývající starty');
  });

  await test('částečná platba pošle plátci oznámení, kolik chybí', async () => {
    await matchTransaction(tx('1000001', 200));
    const n = db.notifications.find((x) => x.userId === 'u1');
    assert(n, 'hráč nedostal oznámení');
    assert(/chybí 100/.test(n.body), `oznámení neříká, kolik chybí: ${n.body}`);
  });

  await test('přeplatek zaplatí a upozorní supervisora', async () => {
    const r = await matchTransaction(tx('1000001', 400));
    assert(r.matched && !r.partial, 'přeplatek neprošel');
    assert(db.playerPayments[0].licStatus === 'PAID', 'licence není PAID');
    assert(db.notifications.some((n) => n.userId === 'u-super' && /Přeplatek/.test(n.title)),
      'supervisor se o přeplatku nedozvěděl');
  });

  // ---------- sezóna u registrace týmu ----------
  // TeamPayment je jeden řádek na tým se sloupcem season. Řádek PAID z minulé
  // sezóny neznamená, že je zaplaceno teď — jinak tým, který zaplatil loni,
  // o poplatek letos nikdy nepožádá.

  await test('registrace zaplacená v minulé sezóně neplatí pro tu aktuální', async () => {
    db.teamPayments[0].status     = 'PAID';
    db.teamPayments[0].season     = '2025/26';
    db.teamPayments[0].paidAmount = 3000;
    db.teamPayments[0].paidAt     = new Date('2025-08-31T00:00:00Z');

    const r = await matchTransaction(tx('3000001', 3000));
    assert(r.matched, `platba za novou sezónu se nespárovala: ${r.reason}`);
    assert(db.teamPayments[0].season === '2026/27', `řádek zůstal v ${db.teamPayments[0].season}`);
    assert(db.teamPayments[0].paidAmount === 3000, `částka se nesečetla správně: ${db.teamPayments[0].paidAmount}`);
  });

  await test('částečná platba za novou sezónu nesčítá loňskou částku', async () => {
    db.teamPayments[0].status     = 'PAID';
    db.teamPayments[0].season     = '2025/26';
    db.teamPayments[0].paidAmount = 3000;   // loni zaplaceno celé

    // Letos přijde jen tisícovka. Kdyby se k ní přičetla loňská částka,
    // vyšlo by to na 4 000 a registrace by se označila za zaplacenou,
    // aniž by letos dorazily zbylé dva tisíce.
    const r = await matchTransaction(tx('3000001', 1000));
    assert(r.partial === true, 'loňská částka se započítala do letoška');
    assert(db.teamPayments[0].status === 'PENDING', `stav ${db.teamPayments[0].status}`);
    assert(db.teamPayments[0].paidAmount === 1000, `připsáno ${db.teamPayments[0].paidAmount}`);
  });

  await test('registrace zaplacená v aktuální sezóně se podruhé nezaplatí', async () => {
    db.teamPayments[0].status     = 'PAID';
    db.teamPayments[0].season     = '2026/27';
    db.teamPayments[0].paidAmount = 3000;

    const r = await matchTransaction(tx('3000001', 3000));
    assert(!r.matched, 'dvojí platba za stejnou sezónu prošla');
    assert(/již zaplacena/.test(r.reason), `nečekaný důvod: ${r.reason}`);
  });

  await test('odpuštěný poplatek se převodem nepřepíše', async () => {
    db.teamPayments[0].status = 'WAIVED';
    const r = await matchTransaction(tx('3000001', 3000));
    assert(!r.matched, 'platba přepsala odpuštěný poplatek');
  });

  await test('druhá platba se stejným VS se nezpracuje dvakrát', async () => {
    await matchTransaction(tx('1000001', 300));
    const r = await matchTransaction(tx('1000001', 300));
    assert(!r.matched, 'duplicitní platba prošla');
  });

  await test('neznámý VS se nespáruje', async () => {
    const r = await matchTransaction(tx('9999999', 300));
    assert(!r.matched, 'neznámý VS prošel');
    assert(/nenalezen/.test(r.reason), `nečekaný důvod: ${r.reason}`);
  });

  await test('chybějící VS se nespáruje', async () => {
    const r = await matchTransaction(tx(null, 300));
    assert(!r.matched, 'platba bez VS prošla');
  });

  // ---------- tvar dat z Fio ----------
  // Fio posílá datum jako `2026-09-01+0200`. `new Date()` na to vrací Invalid
  // Date, což dřív shodilo zápis BankTransaction a platba se nikdy nespárovala.

  const fioTx = (over = {}) => ({
    column0:  { value: '2026-09-01+0200' },
    column1:  { value: 250 },
    column2:  { value: '2703584865' },
    column5:  { value: '10000001' },
    column10: { value: 'Jakub Tabasek' },
    column16: { value: 'FSL licence Jakub Tabasek' },
    column22: { value: 27000123456 },
    ...over,
  });

  await test('Fio: datum s offsetem se naparsuje na platné datum', async () => {
    const t = parseTransaction(fioTx());
    assert(t !== null, 'transakce zahozena');
    assert(!Number.isNaN(t.date.getTime()), 'Invalid Date – zápis do DB by spadl');
    assert(t.date.toISOString() === '2026-08-31T22:00:00.000Z', `nečekané datum ${t.date.toISOString()}`);
  });

  await test('Fio: ostatní pole sedí a ID je řetězec', async () => {
    const t = parseTransaction(fioTx());
    assert(t.transactionId === '27000123456', `ID ${t.transactionId}`);
    assert(t.amount === 250, `částka ${t.amount}`);
    assert(t.variableSymbol === '10000001', `VS ${t.variableSymbol}`);
    assert(t.senderName === 'Jakub Tabasek', `odesílatel ${t.senderName}`);
  });

  await test('Fio: odchozí platba se zahodí', async () => {
    assert(parseTransaction(fioTx({ column1: { value: -250 } })) === null, 'odchozí platba prošla');
  });

  await test('Fio: transakce bez ID pohybu se zahodí', async () => {
    assert(parseTransaction(fioTx({ column22: null })) === null, 'transakce bez ID prošla');
  });

  await test('Fio: rozbité datum shodí na dnešek, ne na Invalid Date', async () => {
    const t = parseTransaction(fioTx({ column0: { value: 'nesmysl' } }));
    assert(!Number.isNaN(t.date.getTime()), 'Invalid Date');
  });

  // ---------- kdo smí na QR kód a variabilní symbol ----------
  // Endpointy /payments/qr a /payments/vs měly jen requireAuth: stačilo být
  // přihlášený kdokoli a znát cizí playerId nebo teamId — a ta jsou vidět
  // ve veřejném API. Šlo si tak vytáhnout VS a částku k cizí platbě.

  const hrac      = { id: 'u1', player: { id: 'p1' }, manager: [] };
  const cizi      = { id: 'u2', player: { id: 'p2' }, manager: [] };
  const vedouci   = { id: 'u9', manager: [{ teamId: 't1' }] };
  const ciziVed   = { id: 'u8', manager: [{ teamId: 't2' }] };
  const supervisor = { id: 'u-super', isSupervisor: true, manager: [] };

  await test('QR: hráč se dostane ke své licenci', async () => {
    assert(await smiKPlatbe(hrac, 'player-license', 'p1') === true, 'vlastník nemá přístup');
    assert(await smiKPlatbe(hrac, 'super-license', 'p1') === true, 'vlastník nemá přístup k superlicenci');
  });

  await test('QR: k cizí licenci se nikdo nedostane', async () => {
    assert(await smiKPlatbe(cizi, 'player-license', 'p1') === false, 'cizí hráč se dostal k licenci');
    assert(await smiKPlatbe(vedouci, 'player-license', 'p1') === false, 'vedoucí se dostal k licenci hráče');
  });

  await test('QR: registraci týmu vidí jen jeho vedoucí', async () => {
    assert(await smiKPlatbe(vedouci, 'team-reg', 't1') === true, 'vedoucí nemá přístup ke svému týmu');
    assert(await smiKPlatbe(ciziVed, 'team-reg', 't1') === false, 'cizí vedoucí se dostal k registraci');
    assert(await smiKPlatbe(hrac, 'team-reg', 't1') === false, 'hráč se dostal k registraci týmu');
  });

  await test('QR: balíček vidí jen hráč, kterému patří', async () => {
    assert(await smiKPlatbe(hrac, 'match-pack', 'mp1') === true, 'vlastník nemá přístup ke svému balíčku');
    assert(await smiKPlatbe(cizi, 'match-pack', 'mp1') === false, 'cizí hráč se dostal k balíčku');
    assert(await smiKPlatbe(vedouci, 'match-pack', 'mp1') === false, 'vedoucí se dostal k balíčku hráče');
  });

  await test('QR: pokutu vidí jen vedoucí potrestaného týmu', async () => {
    assert(await smiKPlatbe(vedouci, 'fine', 'f1') === true, 'vedoucí nemá přístup ke své pokutě');
    assert(await smiKPlatbe(ciziVed, 'fine', 'f1') === false, 'cizí vedoucí se dostal k pokutě');
    assert(await smiKPlatbe(hrac, 'fine', 'f1') === false, 'hráč se dostal k pokutě týmu');
  });

  await test('QR: zrušený poplatek za zápas je neznámý typ', async () => {
    assert(await smiKPlatbe(vedouci, 'home-fee', 'm1') === null, 'home-fee se pořád tváří jako platný typ');
  });

  await test('QR: supervisor vidí všechno', async () => {
    assert(await smiKPlatbe(supervisor, 'player-license', 'p1') === true, 'supervisor nevidí licenci');
    assert(await smiKPlatbe(supervisor, 'team-reg', 't1') === true, 'supervisor nevidí registraci');
    assert(await smiKPlatbe(supervisor, 'match-pack', 'mp1') === true, 'supervisor nevidí balíček');
  });

  await test('QR: nepřihlášený a neznámý typ neprojdou', async () => {
    assert(await smiKPlatbe(null, 'player-license', 'p1') === false, 'anonym prošel');
    assert(await smiKPlatbe(hrac, 'neco-jineho', 'p1') === null, 'neznámý typ neohlášen');
  });

  // ---------- zdraví párování ----------
  // Tichý výpadek je u peněz horší než hlasitá chyba. Když FIO_API_TOKEN
  // chyběl, převody se od 28. 8. do 10. 9. 2026 nepárovaly jedenáct dní
  // a jediná stopa byla řádka v logu Railway.

  await test('bez tokenu párování selže, ohlásí se a zapíše do stavu', async () => {
    db.notifications.length = 0;
    let chyba = null;
    try {
      await bankSync(2);
    } catch (err) {
      chyba = err;
    }
    assert(chyba, 'bankSync bez tokenu neselhal');
    assert(/FIO_API_TOKEN/.test(chyba.message), `nečekaná chyba: ${chyba.message}`);

    const stav = await stavParovani();
    assert(stav.zdrave === false, 'stav se tváří jako zdravý');
    assert(stav.failStreak === 1, `série selhání je ${stav.failStreak}`);
    assert(/FIO_API_TOKEN/.test(stav.lastError ?? ''), 'chyba se nezapsala');
    assert(stav.tokenSet === false, 'stav tvrdí, že token je nastavený');

    const zprava = db.notifications.find(n => /Párování převodů nefunguje/.test(n.title));
    assert(zprava, 'supervisorovi nic nepřišlo');
    assert(/token/i.test(zprava.body), 'zpráva neřekne, že jde o token');
    assert(/Railway/.test(zprava.body), 'zpráva neřekne, kam token doplnit');
  });

  // Runner před každým testem sype čerstvou databázi, takže série se musí
  // nasčítat uvnitř jednoho testu.
  await test('opakované selhání zvyšuje sérii, úspěch ji vynuluje', async () => {
    for (let i = 0; i < 3; i++) {
      try { await bankSync(2); } catch { /* čekaná chyba */ }
    }
    const poSelhanich = await stavParovani();
    assert(poSelhanich.failStreak === 3, `série je ${poSelhanich.failStreak}, čekáno 3`);

    // Simulace úspěšného běhu: to, co bankSync udělá na konci.
    await fakePrisma.settings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: { bankSyncLastOkAt: new Date(), bankSyncFailStreak: 0, bankSyncLastError: null },
    });
    const poUspechu = await stavParovani();
    assert(poUspechu.zdrave === true, 'po úspěchu se stav netváří zdravě');
    assert(poUspechu.failStreak === 0, 'série se nevynulovala');
    assert(poUspechu.lastError === null, 'zůstala stará chyba');
  });

  await test('chyba tokenu se pozná od výpadku Fia', async () => {
    assert(jeChybaTokenu(new Error('FIO_API_TOKEN není nastaven')) === true, 'chybějící token nepoznán');
    assert(jeChybaTokenu(new Error('Fio API chyba 401: neplatny token')) === true, '401 nepoznána');
    assert(jeChybaTokenu(new Error('Fio API chyba 403: zakazano')) === true, '403 nepoznána');
    assert(jeChybaTokenu(new Error('Fio API chyba 500: server error')) === false, '500 označena jako chyba tokenu');
    assert(jeChybaTokenu(new Error('fetch failed')) === false, 'výpadek sítě označen jako chyba tokenu');
  });

  console.log(`\n${passed} prošlo, ${failed} selhalo`);
  process.exit(failed ? 1 : 0);
})();
