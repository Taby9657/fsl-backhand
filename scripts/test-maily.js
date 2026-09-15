/**
 * Test transakčních e-mailů.
 *
 * Tyhle zprávy jdou ven bez code review a čte je člověk, který o lize ještě
 * nic neví. Hlídá se proto dvojí:
 *
 *   1. **Co v nich být nesmí** — DPH (liga není plátce), slovo „výkop",
 *      jméno provozovatele, slib mobilní aplikace, kterou si nikdo nemůže
 *      stáhnout, a u upomínky jakákoli hrozba smazáním.
 *   2. **Komu upomínka chodí** — jen tomu, kdo doopravdy platit má.
 *      Hráč bez týmu v draftu neplatí nic a nesmí dostat nic.
 */
const Module = require('module');

// ---------- mock databáze ----------

let db;
function reset() {
  db = { playerPayments: [], teamPayments: [], odeslane: [] };
}

const fakePrisma = {
  playerPayment: {
    findMany: async ({ where }) => db.playerPayments.filter(p =>
      where.licStatus.in.includes(p.licStatus)
      && p.upominkaAt == null
      && p.player.teamId !== null
      && p.player.userId !== null
      && p.player.createdAt <= where.player.createdAt.lte
      && p.player.createdAt >= where.player.createdAt.gte),
    update: async ({ where, data }) => {
      const p = db.playerPayments.find(x => x.id === where.id);
      Object.assign(p, data);
      return p;
    },
  },
  teamPayment: {
    findMany: async ({ where }) => db.teamPayments.filter(t =>
      where.status.in.includes(t.status)
      && t.upominkaAt == null
      && t.team.createdAt <= where.team.createdAt.lte
      && t.team.createdAt >= where.team.createdAt.gte),
    update: async ({ where, data }) => {
      const t = db.teamPayments.find(x => x.id === where.id);
      Object.assign(t, data);
      return t;
    },
  },
};

const orig = Module._load;
Module._load = function (request) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  return orig.apply(this, arguments);
};

const mailer = require('../src/services/mailer');
// Odesílání se nahradí záznamem — do Resendu se z testu nevolá.
mailer.posliBezpecne = async (to, zprava, kde) => {
  db.odeslane.push({ to, kde, ...zprava });
  return { ok: true };
};
const upominky = require('../src/services/upominky');

// ---------- pomocníci ----------

let fail = 0;
const ok = (podminka, popis) => { console.log((podminka ? '✓ ' : '✗ ') + popis); if (!podminka) fail++; };

/** Co nesmí být v žádné zprávě, která jde ven. */
const ZAKAZANO = [
  [/DPH/i,                 'DPH'],
  [/výkop/i,               'slovo „výkop"'],
  [/Tabášek|Tabasek/i,     'jméno provozovatele'],
  [/App Store|Google Play|stáhni si aplikaci/i, 'slib aplikace'],
];

function projdi(nazev, zprava) {
  const vse = `${zprava.subject}\n${zprava.text}\n${zprava.html ?? ''}`;
  for (const [vzor, popis] of ZAKAZANO) {
    ok(!vzor.test(vse), `${nazev}: neobsahuje ${popis}`);
  }
  ok(!!zprava.subject && !!zprava.text && !!zprava.html, `${nazev}: má předmět, text i HTML`);
}

// ---------- testy ----------

(async () => {
  reset();

  // --- 1. hráč bez týmu ---
  const draft = mailer.registraceHracMail({ jmeno: 'David', tym: null });
  projdi('hráč v draftu', draft);
  ok(/draftu/i.test(draft.text), 'hráč v draftu: ví, že je v draftu volných hráčů');
  ok(/Virtuální vedoucí/.test(draft.text), 'hráč v draftu: dozví se i o balíku, ať nečeká zbytečně');
  ok(/800 Kč/.test(draft.text) && /500 Kč/.test(draft.text),
    'a je v něm rozepsaná cena, ne jen výsledek');
  ok(/startovné se vrací/i.test(draft.text),
    'včetně toho, že startovné se při odstoupení vrací — na to se nesmí přijít až potom');

  // --- 2. hráč v týmu ---
  const vTymu = mailer.registraceHracMail({ jmeno: 'Jan', tym: 'Draci' });
  projdi('hráč v týmu', vTymu);
  ok(/Draci/.test(vTymu.text) && /Draci/.test(vTymu.subject), 'hráč v týmu: zpráva jmenuje tým');
  ok(!/Virtuální vedoucí/.test(vTymu.text),
    'a balík se mu nenabízí — ten je pro toho, kdo tým nemá');

  // --- 3. vedoucí ---
  const vedouci = mailer.registraceVedouciMail({ jmeno: 'Petr', tym: 'Draci', kod: 'FSL-DR-1234' });
  projdi('vedoucí', vedouci);
  ok(/FSL-DR-1234/.test(vedouci.text) && /FSL-DR-1234/.test(vedouci.html),
    'vedoucí: dostane pozvánkový kód písemně — jinde ho písemně nedostane');
  ok(/schválen/i.test(vedouci.text), 'a ví, že tým čeká na schválení');
  ok(/3000 Kč|3 000 Kč/.test(vedouci.text), 'a zná částku za registraci');

  // --- 4. rozhodčí ---
  const rozhodci = mailer.registraceRozhodciMail({ jmeno: 'Eva' });
  projdi('rozhodčí', rozhodci);
  ok(!/Kč/.test(rozhodci.text), 'rozhodčí: v jeho zprávě není žádná částka — neplatí nic');
  ok(/bankovní\s+spojení/i.test(rozhodci.text),
    'a ví, že bankovní spojení se řeší až po schválení, ne v přihlášce');

  // --- 5. platba dorazila ---
  const platba = mailer.platbaPrijataMail({
    jmeno: 'David',
    polozky: [{ nazev: 'Hráčská licence', castka: 300 }, { nazev: 'Balíček 16 zápasů', castka: 2600 }],
    castka: 2900,
    prevodem: true,
  });
  projdi('platba dorazila', platba);
  ok(/2900 Kč|2 900 Kč/.test(platba.subject), 'platba: částka je vidět už v předmětu');
  ok(/Balíček 16 zápasů/.test(platba.text), 'a jsou v ní vypsané položky');

  // --- 6. upomínka ---
  const upominka = mailer.upominkaPlatbaMail({
    jmeno: 'Jan',
    polozky: [{ nazev: 'Hráčská licence', castka: 300 }],
    castka: 300,
  });
  projdi('upomínka', upominka);
  ok(!/smaž|smaz|zrušíme|propadne|vymaž/i.test(`${upominka.subject} ${upominka.text}`),
    'upomínka: nikomu nehrozí smazáním — převodem platba dorazí za den dva');
  ok(/nenastoup|nezařadí/i.test(upominka.text),
    'místo toho říká věcný důsledek: bez licence se nenastupuje');

  // --- 7. komu upomínka chodí ---
  reset();
  const stary = new Date(Date.now() - 3 * 60 * 60 * 1000);
  db.playerPayments.push({
    id: 'PP1', season: '2026/27', licFee: 300, licStatus: 'PENDING', upominkaAt: null,
    player: { firstName: 'Jan', teamId: 'T1', userId: 'U1', createdAt: stary, user: { email: 'jan@test.cz' } },
  });
  db.playerPayments.push({
    id: 'PP2', season: '2026/27', licFee: 300, licStatus: 'PENDING', upominkaAt: null,
    player: { firstName: 'David', teamId: null, userId: 'U2', createdAt: stary, user: { email: 'david@test.cz' } },
  });
  db.playerPayments.push({
    id: 'PP3', season: '2026/27', licFee: 300, licStatus: 'PENDING', upominkaAt: null,
    player: { firstName: 'Nový', teamId: 'T1', userId: 'U3', createdAt: new Date(), user: { email: 'novy@test.cz' } },
  });
  db.teamPayments.push({
    id: 'TP1', season: '2026/27', amount: 3000, status: 'PENDING', upominkaAt: null,
    team: { name: 'Draci', createdAt: stary, managers: [{ user: { email: 'petr@test.cz' } }] },
  });

  // `od` se předává, aby test nezáležel na tom, kolikátého zrovna je.
  const ODKDY = new Date('2020-01-01');
  const prvni = await upominky.posliUpominky({ od: ODKDY });
  const komu = db.odeslane.map(z => z.to);
  ok(komu.includes('jan@test.cz'), 'upomínka dorazí hráči v týmu, který nemá licenci');
  ok(!komu.includes('david@test.cz'),
    'hráči bez týmu nedorazí nic — v draftu zatím nic neplatí');
  ok(!komu.includes('novy@test.cz'),
    'a tomu, kdo se registroval před chvílí, se taky nepíše — hodina ještě neuběhla');
  ok(komu.includes('petr@test.cz'), 'vedoucí dostane připomínku nezaplacené registrace');
  ok(prvni.hracu === 1 && prvni.tymu === 1, 'počty v návratové hodnotě sedí');

  const pocetPoPrvnim = db.odeslane.length;
  const druhy = await upominky.posliUpominky({ od: ODKDY });
  ok(db.odeslane.length === pocetPoPrvnim && druhy.hracu === 0,
    'druhý průchod cronu nenapíše tomutéž člověku podruhé');

  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
})();
