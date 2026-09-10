/**
 * Test označení brankáře na soupisce (`TeamRoster.slot`).
 *
 * Běží bez databáze: prisma je nahrazená mockem přes Module._load, takže
 * `npm run test:roster` jde spustit kdekoliv a trvá vteřinu.
 *
 * Hlídá to, co se dá snadno rozbít:
 *   1. Rozpoznání brankáře musí zvládnout oba slovníky, které v datech jsou —
 *      kódy (GK) i česká slova (Brankář), včetně diakritiky a velkých písmen.
 *   2. Soupiska musí vracet `slot` a řadit brankáře nahoru.
 *   3. Výchozí hodnota se odvodí z postu, ale poslaná hodnota má přednost.
 *   4. Změnu smí udělat vedoucí a supervisor, nikdo jiný; neznámá hodnota
 *      skončí čitelnou chybou, ne zápisem nesmyslu do enumu.
 *   5. `slot` musí projít i do veřejné podoby hráče — jinak by ho web
 *      u detailu týmu neviděl a musel by hádat z `position`.
 */
const Module = require('module');

// ---------- mock databáze ----------

function novaDb() {
  return {
    players: [
      { id: 'P1', teamId: 'T1', firstName: 'Adam', lastName: 'Brankar', jersey: 1,  position: 'Brankář', payment: { licStatus: 'PAID', superStatus: 'PENDING' } },
      { id: 'P2', teamId: 'T1', firstName: 'Bob',  lastName: 'Utocnik', jersey: 10, position: 'Útočník', payment: { licStatus: 'PAID', superStatus: 'PENDING' } },
      { id: 'P3', teamId: 'T1', firstName: 'Cyril', lastName: 'Kodovy', jersey: 3,  position: 'GK',       payment: { licStatus: 'PAID', superStatus: 'PENDING' } },
      { id: 'P4', teamId: null, firstName: 'David', lastName: 'Host',   jersey: 22, position: 'Brankář',  payment: { licStatus: 'PAID', superStatus: 'PAID' } },
    ],
    rosters: [],
  };
}

let db = novaDb();
let idSeq = 0;
const dalsiId = (p) => `${p}${++idSeq}`;

const fakePrisma = {
  $transaction: async (fn) => fn(fakePrisma),
  player: {
    findUnique: async ({ where }) => db.players.find(p => p.id === where.id) ?? null,
    findMany:   async ({ where }) => {
      const vyloucene = where?.id?.notIn ?? [];
      return db.players.filter(p => p.teamId === where.teamId && !vyloucene.includes(p.id));
    },
  },
  team: {
    findUnique: async ({ where }) => ({
      id: where.id, name: 'Testovací tým', abbr: 'TST', color: '#C9A140',
      division: null, conference: null, venue: null, logoUrl: null, colorSecondary: null,
      regStatus: 'APPROVED', regNote: 'interní poznámka', regAppeal: null,
      players: db.players.filter(p => p.teamId === where.id).map(p => ({ ...p })),
      managers: [{ id: 'M1', teamId: where.id, user: { id: 'U1', email: 'a@b.cz' } }],
    }),
  },
  teamRoster: {
    findMany: async ({ where }) => db.rosters
      .filter(r => r.teamId === where.teamId && r.season === where.season)
      .map(r => ({ ...r, player: { ...db.players.find(p => p.id === r.playerId) } })),
    findUnique: async ({ where }) => {
      const k = where.playerId_teamId_season;
      return db.rosters.find(r => r.playerId === k.playerId && r.teamId === k.teamId && r.season === k.season) ?? null;
    },
    count:  async ({ where }) => db.rosters.filter(r => r.playerId === where.playerId && r.season === where.season).length,
    create: async ({ data }) => { const r = { id: dalsiId('R'), createdAt: new Date(), ...data }; db.rosters.push(r); return r; },
    update: async ({ where, data }) => {
      const r = db.rosters.find(x => x.id === where.id);
      Object.assign(r, data);
      return r;
    },
    deleteMany: async () => ({ count: 0 }),
  },
  lineupPlayer: { findMany: async () => [] },
  // Soupiska vrací u každého hráče důvody, proč ho nejde postavit do sestavy.
  // Bez těchhle tabulek by ten dotaz spadl a test by dostal HTML chybovku.
  matchPack:     { findMany: async () => db.balicky ?? [] },
  matchEntry:    { findMany: async () => [] },
  playerPayment: { findMany: async () => [] },
  teamSeason:   { findFirst: async () => ({ season: '2026/27' }) },
  inviteCode:   { findUnique: async () => null },
  notification: { create: async () => ({}) },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  if (request.endsWith('utils/fileUpload')) {
    const mw = { single: () => (r, s, n) => n() };
    return { uploadLogo: mw, uploadPhoto: mw };
  }
  if (request.endsWith('services/push')) return { sendPush: async () => {} };
  if (request.endsWith('./notifications') || request.endsWith('routes/notifications')) {
    return { createNotification: async () => {}, createNotifications: async () => {} };
  }
  if (request.endsWith('services/seasonTransition')) {
    return { currentSeason: async () => '2026/27', SEASON_RE: /^\d{4}\/\d{2}$/ };
  }
  if (request.endsWith('middleware/auth')) {
    const pustDal = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'test: chybí uživatel' }));
    return {
      requireAuth: pustDal,
      optionalAuth: (req, res, next) => next(),
      requireManager: pustDal,
      requireSupervisor: pustDal,
      isSupervisorUser: (u) => !!u?.isSupervisor,
      issueToken: () => 'test-token',
    };
  }
  return orig.apply(this, arguments);
};

// ---------- server ----------

const express = require('express');
const teams   = require('../src/routes/teams');
const { jeBrankar, slotZPostu } = require('../src/utils/posty');

const UZIVATELE = {
  U1: { id: 'U1', manager: [{ teamId: 'T1' }] },          // vedoucí T1
  U2: { id: 'U2', manager: [] },                          // nikdo
  U3: { id: 'U3', manager: [], isSupervisor: true },      // supervisor
};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const id = req.headers['x-test-user'];
  if (id && UZIVATELE[id]) req.user = UZIVATELE[id];
  next();
});
app.use('/teams', teams);

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const volej = async (cesta, telo, user, metoda = 'POST') => {
    const r = await fetch(base + cesta, {
      method: metoda,
      headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      body: telo ? JSON.stringify(telo) : undefined,
    });
    return { status: r.status, telo: await r.json() };
  };

  // --- 1. rozpoznání postu ---
  for (const post of ['GK', 'gk', 'Brankář', 'brankar', 'BRANKÁŘ', 'G', 'goalkeeper']) {
    ok(jeBrankar(post), `„${post}" se pozná jako brankář`);
  }
  for (const post of ['Útočník', 'F', 'D', 'Obránce', 'Univerzál', '', null, undefined]) {
    ok(!jeBrankar(post), `„${post}" se za brankáře nepovažuje`);
  }
  ok(slotZPostu('GK') === 'GOALKEEPER' && slotZPostu('Útočník') === 'FIELD', 'slotZPostu vrací hodnoty enumu');

  // --- 2. doplnění kmenových hráčů odvodí slot z postu ---
  const doplneni = await volej('/teams/T1/roster/home', {}, 'U1');
  ok(doplneni.status === 200 && doplneni.telo.added === 3, 'kmenoví hráči se doplnili na soupisku');
  ok(db.rosters.find(r => r.playerId === 'P1').slot === 'GOALKEEPER', 'hráč s postem „Brankář" dostal GOALKEEPER');
  ok(db.rosters.find(r => r.playerId === 'P3').slot === 'GOALKEEPER', 'hráč s kódem „GK" dostal GOALKEEPER taky');
  ok(db.rosters.find(r => r.playerId === 'P2').slot === 'FIELD', 'útočník dostal FIELD');

  // --- 3. soupiska vrací slot a řadí brankáře nahoru ---
  const soupiska = await volej('/teams/T1/roster', null, 'U1', 'GET');
  const poradi = soupiska.telo.players.map(p => `${p.slot}:${p.jersey}`);
  ok(soupiska.status === 200, 'soupiska se načte');
  ok(poradi[0].startsWith('GOALKEEPER') && poradi[1].startsWith('GOALKEEPER'),
    'brankáři drží první dvě místa');
  ok(poradi[0] === 'GOALKEEPER:1' && poradi[1] === 'GOALKEEPER:3',
    'uvnitř skupiny se pořád řadí podle čísla dresu');
  ok(soupiska.telo.goalkeepers === 2, 'odpověď rovnou říká, kolik má tým brankářů');

  // --- 4. strop brankářů a přednost poslaného slotu ---
  // P4 má post „Brankář", ale tým už dva brankáře má.
  const treti = await volej('/teams/T1/roster', { playerId: 'P4' }, 'U1');
  ok(treti.status === 422 && treti.telo.code === 'GK_LIMIT',
    'třetí brankář se na soupisku nevejde');

  const host = await volej('/teams/T1/roster', { playerId: 'P4', slot: 'FIELD' }, 'U1');
  ok(host.status === 201 && host.telo.slot === 'FIELD',
    'poslaný slot má přednost před postem hráče (brankář zapsaný do pole)');

  // --- 5. změna označení ---
  const spatny = await volej('/teams/T1/roster/P2/slot', { slot: 'KEEPER' }, 'U1', 'PUT');
  ok(spatny.status === 400 && spatny.telo.code === 'BAD_SLOT', 'neznámá hodnota skončí na 400, ne v databázi');

  const cizi = await volej('/teams/T1/roster/P2/slot', { slot: 'GOALKEEPER' }, 'U2', 'PUT');
  ok(cizi.status === 403, 'kdo tým nevede, označení nezmění');

  const chybi = await volej('/teams/T1/roster/P9/slot', { slot: 'GOALKEEPER' }, 'U1', 'PUT');
  ok(chybi.status === 404, 'hráč mimo soupisku vrátí 404');

  const zmena = await volej('/teams/T1/roster/P2/slot', { slot: 'GOALKEEPER' }, 'U1', 'PUT');
  ok(zmena.status === 200 && zmena.telo.slot === 'GOALKEEPER', 'vedoucí označení změní');
  ok(db.rosters.find(r => r.playerId === 'P2').slot === 'GOALKEEPER', 'a změna se opravdu zapsala');

  const supervizor = await volej('/teams/T1/roster/P2/slot', { slot: 'FIELD' }, 'U3', 'PUT');
  ok(supervizor.status === 200 && supervizor.telo.slot === 'FIELD', 'supervisor to umí přepnout zpátky');

  // --- 6. detail týmu: slot i pro nepřihlášeného ---
  const verejny = await volej('/teams/T1', null, null, 'GET');
  ok(verejny.status === 200, 'detail týmu je veřejný');
  ok(verejny.telo.players[0].slot === 'GOALKEEPER', 'brankář je v detailu týmu první');
  ok(verejny.telo.players.every(p => p.slot === 'GOALKEEPER' || p.slot === 'FIELD'),
    'slot přežije ořezání na veřejná pole');
  ok(verejny.telo.regNote === undefined, 'a ořezání pořád funguje — poznámka supervisora ven nejde');

  server.close();
  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
});
