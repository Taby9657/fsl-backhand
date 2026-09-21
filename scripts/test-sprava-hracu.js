/**
 * Test správy hráčů — supervisorské zařazení do týmu a odchod z něj.
 *
 * Běží bez databáze: prisma je nahrazená mockem přes `Module._load`, stejně
 * jako v `test-onboarding.js`.
 *
 * Hlídá to, co se rozbije nejsnáz:
 *   1. Zařazení musí zapsat `Player.teamId` **i** řádek do `TeamRoster`.
 *      Kdo zapíše jen jedno, vyrobí hráče, který je vidět na soupisce
 *      a v sestavě chybí — přesně to dělal draft do 15. 9. 2026.
 *   2. Zařazený hráč musí zmizet z draft poolu.
 *   3. Dres 0 z draftu koliduje s brankáři, takže kolize musí jít poznat
 *      a přebít jiným číslem.
 *   4. Odchod z týmu nesmí smazat soupisku tomu, kdo už za tým nastoupil —
 *      na odehraných zápasech stojí statistiky i nárok na playoff.
 */
const Module = require('module');

// ---------- mock databáze ----------

function novaDb() {
  return {
    players: [
      { id: 'P1', userId: 'U1', firstName: 'Pavel', lastName: 'Volny',   jersey: 0, position: 'Útočník', teamId: null, birthdate: new Date('1998-04-12'), phone: '777123456' },
      { id: 'P2', userId: 'U2', firstName: 'Marek', lastName: 'Brankar', jersey: 0, position: 'Brankář', teamId: null, birthdate: new Date('2001-01-05'), phone: null },
      { id: 'P3', userId: 'U3', firstName: 'Jan',   lastName: 'Kmenovy', jersey: 9, position: 'Obránce', teamId: 'T1' },
      { id: 'P4', userId: 'U4', firstName: 'Petr',  lastName: 'Vedouci',  jersey: 4, position: 'Obránce', teamId: null },
    ],
    teamsById: {
      T1: { id: 'T1', name: 'Draci',     abbr: 'DRA', isOpen: false, regStatus: 'APPROVED' },
      T2: { id: 'T2', name: 'Zamítnutý', abbr: 'ZAM', isOpen: false, regStatus: 'REJECTED' },
      T3: { id: 'T3', name: 'Orli',      abbr: 'ORL', isOpen: false, regStatus: 'APPROVED' },
      // Otevřený tým — zařazení do něj je zároveň vstup do soutěže.
      T4: { id: 'T4', name: 'FSL Open A', abbr: 'OPA', isOpen: true, regStatus: 'APPROVED' },
    },
    soupisky: [{ playerId: 'P3', teamId: 'T1', season: '2026/27', slot: 'FIELD', isHome: true }],
    draftProfily: [
      { id: 'D1', playerId: 'P1', isActive: true, position: 'Útočník' },
      { id: 'D2', playerId: 'P2', isActive: true, position: 'Brankář' },
    ],
    draftNabidky: [{ id: 'N1', profileId: 'D1', status: 'PENDING' }],
    managers: [{ userId: 'U9', teamId: 'T1' }, { userId: 'U4', teamId: 'T3' }],
    users: [
      { id: 'U1', email: 'volny@test.cz' },
      { id: 'U2', email: 'brankar@test.cz' },
      { id: 'U3', email: 'kmenovy@test.cz' },
      { id: 'U4', email: 'vedouci@test.cz' },
    ],
    // Předpisy licencí. P2 má zaplaceno — takového hráče smazat nejde.
    platby: [
      { playerId: 'P1', licFee: 300, licStatus: 'PENDING', licPaidAmount: 0,   superPaidAmount: 0 },
      { playerId: 'P2', licFee: 300, licStatus: 'PAID',    licPaidAmount: 300, superPaidAmount: 0 },
      { playerId: 'P3', licFee: 300, licStatus: 'PENDING', licPaidAmount: 0,   superPaidAmount: 0 },
      { playerId: 'P4', licFee: 300, licStatus: 'PENDING', licPaidAmount: 0,   superPaidAmount: 0 },
    ],
    // Historie v zápasech — drží hráče před smazáním.
    starty_v_zapasech: [{ playerId: 'P3' }],
    // Kdo za který tým odehrál — řídí, jestli se smí soupiska zrušit.
    starty: new Map([['P3|T1', 2]]),
    oznameni: [],
    // Košík hráče, vstupy do otevřených týmů a odeslaná pošta.
    kosiky: [],
    polozkyKosiku: [],
    vstupy: [],
    maily: [],
  };
}

let db = novaDb();
let idSeq = 0;
const dalsiId = (p) => `${p}${++idSeq}`;

const fakePrisma = {
  $transaction: async (fn) => fn(fakePrisma),
  player: {
    // Vztahy se dotahují přes `include` i přes `select` — `vstupniBalik`
    // si hráče bere selectem a bez tohohle by mu předpis licence chyběl.
    findUnique: async ({ where, include, select }) => {
      const p = db.players.find(x => x.id === where.id) ?? null;
      const vztahy = include ?? select;
      if (!p || !vztahy) return p;
      const s = { ...p };
      if (vztahy.payment) s.payment = db.platby.find(x => x.playerId === p.id) ?? null;
      if (vztahy.user)    s.user    = db.users.find(u => u.id === p.userId) ?? null;
      return s;
    },
    delete: async ({ where }) => {
      const p = db.players.find(x => x.id === where.id);
      db.players = db.players.filter(x => x.id !== where.id);
      // Co v databázi visí na hráči kaskádou.
      db.soupisky      = db.soupisky.filter(r => r.playerId !== where.id);
      db.draftProfily  = db.draftProfily.filter(d => d.playerId !== where.id);
      db.platby        = db.platby.filter(x => x.playerId !== where.id);
      return p;
    },
    findFirst: async ({ where }) => db.players.find(p =>
      p.teamId === where.teamId &&
      p.jersey === where.jersey &&
      (!where.id?.not || p.id !== where.id.not)) ?? null,
    findMany: async ({ where = {}, select } = {}) => db.players.filter(p => {
      if ('teamId' in where && p.teamId !== where.teamId) return false;
      if (where.draftProfile?.isActive !== undefined) {
        const d = db.draftProfily.find(x => x.playerId === p.id);
        if (!d || d.isActive !== where.draftProfile.isActive) return false;
      }
      if (where.OR) {
        const hledej = where.OR[0].firstName.contains.toLowerCase();
        const cele = `${p.firstName} ${p.lastName}`.toLowerCase();
        if (!cele.includes(hledej)) return false;
      }
      return true;
    }).map(p => (select?.user
      // Select se vztahem: e-mail sedí na User, ne na Player.
      ? { ...p, user: db.users.find(u => u.id === p.userId) ?? null }
      : p)),
    update: async ({ where, data }) => {
      const p = db.players.find(x => x.id === where.id);
      Object.assign(p, data);
      return p;
    },
  },
  team: { findUnique: async ({ where }) => db.teamsById[where.id] ?? null },
  teamRoster: {
    findMany: async ({ where }) => db.soupisky.filter(r =>
      r.season === where.season &&
      (!where.playerId?.in || where.playerId.in.includes(r.playerId))),
  },
  manager: {
    findMany: async ({ where }) => db.managers.filter(m => !where?.teamId || m.teamId === where.teamId),
    count: async ({ where }) => db.managers.filter(m => m.userId === where.userId).length,
  },
  referee: { count: async () => 0 },
  user: {
    findUnique: async ({ where }) => db.users.find(x => x.id === where.id) ?? null,
    delete: async ({ where }) => {
      const u = db.users.find(x => x.id === where.id);
      db.users = db.users.filter(x => x.id !== where.id);
      return u;
    },
  },
  playerPayment: {
    findUnique: async ({ where }) => db.platby.find(x => x.playerId === where.playerId) ?? null,
  },
  openEntry: {
    findUnique: async ({ where }) => db.vstupy.find(v =>
      v.playerId === where.playerId_season.playerId
      && v.season === where.playerId_season.season) ?? null,
  },
  cart: {
    findFirst: async ({ where }) => {
      const c = db.kosiky.find(x => x.userId === where.userId && x.status === where.status);
      return c ? { ...c, items: db.polozkyKosiku.filter(i => i.cartId === c.id) } : null;
    },
    create: async ({ data }) => {
      const c = { id: dalsiId('C'), status: 'PENDING', ...data };
      db.kosiky.push(c);
      return c;
    },
  },
  cartItem: {
    create: async ({ data }) => {
      const i = { id: dalsiId('CI'), ...data };
      db.polozkyKosiku.push(i);
      return i;
    },
  },
  matchEvent:    { count: async () => 0 },
  lineupPlayer:  { count: async () => 0 },
  postmatchData: { count: async () => 0 },
  matchEntry: {
    count: async ({ where }) => db.starty_v_zapasech.filter(e => e.playerId === where.playerId).length,
  },
  matchPack: { count: async () => 0 },
  draftProfile: {
    findUnique: async ({ where }) => db.draftProfily.find(d => d.playerId === where.playerId) ?? null,
    upsert: async ({ where, create, update }) => {
      const stavajici = db.draftProfily.find(d => d.playerId === where.playerId);
      if (stavajici) { Object.assign(stavajici, update); return stavajici; }
      const novy = { id: dalsiId('D'), ...create, videos: [] };
      db.draftProfily.push(novy);
      return novy;
    },
    update: async ({ where, data }) => {
      const d = db.draftProfily.find(x => x.id === where.id);
      Object.assign(d, data);
      return d;
    },
  },
  draftOffer: {
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const o of db.draftNabidky) {
        if (o.profileId === where.profileId && o.status === where.status) { Object.assign(o, data); count += 1; }
      }
      return { count };
    },
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  if (request.endsWith('services/push')) return { sendPush: async () => {} };
  if (request.endsWith('./notifications') || request.endsWith('routes/notifications')) {
    return {
      createNotification: async (userId, title) => { db.oznameni.push({ userId, title }); },
      createNotifications: async (items) => { items.forEach(i => db.oznameni.push(i)); },
    };
  }
  if (request.endsWith('services/licence')) {
    return {
      SLOTY: ['GOALKEEPER', 'FIELD'],
      jeSlot: (s) => ['GOALKEEPER', 'FIELD'].includes(s),
      sezonaTymu: async (teamId, fallback) => fallback ?? '2026/27',
      startyPodleTymu: async (playerId) => {
        const m = new Map();
        for (const [klic, pocet] of db.starty) {
          const [p, t] = klic.split('|');
          if (p === playerId) m.set(t, pocet);
        }
        return m;
      },
      pridatDoSoupisky: async (playerId, teamId, season, { isHome = false, slot = null } = {}) => {
        if (db.soupisky.some(r => r.playerId === playerId && r.teamId === teamId && r.season === season)) {
          return { ok: false, code: 'ALREADY_ON_ROSTER', error: 'Hráč už na soupisce je' };
        }
        const radek = { playerId, teamId, season, isHome, slot: slot ?? 'FIELD' };
        db.soupisky.push(radek);
        return { ok: true, radek };
      },
      odebratZeSoupisky: async (playerId, teamId, season) => {
        db.soupisky = db.soupisky.filter(r =>
          !(r.playerId === playerId && r.teamId === teamId && r.season === season));
        return { ok: true };
      },
      maZakladniLicenci: () => false,
      maSuperlicenci: () => false,
    };
  }
  if (request.endsWith('services/seasonTransition')) {
    return { currentSeason: async () => '2026/27', SEASON_RE: /^\d{4}\/\d{2}$/ };
  }
  if (request.endsWith('services/standings')) return {};
  if (request.endsWith('services/bankSync')) return { stavParovani: async () => ({ zdrave: true }) };
  if (request.endsWith('services/mailer')) {
    return {
      sendMail: async () => {},
      supervisorAddress: () => 'info@fsl.cz',
      odpovedNaZpravuMail: () => ({}),
      nabidkaTymuMail: () => ({ subject: '', text: '' }),
      // Text se tady nerenderuje — testuje se, co do zprávy pošle routa.
      // Jak vypadá, hlídá `test:maily`.
      zarazeniDoTymuMail: (p) => ({ subject: `Jsi v týmu ${p.tym}`, text: '', parametry: p }),
      posliBezpecne: async (to, zprava) => { db.maily.push({ to, ...zprava }); return { ok: true }; },
    };
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
const supervisor = require('../src/routes/supervisor');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'U9', isSupervisor: true }; next(); });
app.use('/supervisor', supervisor);

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const volej = async (cesta, telo, metoda = 'PUT') => {
    const r = await fetch(base + cesta, {
      method: metoda,
      headers: { 'Content-Type': 'application/json' },
      body: telo ? JSON.stringify(telo) : undefined,
    });
    return { status: r.status, telo: await r.json() };
  };

  // --- seznam ---
  const vsichni = await volej('/supervisor/players', null, 'GET');
  ok(vsichni.status === 200 && vsichni.telo.players.length === 4, 'seznam vrátí všechny hráče');
  ok(vsichni.telo.players.find(p => p.id === 'P3')?.rosters?.length === 1,
    'a u každého i jeho soupisky v sezóně');

  const pavel = vsichni.telo.players.find(p => p.id === 'P1');
  ok(pavel?.user?.email === 'volny@test.cz',
    'supervisor vidí e-mail hráče — bez kontaktu s ním nemá jak mluvit');
  ok(!!pavel?.birthdate && pavel.phone === '777123456',
    'a taky datum narození a telefon');

  const bezTymu = await volej('/supervisor/players?bezTymu=1', null, 'GET');
  ok(bezTymu.telo.players.length === 3 && bezTymu.telo.players.every(p => p.teamId === null),
    'filtr „bez týmu" ukáže jen ty, se kterými je co dělat');

  const hledani = await volej('/supervisor/players?q=brank', null, 'GET');
  ok(hledani.telo.players.length === 1 && hledani.telo.players[0].id === 'P2',
    'hledání podle jména funguje');

  // --- zařazení do týmu ---
  const zarazen = await volej('/supervisor/players/P1/team', { teamId: 'T1', jersey: 17 });
  ok(zarazen.status === 200, 'hráč bez týmu se dá zařadit');
  ok(db.players.find(p => p.id === 'P1').teamId === 'T1', 'kmenový tým se nastavil');
  ok(db.soupisky.some(r => r.playerId === 'P1' && r.teamId === 'T1'),
    'a hlavně: je i na soupisce, takže ho jde postavit do sestavy');
  ok(db.players.find(p => p.id === 'P1').jersey === 17, 'dres se přepsal na zadané číslo');
  ok(db.draftProfily.find(d => d.playerId === 'P1').isActive === false,
    'zařazený hráč zmizí z draft poolu');
  ok(db.draftNabidky.find(n => n.id === 'N1').status === 'EXPIRED',
    'a jeho čekající nabídky propadnou, ať ho cron nepřepíše jinam');
  ok(db.oznameni.some(o => o.userId === 'U1'), 'hráč se dozví, že ho někdo zařadil');
  ok(db.oznameni.some(o => o.userId === 'U9' && /Nový hráč/.test(o.title)),
    'vedoucí týmu taky');

  const mailKlub = db.maily.find(m => m.to === 'volny@test.cz');
  ok(mailKlub?.parametry.otevreny === false && mailKlub?.parametry.castka === 300,
    'a přijde mu e-mail, že je v týmu, s licencí 300 Kč — oznámení v appce nestačí');
  ok(db.polozkyKosiku.length === 0,
    'u klubového týmu se do košíku nic nedává — platí se jen licence');

  // --- brankář si drží slot ---
  const brankar = await volej('/supervisor/players/P2/team', { teamId: 'T3', jersey: 1 });
  ok(brankar.status === 200, 'brankáře jde zařadit taky');
  ok(db.soupisky.find(r => r.playerId === 'P2')?.slot === 'GOALKEEPER',
    'a na soupisce sedí v brankářském slotu, ne v poli');

  // --- kolize dresu ---
  const kolize = await volej('/supervisor/players/P2/team', { teamId: 'T1', jersey: 17 });
  ok(kolize.status === 409 && kolize.telo.code === 'JERSEY_TAKEN', 'obsazený dres vrátí 409');
  ok(/Pavel Volny/.test(kolize.telo.error), 'a řekne, kdo to číslo má — jinak se nedá vybrat jiné');

  // --- zamítnutý tým ---
  const zamitnuty = await volej('/supervisor/players/P2/team', { teamId: 'T2', jersey: 3 });
  ok(zamitnuty.status === 409 && zamitnuty.telo.code === 'TEAM_REJECTED',
    'do zamítnutého týmu se hráč zařadit nedá');

  // --- přesun mezi týmy ---
  const presun = await volej('/supervisor/players/P1/team', { teamId: 'T3', jersey: 17 });
  ok(presun.status === 200, 'hráč jde přesunout do jiného týmu');
  ok(!db.soupisky.some(r => r.playerId === 'P1' && r.teamId === 'T1'),
    'ze staré soupisky zmizel — jinak by se limity počítaly ze špatných čísel');
  ok(db.soupisky.some(r => r.playerId === 'P1' && r.teamId === 'T3'), 'a na nové je');

  // --- odchod z týmu ---
  const odchod = await volej('/supervisor/players/P1/team', { teamId: null });
  ok(odchod.status === 200 && db.players.find(p => p.id === 'P1').teamId === null,
    'hráče jde z týmu vyvést');
  ok(!db.soupisky.some(r => r.playerId === 'P1'), 'a ze soupisky zmizí, když za tým nenastoupil');
  ok(db.draftProfily.find(d => d.playerId === 'P1').isActive === false,
    'do poolu se nevrací sám od sebe — ne každý odchod znamená, že shání tým');

  const odchodDoPoolu = await volej('/supervisor/players/P2/team', { teamId: null, doPoolu: true });
  ok(odchodDoPoolu.status === 200 && db.draftProfily.find(d => d.playerId === 'P2').isActive === true,
    'na výslovné přání se vrátí mezi volné hráče');

  // --- otevřený tým: zařazení je zároveň vstup do soutěže ---
  const doOtevreneho = await volej('/supervisor/players/P1/team', { teamId: 'T4', jersey: 17 });
  ok(doOtevreneho.status === 200, 'do otevřeného týmu jde hráče zařadit taky');
  const polozka = db.polozkyKosiku.find(i => i.playerId === 'P1' && i.kind === 'OPEN_ENTRY');
  ok(polozka?.amount === 800,
    'a rovnou mu do košíku spadne balík Virtuální vedoucí za 800 Kč — sám si ho přidat nemůže');
  ok(db.kosiky.find(c => c.id === polozka?.cartId)?.userId === 'U1',
    'košík je hráčův, ne supervisorův — platí ten, koho se poplatek týká');
  ok(doOtevreneho.telo.vstupniBalik?.amount === 800, 'a odpověď to řekne i webu');
  const mailOtevreny = db.maily.find(m => m.to === 'volny@test.cz' && m.parametry.otevreny);
  ok(mailOtevreny?.parametry.castka === 800 && mailOtevreny?.parametry.licVBaliku === true,
    'e-mail nese tu samou částku i to, že je v ní licence — jinak by ji člověk platil podruhé');

  const znovu = await volej('/supervisor/players/P1/team', { teamId: 'T4', jersey: 18 });
  ok(znovu.status === 200
    && db.polozkyKosiku.filter(i => i.playerId === 'P1' && i.kind === 'OPEN_ENTRY').length === 1,
    'opakované zařazení balík do košíku nepřidá podruhé');

  const brankarDoOtevreneho = await volej('/supervisor/players/P2/team', { teamId: 'T4', jersey: 1 });
  ok(brankarDoOtevreneho.telo.vstupniBalik?.amount === 500,
    'kdo má licenci zaplacenou, platí jen startovné 500 Kč');
  const mailBrankar = db.maily.find(m => m.to === 'brankar@test.cz' && m.parametry.otevreny);
  ok(mailBrankar?.parametry.licVBaliku === false, 'a e-mail mu licenci neúčtuje podruhé');

  // --- odchod hráče, který už odehrál ---
  const sStarty = await volej('/supervisor/players/P3/team', { teamId: null });
  ok(sStarty.status === 200, 'odejít může i ten, kdo za tým hrál');
  ok(db.soupisky.some(r => r.playerId === 'P3' && r.teamId === 'T1'),
    'ale soupiska mu zůstane — stojí na ní statistiky a nárok na playoff');
  ok(sStarty.telo.ponechanoKvuliStartum === true, 'a odpověď to řekne nahlas');

  // --- dres a post ---
  const dres = await volej('/supervisor/players/P3', { jersey: 23, position: 'Brankář' });
  ok(dres.status === 200 && db.players.find(p => p.id === 'P3').jersey === 23,
    'dres jde přepsat i bez zásahu do týmu');
  ok(db.players.find(p => p.id === 'P3').position === 'Brankář', 'post taky');

  const dresMimo = await volej('/supervisor/players/P3', { jersey: 100 });
  ok(dresMimo.status === 400, 'číslo mimo rozsah 0–99 neprojde');

  const nikdo = await volej('/supervisor/players/PXX/team', { teamId: 'T1' });
  ok(nikdo.status === 404, 'neexistující hráč vrátí 404, ne pád');

  // --- mazání hráče ---
  const sHistorii = await volej('/supervisor/players/P3?ucet=1', null, 'DELETE');
  ok(sHistorii.status === 409 && sHistorii.telo.code === 'PLAYER_HAS_HISTORY',
    'hráče, který už nastoupil, smazat nejde — na zápasech stojí statistiky');
  ok(db.players.some(p => p.id === 'P3'), 'a opravdu zůstal v databázi');

  const sPlatbou = await volej('/supervisor/players/P2?ucet=1', null, 'DELETE');
  ok(sPlatbou.status === 409 && sPlatbou.telo.code === 'PLAYER_HAS_PAYMENTS',
    'zaplacená licence hráče před smazáním taky ochrání — peníze mají protistranu v bance');

  const vedouciHrac = await volej('/supervisor/players/P4?ucet=1', null, 'DELETE');
  ok(vedouciHrac.status === 200 && !db.players.some(p => p.id === 'P4'),
    'hráčský profil vedoucího se smazat dá');
  ok(vedouciHrac.telo.ucet?.smazan === false && vedouciHrac.telo.ucet.code === 'USER_IS_MANAGER',
    'ale jeho účet ne — tým by přišel o vedoucího');
  ok(db.users.some(u => u.id === 'U4'), 'účet vedoucího v databázi zůstal');

  const smazan = await volej('/supervisor/players/P1?ucet=1', null, 'DELETE');
  ok(smazan.status === 200 && !db.players.some(p => p.id === 'P1'),
    'hráč bez historie a bez plateb se smazat dá');
  ok(!db.soupisky.some(r => r.playerId === 'P1') && !db.draftProfily.some(d => d.playerId === 'P1'),
    'a zmizí s ním soupiska i draft profil');
  ok(smazan.telo.ucet?.smazan === true && !db.users.some(u => u.id === 'U1'),
    's ucet=1 zmizí i účet — jinak zůstane e-mail obsazený a znovu se registrovat nejde');

  const bezUctu = await volej('/supervisor/players/PXX', null, 'DELETE');
  ok(bezUctu.status === 404, 'mazání neexistujícího hráče vrátí 404, ne pád');

  server.close();
  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
});
