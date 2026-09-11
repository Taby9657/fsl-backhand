/**
 * Test onboardingu — pravidla, na kterých závisí registrace hráče a týmu.
 *
 * Běží bez databáze: prisma je nahrazená mockem přes Module._load, takže
 * `npm run test:onboarding` jde spustit kdekoliv a trvá vteřinu.
 *
 * Hlídá to, co se v projektu reálně rozbilo:
 *   1. Hráč bez týmu se musí umět připojit pozvánkovým kódem (dřív mu zbýval
 *      jen draft — nový profil brání unikátní userId a PUT teamId nemění).
 *   2. Zopakovaný požadavek po timeoutu nesmí skončit 409 ani druhým týmem.
 *   3. Platba nese sezónu týmu, ne default ze schématu.
 *   4. Do zamítnutého týmu se nikdo nepřidá; do čekajícího ano.
 *   5. Dres 0 projde (0 je platné číslo, ne prázdná hodnota).
 */
const Module = require('module');

// ---------- mock databáze ----------

function novaDb() {
  return {
    players: [],
    teams: [],
    managers: [],
    invites: [
      { id: 'I1', code: 'FSL-TYM-AAAA', teamId: 'T1', expiresAt: null, usedCount: 0 },
      { id: 'I2', code: 'FSL-ZAM-BBBB', teamId: 'T2', expiresAt: null, usedCount: 0 },
      { id: 'I3', code: 'FSL-STA-CCCC', teamId: 'T3', expiresAt: null, usedCount: 0 },
    ],
    teamsById: {
      T1: { id: 'T1', name: 'Nový tým', regStatus: 'PENDING' },
      T2: { id: 'T2', name: 'Zamítnutý', regStatus: 'REJECTED' },
      T3: { id: 'T3', name: 'Starý tým', regStatus: 'APPROVED' },
    },
    zapisyNaSoupisku: [],
  };
}

let db = novaDb();
let idSeq = 0;
const dalsiId = (p) => `${p}${++idSeq}`;

const fakePrisma = {
  $transaction: async (fn) => fn(fakePrisma),
  player: {
    findUnique: async ({ where }) =>
      db.players.find(p => (where.id && p.id === where.id) || (where.userId && p.userId === where.userId)) ?? null,
    findFirst: async ({ where }) =>
      db.players.find(p =>
        p.teamId === where.teamId &&
        p.jersey === where.jersey &&
        (!where.id?.not || p.id !== where.id.not)) ?? null,
    // Hledání volného čísla dresu při zakládání profilu vedoucího
    findMany: async ({ where = {} } = {}) =>
      db.players.filter(p => (where.teamId === undefined ? true : p.teamId === where.teamId)),
    create: async ({ data }) => {
      const p = { id: dalsiId('P'), ...data, payment: data.payment?.create ?? null };
      db.players.push(p);
      return p;
    },
    update: async ({ where, data }) => {
      const p = db.players.find(x => x.id === where.id);
      Object.assign(p, data);
      return p;
    },
  },
  team: {
    create: async ({ data }) => {
      const t = {
        id: dalsiId('T'),
        ...data,
        managers: data.managers?.create ? [{ userId: data.managers.create.userId }] : [],
        payments: data.payments?.create ?? null,
        seasons:  data.seasons?.create ? [data.seasons.create] : [],
        inviteCodes: data.inviteCodes?.create ? [data.inviteCodes.create] : [],
      };
      db.teams.push(t);
      return t;
    },
    findUnique: async ({ where }) => db.teamsById[where.id] ?? db.teams.find(t => t.id === where.id) ?? null,
    update: async ({ where, data }) => {
      const t = db.teams.find(x => x.id === where.id);
      Object.assign(t, data);
      return t;
    },
  },
  manager: {
    findFirst: async ({ where }) => db.managers.find(m => m.userId === where.userId) ?? null,
  },
  inviteCode: {
    findUnique: async ({ where }) => {
      const i = db.invites.find(x => x.code === where.code);
      return i ? { ...i, team: db.teamsById[i.teamId] } : null;
    },
    update: async ({ where, data }) => {
      const i = db.invites.find(x => x.id === where.id);
      if (data.usedCount?.increment) i.usedCount += data.usedCount.increment;
      return i;
    },
  },
  teamSeason: { findFirst: async ({ where }) => ({ season: where.teamId === 'T3' ? '2025/26' : '2026/27' }) },
  user: { findUnique: async () => null },
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
  if (request.endsWith('services/licence')) {
    return {
      sezonaTymu: async (teamId, fallback) => (teamId === 'T3' ? '2025/26' : '2026/27') || fallback,
      pridatDoSoupisky: async (playerId, teamId, season) => {
        db.zapisyNaSoupisku.push({ playerId, teamId, season });
        return { ok: true, radek: { isHome: true } };
      },
      odebratZeSoupisky: async () => ({ ok: true }),
      maZakladniLicenci: () => false,
      maSuperlicenci: () => false,
    };
  }
  if (request.endsWith('services/seasonTransition')) {
    return { currentSeason: async () => '2026/27', SEASON_RE: /^\d{4}\/\d{2}$/ };
  }
  // Přihlášení řeší testovací middleware níž (hlavička x-test-user), tady jen
  // pustíme požadavek dál — jinak by routy držely referenci na skutečný requireAuth.
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

// ---------- server s podvrženým přihlášením ----------

const express = require('express');
const players = require('../src/routes/players');
const teams = require('../src/routes/teams');

const app = express();
app.use(express.json());
// requireAuth v routách čte req.user — nasadíme ho podle hlavičky x-test-user
app.use((req, res, next) => {
  const id = req.headers['x-test-user'];
  if (id) {
    req.user = {
      id,
      // E-mail je záložní zdroj jména pro hráčský profil vedoucího
      email: `${id.toLowerCase()}.vedouci@fsl.cz`,
      manager: db.managers.filter(m => m.userId === id),
      player: db.players.find(p => p.userId === id) ?? null,
    };
  }
  next();
});
app.use('/players', players);
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

  // --- registrace hráče ---
  // Datum narození je od 11. 9. 2026 povinné a hlídá se věk 18+. Fixtury
  // proto musí nést datum dospělého — bez něj registrace skončí na 400.
  const DOSPELY  = '1995-06-15';
  const NEZLETILY = new Date(Date.now() - 17 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const zaklad = { firstName: 'Jan', lastName: 'Novak', position: 'Útočník', birthdate: DOSPELY };

  const dres0 = await volej('/players', { ...zaklad, jersey: 0, inviteCode: 'FSL-TYM-AAAA' }, 'U1');
  ok(dres0.status === 201, 'dres 0 projde jako platné číslo');
  ok(dres0.telo.payment?.season === '2026/27', 'platba nese sezónu týmu, ne default ze schématu');
  ok(db.zapisyNaSoupisku.length === 1, 'hráč se zapsal na soupisku sezóny');
  ok(db.invites[0].usedCount === 1, 'pozvánka se započítala jako použitá');

  const znovu = await volej('/players', { ...zaklad, jersey: 0, inviteCode: 'FSL-TYM-AAAA' }, 'U1');
  ok(znovu.status === 200, 'zopakovaný požadavek vrátí 200, ne 409');

  const zamitnuty = await volej('/players', { ...zaklad, jersey: 7, inviteCode: 'FSL-ZAM-BBBB' }, 'U2');
  ok(zamitnuty.status === 409, 'do zamítnutého týmu se hráč nepřidá');

  const cekajici = await volej('/players', { ...zaklad, jersey: 7, inviteCode: 'FSL-TYM-AAAA' }, 'U3');
  ok(cekajici.status === 201, 'do týmu čekajícího na schválení se hráč přidat může');

  const obsazeny = await volej('/players', { ...zaklad, jersey: 7, inviteCode: 'FSL-TYM-AAAA' }, 'U4');
  ok(obsazeny.status === 409 && /dresu 7/.test(obsazeny.telo.error), 'obsazený dres vrátí srozumitelnou chybu');

  // --- hráč bez týmu se připojí kódem ---
  const hrac = db.players.find(p => p.userId === 'U3');
  hrac.teamId = null; // simulace „opustil tým"

  const vTymu = await volej('/players/join', { inviteCode: 'FSL-TYM-AAAA', jersey: 7 }, 'U1');
  ok(vTymu.status === 409 && vTymu.telo.code === 'ALREADY_IN_TEAM', 'hráč v týmu dostane jasnou hlášku');

  const pripojeni = await volej('/players/join', { inviteCode: 'FSL-STA-CCCC', jersey: 9 }, 'U3');
  ok(pripojeni.status === 200, 'hráč bez týmu se připojí pozvánkovým kódem');
  ok(pripojeni.telo.player?.teamId === 'T3', 'kmenový tým se hráči skutečně přepsal');
  ok(db.zapisyNaSoupisku.some(z => z.teamId === 'T3'), 'a je i na soupisce nového týmu');

  const doZamitnuteho = await volej('/players/join', { inviteCode: 'FSL-ZAM-BBBB' }, 'U9');
  ok(doZamitnuteho.status === 404, 'bez profilu nejde použít join (404, ne pád)');

  // --- hráč bez týmu (draft pool) ---
  // Do draftu se jinak nedalo dostat vůbec: `POST /draft/profile` chce
  // hráčský profil bez týmu, ale profil šel založit jen pozvánkovým kódem,
  // který hráče rovnou do týmu zapsal.
  const bezKodu = await volej('/players', { firstName: 'Pavel', lastName: 'Volny', jersey: 8, birthdate: DOSPELY }, 'U7');
  ok(bezKodu.status === 400 && bezKodu.telo.code === 'NO_INVITE_CODE',
    'bez kódu a bez příznaku profil nevznikne');
  ok(/nabídnout se v draftu/.test(bezKodu.telo.error ?? ''),
    'a chybová hláška rovnou nabídne draft');

  const volny = await volej('/players', { firstName: 'Pavel', lastName: 'Volny', bezTymu: true, birthdate: DOSPELY }, 'U7');
  ok(volny.status === 201, 'hráč bez týmu si profil založí');
  ok(volny.telo.teamId === null, 'a zůstane bez týmu');
  ok(volny.telo.jersey === 0, 'dres se nevynucuje — vybere si ho, až ho někdo draftuje');
  ok(volny.telo.payment?.season === '2026/27', 'licence vznikne na aktuální sezónu');
  ok(db.zapisyNaSoupisku.every(z => z.playerId !== volny.telo.id),
    'na žádnou soupisku se nezapíše');

  const znovuVolny = await volej('/players', { firstName: 'Pavel', lastName: 'Volny', bezTymu: true, birthdate: DOSPELY }, 'U7');
  ok(znovuVolny.status === 200, 'zopakovaný požadavek vrátí 200, ne druhý profil');

  const vTymuDoDraftu = await volej('/players', { firstName: 'Jan', lastName: 'Novak', bezTymu: true, birthdate: DOSPELY }, 'U1');
  ok(vTymuDoDraftu.status === 409 && vTymuDoDraftu.telo.code === 'ALREADY_IN_TEAM',
    'kdo je v týmu, do draftu takhle nespadne');

  // --- registrace týmu ---
  // Sezóna z těla se schválně ignoruje — proto se posílá jiná než aktuální
  // ('2026/27' z mocku) a čeká se, že tým stejně skončí v té aktuální.
  const tym = await volej('/teams', { name: 'Draci', abbr: 'DRA', venue: 'Hala Jih', season: '2027/28', manager: { birthdate: DOSPELY } }, 'U5');
  ok(tym.status === 201, 'tým se založí');
  ok(tym.telo.team?.venue === 'Hala Jih', 'domácí hala se uloží (dřív se zahazovala)');
  ok(tym.telo.team?.payments?.season === '2026/27', 'platba týmu nese aktuální sezónu, ne tu z požadavku');
  ok(tym.telo.team?.seasons?.[0]?.season === '2026/27', 'přihláška vznikla do aktuální sezóny, ne do příští');
  ok(!!tym.telo.inviteCode, 'pozvánkový kód se vrátil rovnou v odpovědi');

  // Vedoucí je zároveň hráč — bez profilu by nezaplatil balíček ani licenci
  ok(!!tym.telo.player, 'registrace týmu založí vedoucímu i hráčský profil');
  ok(tym.telo.player?.teamId === tym.telo.team.id, 'profil vedoucího je v jeho týmu');
  ok(tym.telo.player?.payment?.season === '2026/27', 'profilu vznikla i licence na aktuální sezónu');
  ok(db.zapisyNaSoupisku.some(z => z.playerId === tym.telo.player.id && z.teamId === tym.telo.team.id),
    'vedoucí je rovnou na soupisce sezóny');

  // Vedoucí, který hráčský profil už má, se nepřepisuje ani nepřetahuje
  const tymSHracem = await volej('/teams', { name: 'Sokoli', abbr: 'SOK', manager: { birthdate: DOSPELY } }, 'U1');
  ok(tymSHracem.status === 201, 'tým založí i hráč, který profil už má');
  ok(tymSHracem.telo.player?.teamId === 'T1', 'a jeho stávající profil zůstane v původním týmu');

  // --- věková hranice 18 let ---
  // Formulář na webu i v appce se dá obejít, takže tohle musí držet server.
  const bezData = await volej('/players', { firstName: 'Adam', lastName: 'Maly', jersey: 11, inviteCode: 'FSL-TYM-AAAA' }, 'U10');
  ok(bezData.status === 400 && bezData.telo.code === 'BIRTHDATE_REQUIRED',
    'registrace bez data narození neprojde');

  const maly = await volej('/players', { ...zaklad, birthdate: NEZLETILY, jersey: 11, inviteCode: 'FSL-TYM-AAAA' }, 'U10');
  ok(maly.status === 400 && maly.telo.code === 'UNDERAGE', 'nezletilý hráč se nezaregistruje');
  ok(/18 let/.test(maly.telo.error ?? ''), 'a hláška řekne proč');

  const nesmysl = await volej('/players', { ...zaklad, birthdate: '2007-02-31', jersey: 11, inviteCode: 'FSL-TYM-AAAA' }, 'U10');
  ok(nesmysl.status === 400 && nesmysl.telo.code === 'BIRTHDATE_INVALID',
    'neexistující datum (31. února) neprojde');

  const malyVDraftu = await volej('/players', { firstName: 'Adam', lastName: 'Maly', bezTymu: true, birthdate: NEZLETILY }, 'U10');
  ok(malyVDraftu.status === 400 && malyVDraftu.telo.code === 'UNDERAGE',
    'ani do draft poolu se nezletilý nedostane');

  const malyVedouci = await volej('/teams', { name: 'Orli', abbr: 'ORL', manager: { birthdate: NEZLETILY } }, 'U11');
  ok(malyVedouci.status === 400 && malyVedouci.telo.code === 'UNDERAGE',
    'nezletilý si nezaloží ani tým');
  ok(!db.teams.some(t => t.abbr === 'ORL'), 'a tým po zamítnuté registraci nezůstane viset');

  const vedouciBezData = await volej('/teams', { name: 'Orli', abbr: 'OR2' }, 'U11');
  ok(vedouciBezData.status === 400 && vedouciBezData.telo.code === 'BIRTHDATE_REQUIRED',
    'vedoucí bez data narození tým nezaloží');

  db.managers.push({ userId: 'U5', teamId: tym.telo.team.id, team: tym.telo.team });
  const druhy = await volej('/teams', { name: 'Draci znovu', abbr: 'DR2', season: '2026/27', manager: { birthdate: DOSPELY } }, 'U5');
  ok(druhy.status === 409 && druhy.telo.code === 'ALREADY_MANAGER', 'druhý tým z jednoho účtu už nevznikne');

  server.close();
  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
});
