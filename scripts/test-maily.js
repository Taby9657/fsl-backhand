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
      && p.upominekPoslano < where.upominekPoslano.lt
      && (where.player.teamId === null ? p.player.teamId === null : p.player.teamId !== null)
      && p.player.userId !== null
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
      && t.upominekPoslano < where.upominekPoslano.lt
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
const sezona   = require('../src/utils/sezona');

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

  // Do otevření poolu hráče nevidí ani vedoucí. Slib „tvoje karta je vidět
  // a vedoucí ti můžou poslat nabídku" byl proto do 16. 9. nepravda — a hráč
  // z toho četl, že o něj nikdo nestojí.
  ok(!/karta je vidět|můžou poslat nabídku/i.test(draft.text),
    'hráč v draftu: neslibuje viditelnost, kterou do otevření poolu nemá');
  ok(draft.text.includes(sezona.den(sezona.OTEVRENI_DRAFTU))
    && draft.html.includes(sezona.den(sezona.OTEVRENI_DRAFTU)),
    'a místo toho řekne, kdy se seznam vedoucím otevře');
  ok(/licenci 300 Kč/i.test(draft.text) && /až tě někdo vezme do týmu/i.test(draft.text),
    'a dopředu řekne, že licenci 300 Kč platí, teprve až ho někdo vezme');

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

  // --- 7. plán: komu, kdy a kolikrát ---
  //
  // Plán je 2 / 9 / 30 dní (hráč, tým) a 3 / 14 dní (draft). Test počítá
  // v konstantách z modulu, ne v natvrdo napsaných dnech — když se plán
  // posune, nesmí se rozpadnout, jen se posunou i kontroly.
  reset();
  const ODKDY = new Date('2020-01-01');
  // 12:00 pražského času — uvnitř okna 9:00–20:00, ať plán nezkoumá okno.
  const REG = new Date('2026-09-20T10:00:00Z');   // kdy se všichni zaregistrovali
  const po = (ms) => new Date(REG.getTime() + ms);
  const HODINA = 60 * 60 * 1000;
  const DEN = 24 * HODINA;

  const hrac = (id, jmeno, teamId, email) => ({
    id, season: '2026/27', licFee: 300, licStatus: 'PENDING',
    upominkaAt: null, upominekPoslano: 0,
    player: { firstName: jmeno, teamId, userId: 'U' + id, createdAt: REG, user: { email } },
  });
  db.playerPayments.push(hrac('PP1', 'Jan', 'T1', 'jan@test.cz'));
  db.playerPayments.push(hrac('PP2', 'David', null, 'david@test.cz'));
  db.teamPayments.push({
    id: 'TP1', season: '2026/27', amount: 3000, status: 'PENDING',
    upominkaAt: null, upominekPoslano: 0,
    team: { name: 'Draci', createdAt: REG, managers: [{ user: { email: 'petr@test.cz' } }] },
  });

  const bez = () => { const z = db.odeslane.slice(); db.odeslane.length = 0; return z; };
  const bezi = (ms) => upominky.posliUpominky({ ted: po(ms), od: ODKDY });

  const [P1, P2, P3] = upominky.PLAN_PLATBA;
  const [D1, D2]     = upominky.PLAN_DRAFT;

  // Hodinu po registraci nemá odejít nic — do 16. 9. 2026 tady chodila
  // první připomínka a bylo to moc brzo.
  await bezi(HODINA);
  ok(bez().length === 0, 'hodinu po registraci nechodí nic');

  // Těsně před první fází pořád ticho.
  await bezi(P1 - HODINA);
  ok(bez().length === 0, 'ani těsně před první fází');

  // První fáze: hráč v týmu a vedoucí. Hráč bez týmu ne — ten nic nedluží.
  await bezi(P1);
  const prvni = bez();
  ok(prvni.some(z => z.to === 'jan@test.cz'), 'první fáze: hráč v týmu bez licence');
  ok(prvni.some(z => z.to === 'petr@test.cz'), 'první fáze: vedoucí bez zaplacené registrace');
  ok(!prvni.some(z => z.to === 'david@test.cz'),
    'hráči bez týmu ještě nechodí nic — v draftu zatím nic neplatí');
  ok(prvni.every(z => /Ještě zbývá zaplatit/.test(z.subject)), 'a je to první fáze plánu');

  // Druhá fáze je až za devět dní, takže mezitím ticho.
  await bezi(P1 + 2 * HODINA);
  ok(bez().length === 0, 'druhá fáze nepřijde hned po první');

  // Draft se ozve později a jinak.
  await bezi(D1);
  const nabidka = bez().find(z => z.to === 'david@test.cz');
  ok(!!nabidka, 'hráč v draftu dostane první zprávu vlastním tempem');
  ok(/draftu/i.test(nabidka.subject) && !/Visí na tobě/.test(nabidka.text),
    'a není to upomínka — je to nabídka Virtuálního vedoucího, nic nedluží');

  // Druhá fáze platícím.
  await bezi(P2);
  ok(bez().some(z => z.to === 'jan@test.cz' && /Připomínka/.test(z.subject)),
    'druhá připomínka hráči v týmu');

  // Druhá (a poslední) nabídka do draftu.
  await bezi(D2);
  ok(bez().some(z => /poslední připomínka/i.test(z.text) && z.to === 'david@test.cz'),
    'poslední nabídka tomu v draftu');

  // Třetí a poslední fáze platícím.
  await bezi(P3);
  ok(bez().some(z => z.to === 'jan@test.cz' && /Poslední/.test(z.subject)),
    'poslední připomínka');

  // Dál se mlčí.
  await bezi(P3 + 60 * DEN);
  ok(bez().length === 0, 'po vyčerpání plánu se přestane psát — čtvrtá zpráva nepřijde');
  ok(db.playerPayments.find(p => p.id === 'PP1').upominekPoslano === 3
    && db.playerPayments.find(p => p.id === 'PP2').upominekPoslano === 2,
    'počítadlo sedí: tři zprávy platícímu, dvě tomu v draftu');

  // Žádná zpráva nesmí tvrdit, jak dlouho to trvá — plán se posouvá, texty ne.
  ok(!/včera|týden se ti|jsi u nás týden/i.test(
    [1, 2, 3].map(f => mailer.upominkaPlatbaMail({ polozky: [], castka: 0, faze: f }).text
      + mailer.nabidkaVstupuMail({ faze: f }).text).join(' ')),
    'texty upomínek neuvádějí počet dní — přežijou posun plánu');

  // Kdo zaplatí, vypadne z plánu.
  db.playerPayments.push(hrac('PP3', 'Eva', 'T1', 'eva@test.cz'));
  db.playerPayments.find(p => p.id === 'PP3').licStatus = 'PAID';
  await bezi(P1 + HODINA);
  ok(!bez().some(z => z.to === 'eva@test.cz'), 'zaplacené licenci už nechodí nic');

  // --- 7b. nabídka do draftu nesmí znít jako neúspěch, dokud je pool zamčený ---
  const zamcena = mailer.nabidkaVstupuMail({ jmeno: 'David', faze: 1, poolOtevren: false });
  projdi('nabídka se zamčeným poolem', zamcena);
  ok(!/nikdo nenabídl/i.test(zamcena.text),
    'zamčený pool: netvrdí „nikdo ti nenabídl místo" — vedoucí ho ještě nevidí');
  ok(zamcena.text.includes(sezona.den(sezona.OTEVRENI_DRAFTU)),
    'a řekne, odkdy se něco dít může');

  const otevrena = mailer.nabidkaVstupuMail({ jmeno: 'David', faze: 2, poolOtevren: true });
  ok(/nikdo nenabídl/i.test(otevrena.text),
    'otevřený pool: tam už věta o tom, že se nikdo neozval, sedí');

  // --- 8. denní okno: v noci se nepíše ---
  //
  // Fáze se počítá od registrace, takže kdo se přihlásil ve tři ráno, by ve
  // tři ráno dostal i připomínku. Okno to posune na ráno, plán neposouvá.
  ok(!upominky.vOkne(new Date('2026-09-20T01:00:00Z')), '3:00 pražského času je mimo okno');
  ok(upominky.vOkne(new Date('2026-09-20T07:00:00Z')), '9:00 je v okně');
  ok(upominky.vOkne(new Date('2026-09-20T17:59:00Z')), '19:59 ještě taky');
  ok(!upominky.vOkne(new Date('2026-09-20T18:00:00Z')), '20:00 už ne');
  // V zimě je Praha UTC+1 — hodina se bere přes Intl, ne přes getHours().
  ok(!upominky.vOkne(new Date('2026-01-20T07:59:00Z')), 'v zimě 8:59 taky mimo okno');
  ok(upominky.vOkne(new Date('2026-01-20T08:00:00Z')), 'a v zimě 9:00 v okně');

  reset();
  db.playerPayments.push(hrac('PP9', 'Noc', 'T1', 'noc@test.cz'));
  const vNoci = await upominky.posliUpominky({
    ted: new Date(REG.getTime() + P1 + 13 * HODINA), // 1:00 pražského času
    od:  ODKDY,
  });
  ok(vNoci.mimoOkno === true && db.odeslane.length === 0,
    'dozrálá připomínka v noci počká na ráno');
  const rano = await upominky.posliUpominky({
    ted: new Date(REG.getTime() + P1 + 22 * HODINA), // 10:00 pražského času
    od:  ODKDY,
  });
  ok(rano.hracu === 1 && db.odeslane.some(z => z.to === 'noc@test.cz'),
    'a ráno odejde');

  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
})();
