/**
 * Test hráčského profilu vedoucího — běží bez databáze, prisma je mock.
 *
 *   node scripts/test-profil-vedouciho.js
 *
 * Hlídá to, co v provozu selhalo: vedoucí založil tým, zaplatil registraci
 * a u balíčku startů dostal „Hráčský profil nenalezen".
 *
 *   1. Registrace týmu založí vedoucímu hráčský profil včetně licence.
 *   2. Údaje z formuláře mají přednost před odvozením z e-mailu.
 *   3. Bez údajů se jméno odvodí z e-mailu, a když ani to nejde, profil
 *      vznikne pod náhradním jménem — nikdy se nepřeskočí.
 *   4. Existující profil se nepřepisuje. Profil bez týmu se jen připojí.
 *   5. Číslo dresu se nikdy nesrazí s obsazeným.
 */
const Module = require('module');

// ---------- mock databáze ----------

let db, idSeq;

function reset() {
  idSeq = 0;
  db = { players: [], payments: [] };
}

const fakePrisma = {
  player: {
    findUnique: async ({ where }) =>
      db.players.find(p => (where.id ? p.id === where.id : p.userId === where.userId)) ?? null,
    findMany: async ({ where = {} } = {}) =>
      db.players.filter(p => (where.teamId === undefined ? true : p.teamId === where.teamId)),
    create: async ({ data }) => {
      const { payment, ...zbytek } = data;
      const p = { id: `P${++idSeq}`, licensed: false, ...zbytek };
      db.players.push(p);
      if (payment?.create) db.payments.push({ playerId: p.id, ...payment.create });
      return p;
    },
    update: async ({ where, data }) => {
      const p = db.players.find(x => x.id === where.id);
      Object.assign(p, data);
      return p;
    },
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  return orig.apply(this, arguments);
};

const { zalozProfilVedouciho, jmenoZEmailu, volneCislo } = require('../src/services/hracskyProfil');

// ---------- pomocníci ----------

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const zaloz = (opts) => zalozProfilVedouciho(fakePrisma, {
  userId: 'U1', email: 'j.tabasek96@gmail.com', teamId: 'T1',
  teamName: 'Draci', season: '2026/27', ...opts,
});

// ---------- testy ----------

(async () => {
  // --- 1. profil vzniká s týmem ---
  reset();
  const r1 = await zaloz({});
  ok(r1.vytvoren === true, 'registrace týmu založí vedoucímu hráčský profil');
  ok(r1.player.teamId === 'T1', 'profil je rovnou v novém týmu');
  ok(db.payments.length === 1, 'vznikla i licence (PlayerPayment)');
  ok(db.payments[0].season === '2026/27', 'licence nese sezónu, do které se tým hlásí');

  // --- 2. údaje z formuláře ---
  reset();
  const r2 = await zaloz({
    udaje: { firstName: 'Jakub', lastName: 'Tabášek', jersey: 96, position: 'Brankář' },
  });
  ok(r2.player.firstName === 'Jakub' && r2.player.lastName === 'Tabášek',
    'jméno z formuláře má přednost');
  ok(r2.player.jersey === 96, 'dres z formuláře se respektuje');
  ok(r2.player.position === 'Brankář', 'post z formuláře se respektuje');

  // --- 3. odvození z e-mailu a záložní jméno ---
  ok(jmenoZEmailu('j.tabasek96@gmail.com')?.lastName === 'Tabasek',
    'z e-mailu se odvodí příjmení');
  ok(jmenoZEmailu('info@fsl.cz') === null, 'jednoslovný e-mail jméno nedá');

  reset();
  const r3 = await zaloz({ email: 'j.tabasek96@gmail.com' });
  ok(r3.player.firstName === 'J' && r3.player.lastName === 'Tabasek',
    `bez formuláře se jméno vezme z e-mailu, je ${r3.player.firstName} ${r3.player.lastName}`);

  reset();
  const r3b = await zaloz({ email: 'info@fsl.cz' });
  ok(r3b.vytvoren === true, 'i z neurčitého e-mailu profil vznikne');
  ok(r3b.player.lastName === 'Draci', 'záložní jméno nese název týmu, ať je vidět k opravě');

  // --- 4. existující profil se nepřepisuje ---
  reset();
  db.players.push({ id: 'PX', userId: 'U1', teamId: 'TJINY', firstName: 'Petr', lastName: 'Novák', jersey: 7 });
  const r4 = await zaloz({});
  ok(r4.vytvoren === false && r4.duvod === 'UZ_EXISTUJE', 'hráč s týmem se nepřepisuje');
  ok(r4.player.teamId === 'TJINY', 'a nepřetahuje se do nového týmu');
  ok(db.players.length === 1, 'druhý profil nevznikl');

  reset();
  db.players.push({ id: 'PY', userId: 'U1', teamId: null, firstName: 'Petr', lastName: 'Novák', jersey: 7 });
  const r5 = await zaloz({});
  ok(r5.duvod === 'PRIPOJEN', 'hráč bez týmu se připojí k nově založenému');
  ok(r5.player.teamId === 'T1' && r5.player.jersey === 7, 'a nechá si svoje číslo');
  ok(db.players.length === 1, 'ani tady nevznikl druhý profil');

  // --- 5. kolize čísel dresu ---
  reset();
  db.players.push({ id: 'PA', userId: 'U9', teamId: 'T1', jersey: 0 });
  db.players.push({ id: 'PB', userId: 'U8', teamId: 'T1', jersey: 1 });
  ok(await volneCislo(fakePrisma, 'T1') === 2, 'volné číslo přeskočí obsazená');
  const r6 = await zaloz({ udaje: { jersey: 1 } });
  ok(r6.player.jersey !== 1, `obsazený dres se nepřidělí, dostal ${r6.player.jersey}`);
  ok(r6.player.jersey === 2, 'místo něj přijde nejnižší volný');

  reset();
  db.players.push({ id: 'PC', userId: 'U7', teamId: 'TJINY', jersey: 5 });
  const r7 = await zaloz({ udaje: { jersey: 5 } });
  ok(r7.player.jersey === 5, 'dres obsazený v cizím týmu nevadí');

  console.log(fail === 0 ? '\nVšechny testy prošly.' : `\n${fail} testů selhalo.`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
