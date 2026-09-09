/**
 * Test párování bankovních plateb – běží proti in-memory náhradě Prismy,
 * takže nepotřebuje databázi:
 *
 *   node scripts/test-payment-matching.js
 *
 * Ověřuje hlavně to, kvůli čemu vznikly sloupce superVariableSymbol a
 * Match.homeFeeVS: že se převod na superlicenci nezaúčtuje jako běžná licence
 * a že poplatek za domácí zápas nesníží dluh za registraci týmu.
 *
 * Od 7. 9. navíc dvě věci, kvůli kterým se ztrácely peníze:
 *   - částečná platba se připíše a doplatek ji dorovná (dřív se obojí zahodilo)
 *   - registrace týmu zaplacená v minulé sezóně neplatí pro tu aktuální
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
        licFee: 250,
        licStatus: 'PENDING',
        licPaidAt: null,
        licMethod: null,
        licPaidAmount: 0,
        superFee: 250,
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
        amount: 8000,
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
        homeFeePaid: false,
        homeFeePaidAmount: 0,
        homeFeeVS: '4000001',
        homeTeam: { id: 't1', name: 'Benavidez Eagles' },
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
  // Párování od 9. 9. hledá i balíčky zápasů (prefix 7). Bez téhle tabulky
  // by neznámý VS spadl na chybu místo na „nenalezeno".
  matchPack: {
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

const { matchTransaction, parseTransaction } = require('../src/services/bankSync');
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
    const r = await matchTransaction(tx('1000001', 250));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'PLAYER_LICENSE', `typ ${r.type}`);
    assert(db.playerPayments[0].licStatus === 'PAID', 'licStatus není PAID');
    assert(db.playerPayments[0].superStatus === 'PENDING', 'omylem zaplacena superlicence');
    assert(db.players[0].licensed === true, 'hráč nemá licensed=true');
  });

  await test('superlicence: VS s prefixem 2 zaplatí superlicenci, ne licenci', async () => {
    const r = await matchTransaction(tx('2000001', 250));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'SUPER_LICENSE', `typ ${r.type}`);
    assert(db.playerPayments[0].superStatus === 'PAID', 'superStatus není PAID');
    assert(db.playerPayments[0].superLic === true, 'superLic není true');
    assert(db.playerPayments[0].licStatus === 'PENDING', 'omylem zaplacena běžná licence');
  });

  await test('registrace týmu: VS s prefixem 3', async () => {
    const r = await matchTransaction(tx('3000001', 8000));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'TEAM_REG', `typ ${r.type}`);
    assert(db.teamPayments[0].status === 'PAID', 'status není PAID');
    assert(db.matches[0].homeFeePaid === false, 'omylem zaplacen domácí zápas');
  });

  await test('domácí zápas: VS s prefixem 4 označí zápas, ne registraci', async () => {
    const r = await matchTransaction(tx('4000001', 2200));
    assert(r.matched, `nespárováno: ${r.reason}`);
    assert(r.type === 'HOME_FEE', `typ ${r.type}`);
    assert(db.matches[0].homeFeePaid === true, 'homeFeePaid není true');
    assert(db.teamPayments[0].status === 'PENDING', 'omylem zaplacena registrace týmu');
  });

  await test('domácí zápas: notifikace jde vedoucímu týmu', async () => {
    await matchTransaction(tx('4000001', 2200));
    assert(db.notifications.some((n) => n.userId === 'u9'), 'vedoucí nedostal oznámení');
  });

  // ---------- částečné platby ----------
  // Dřív se nižší částka zahodila („nedostatečná částka") a nikam se nezapsala.
  // Kdo poslal 200 Kč a doplatil 50, zůstal napořád nezaplacený a peníze
  // ležely na účtu ligy bez majitele.

  await test('nízká částka na licenci se připíše, ale nezaplatí ji', async () => {
    const r = await matchTransaction(tx('1000001', 200));
    assert(r.matched, `částka se nepřipsala: ${r.reason}`);
    assert(r.partial === true, 'chybí příznak částečné platby');
    assert(r.missing === 50, `chybí má být 50, je ${r.missing}`);
    assert(db.playerPayments[0].licPaidAmount === 200, `připsáno ${db.playerPayments[0].licPaidAmount}`);
    assert(db.playerPayments[0].licStatus === 'PENDING', 'licence označena jako zaplacená');
    assert(db.players[0].licensed === false, 'hráč dostal licenci po částečné platbě');
  });

  await test('doplatek dorovná částečnou platbu licence', async () => {
    await matchTransaction(tx('1000001', 200));
    const r = await matchTransaction({ ...tx('1000001', 50), transactionId: 'tx-doplatek' });
    assert(r.matched && !r.partial, `doplatek neprošel: ${r.reason}`);
    assert(db.playerPayments[0].licStatus === 'PAID', 'licence není PAID ani po doplacení');
    assert(db.playerPayments[0].licPaidAmount === 250, `celkem ${db.playerPayments[0].licPaidAmount}`);
    assert(db.players[0].licensed === true, 'hráč nemá licensed=true');
  });

  await test('částečná platba na superlicenci se nepřičte k licenci', async () => {
    await matchTransaction(tx('2000001', 100));
    assert(db.playerPayments[0].superPaidAmount === 100, 'nepřipsáno na superlicenci');
    assert(db.playerPayments[0].licPaidAmount === 0, 'přičteno omylem k licenci');
  });

  await test('doplatek dorovná registraci týmu', async () => {
    await matchTransaction(tx('3000001', 5000));
    assert(db.teamPayments[0].status === 'PENDING', 'registrace zaplacena z poloviny');
    assert(db.teamPayments[0].paidAmount === 5000, `připsáno ${db.teamPayments[0].paidAmount}`);
    const r = await matchTransaction({ ...tx('3000001', 3000), transactionId: 'tx-doplatek' });
    assert(r.matched && !r.partial, `doplatek neprošel: ${r.reason}`);
    assert(db.teamPayments[0].status === 'PAID', 'registrace není PAID');
    assert(db.teamPayments[0].paidAmount === 8000, `celkem ${db.teamPayments[0].paidAmount}`);
  });

  await test('nízká částka na domácí zápas se připíše, ale zápas nezaplatí', async () => {
    const r = await matchTransaction(tx('4000001', 500));
    assert(r.matched && r.partial, `částka se nepřipsala: ${r.reason}`);
    assert(db.matches[0].homeFeePaid === false, 'zápas označen jako zaplacený');
    assert(db.matches[0].homeFeePaidAmount === 500, `připsáno ${db.matches[0].homeFeePaidAmount}`);
    const r2 = await matchTransaction({ ...tx('4000001', 1700), transactionId: 'tx-doplatek' });
    assert(r2.matched && !r2.partial, `doplatek neprošel: ${r2.reason}`);
    assert(db.matches[0].homeFeePaid === true, 'zápas není zaplacený ani po doplacení');
  });

  await test('částečná platba pošle plátci oznámení, kolik chybí', async () => {
    await matchTransaction(tx('1000001', 200));
    const n = db.notifications.find((x) => x.userId === 'u1');
    assert(n, 'hráč nedostal oznámení');
    assert(/chybí 50/.test(n.body), `oznámení neříká, kolik chybí: ${n.body}`);
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
    db.teamPayments[0].paidAmount = 8000;
    db.teamPayments[0].paidAt     = new Date('2025-08-31T00:00:00Z');

    const r = await matchTransaction(tx('3000001', 8000));
    assert(r.matched, `platba za novou sezónu se nespárovala: ${r.reason}`);
    assert(db.teamPayments[0].season === '2026/27', `řádek zůstal v ${db.teamPayments[0].season}`);
    assert(db.teamPayments[0].paidAmount === 8000, `částka se nesečetla správně: ${db.teamPayments[0].paidAmount}`);
  });

  await test('částečná platba za novou sezónu nesčítá loňskou částku', async () => {
    db.teamPayments[0].status     = 'PAID';
    db.teamPayments[0].season     = '2025/26';
    db.teamPayments[0].paidAmount = 8000;

    const r = await matchTransaction(tx('3000001', 3000));
    assert(r.partial === true, 'loňská částka se započítala do letoška');
    assert(db.teamPayments[0].status === 'PENDING', `stav ${db.teamPayments[0].status}`);
    assert(db.teamPayments[0].paidAmount === 3000, `připsáno ${db.teamPayments[0].paidAmount}`);
  });

  await test('registrace zaplacená v aktuální sezóně se podruhé nezaplatí', async () => {
    db.teamPayments[0].status     = 'PAID';
    db.teamPayments[0].season     = '2026/27';
    db.teamPayments[0].paidAmount = 8000;

    const r = await matchTransaction(tx('3000001', 8000));
    assert(!r.matched, 'dvojí platba za stejnou sezónu prošla');
    assert(/již zaplacena/.test(r.reason), `nečekaný důvod: ${r.reason}`);
  });

  await test('odpuštěný poplatek se převodem nepřepíše', async () => {
    db.teamPayments[0].status = 'WAIVED';
    const r = await matchTransaction(tx('3000001', 8000));
    assert(!r.matched, 'platba přepsala odpuštěný poplatek');
  });

  await test('druhá platba se stejným VS se nezpracuje dvakrát', async () => {
    await matchTransaction(tx('1000001', 250));
    const r = await matchTransaction(tx('1000001', 250));
    assert(!r.matched, 'duplicitní platba prošla');
  });

  await test('neznámý VS se nespáruje', async () => {
    const r = await matchTransaction(tx('9999999', 250));
    assert(!r.matched, 'neznámý VS prošel');
    assert(/nenalezen/.test(r.reason), `nečekaný důvod: ${r.reason}`);
  });

  await test('chybějící VS se nespáruje', async () => {
    const r = await matchTransaction(tx(null, 250));
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

  await test('QR: poplatek za zápas vidí jen vedoucí domácího týmu', async () => {
    assert(await smiKPlatbe(vedouci, 'home-fee', 'm1') === true, 'domácí vedoucí nemá přístup');
    assert(await smiKPlatbe(ciziVed, 'home-fee', 'm1') === false, 'cizí vedoucí se dostal k poplatku');
  });

  await test('QR: supervisor vidí všechno', async () => {
    assert(await smiKPlatbe(supervisor, 'player-license', 'p1') === true, 'supervisor nevidí licenci');
    assert(await smiKPlatbe(supervisor, 'team-reg', 't1') === true, 'supervisor nevidí registraci');
    assert(await smiKPlatbe(supervisor, 'home-fee', 'm1') === true, 'supervisor nevidí poplatek');
  });

  await test('QR: nepřihlášený a neznámý typ neprojdou', async () => {
    assert(await smiKPlatbe(null, 'player-license', 'p1') === false, 'anonym prošel');
    assert(await smiKPlatbe(hrac, 'neco-jineho', 'p1') === null, 'neznámý typ neohlášen');
  });

  console.log(`\n${passed} prošlo, ${failed} selhalo`);
  process.exit(failed ? 1 : 0);
})();
