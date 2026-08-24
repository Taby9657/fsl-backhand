/**
 * Test párování bankovních plateb – běží proti in-memory náhradě Prismy,
 * takže nepotřebuje databázi:
 *
 *   node scripts/test-payment-matching.js
 *
 * Ověřuje hlavně to, kvůli čemu vznikly sloupce superVariableSymbol a
 * Match.homeFeeVS: že se převod na superlicenci nezaúčtuje jako běžná licence
 * a že poplatek za domácí zápas nesníží dluh za registraci týmu.
 */

const path = require('path');

/* ---------- in-memory data ---------- */

function freshDb() {
  return {
    playerPayments: [
      {
        id: 'pp1',
        playerId: 'p1',
        licFee: 300,
        licStatus: 'PENDING',
        licPaidAt: null,
        licMethod: null,
        superFee: 300,
        superStatus: 'PENDING',
        superPaidAt: null,
        superLic: false,
        variableSymbol: '1000001',
        superVariableSymbol: '2000001',
        player: { id: 'p1', firstName: 'Tomáš', lastName: 'Novák', userId: 'u1' },
      },
    ],
    teamPayments: [
      {
        id: 'tp1',
        teamId: 't1',
        amount: 10000,
        status: 'PENDING',
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
        homeFeeVS: '4000001',
        homeTeam: { id: 't1', name: 'Benavidez Eagles' },
      },
    ],
    players: [{ id: 'p1', licensed: false }],
    managers: [{ userId: 'u9', teamId: 't1' }],
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
  teamPayment: {
    findUnique: async ({ where }) =>
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

const { matchTransaction } = require('../src/services/bankSync');

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
    const r = await matchTransaction(tx('3000001', 10000));
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

  await test('nízká částka na licenci se nespáruje', async () => {
    const r = await matchTransaction(tx('1000001', 100));
    assert(!r.matched, 'platba prošla i při nízké částce');
    assert(db.playerPayments[0].licStatus === 'PENDING', 'stav se změnil');
  });

  await test('nízká částka na domácí zápas se nespáruje', async () => {
    const r = await matchTransaction(tx('4000001', 500));
    assert(!r.matched, 'platba prošla i při nízké částce');
    assert(db.matches[0].homeFeePaid === false, 'zápas označen jako zaplacený');
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

  console.log(`\n${passed} prošlo, ${failed} selhalo`);
  process.exit(failed ? 1 : 0);
})();
