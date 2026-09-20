/**
 * Status náboru — e-mail, který si backend posílá sám.
 *
 * ── Proč to dělá backend, a ne naplánovaný běh asistenta ────────────────
 * Do 18. 9. 2026 status skládal naplánovaný běh v cloudu: zavolal veřejné
 * API a napsal shrnutí. **Dvakrát za dva dny přišel prázdný** — jednou se
 * úloha vůbec nespustila, podruhé si nástroj na stahování vyžádal schválení
 * adresy, které v běhu bez člověka nemá kdo potvrdit.
 *
 * K tomu přibyl druhý, zásadnější důvod: **veřejné API počty registrací
 * vůbec nevydá** — `teams.js` i `players.js` vrací do startu sezóny
 * prázdné pole každému kromě supervisora. Kdokoli mimo backend se k nim
 * tedy nedostane, ať se schvalování vyřeší, nebo ne.
 *
 * **Co tím naopak nezískáš, je výklad** — tenhle e-mail čísla popisuje
 * a diagnostikuje podle pevných prahů, ale nepřemýšlí. Delší úvahu píše
 * jednou denně asistent nad týmiž čísly.
 *
 * ── Kdy chodí ───────────────────────────────────────────────────────────
 * **Každé dvě hodiny od 8:00 do 22:00** pražského času. V 8:00 a ve 20:00
 * jde **plný report**, ve zbylých slotech **krátký** — jen co se změnilo
 * od posledně. Osm stejně podrobných e-mailů denně nikdo nečte.
 *
 * ── Co se počítá do tempa ───────────────────────────────────────────────
 * **Každá dokončená registrace jakékoli role** — hráč, vedoucí (tým) i
 * rozhodčí. Tak si to majitel nastavil 18. 9. 2026.
 *
 * ── Cíl na další den ────────────────────────────────────────────────────
 * **Průměr za posledních 7 dní plus 20 %**, zaokrouhleno nahoru. Majitel
 * to 19. 9. vybral proti dvěma jiným variantám (pevných 5 denně a dopočet
 * do průměru 5/den do uzávěrky): tenhle způsob tlačí čísla nahoru
 * postupně a zůstává splnitelný. **Neváže se ale na 1. 11. ani na číslo
 * 5** — proto se dlouhodobé tempo proti cíli 5/den vykazuje vedle něj,
 * aby nebylo vidět jen to hezčí z obou.
 *
 * Cíl na zítřek se stanoví ve **večerním plném reportu** a uloží se do
 * `Settings`. Ráno se proti němu měří, jak den dopadá.
 */

const prisma = require('../lib/prisma');
const { sendMail } = require('./mailer');
const { spocitejTrychtyr } = require('./trychtyr');

/**
 * Kam status chodí.
 *
 * **Schválně ne `supervisorAddress()`**, i když je to jinde v projektu
 * zavedený způsob: ta funkce čte `SUPERVISOR_EMAIL`, a kdyby ho někdo
 * někdy přepnul na soukromou schránku, odešel by tam i tenhle e-mail
 * s celou statistikou náboru. Firemní adresa je tu proto napevno jako
 * výchozí a přebít ji jde jen vědomě, vlastní proměnnou.
 */
function prijemce() {
  return process.env.STATUS_EMAIL ?? 'info@fslleague.cz';
}

/** Začátek propagace na Meta. Od tohohle dne se počítá dlouhodobý průměr. */
const ZACATEK = new Date('2026-09-15T00:00:00+02:00');

/** Uzávěrka přihlášek. Do tohohle dne se má dlouhodobý cíl stihnout. */
const UZAVERKA = new Date('2026-11-01T23:59:59+01:00');

/** Dlouhodobý cíl majitele: 5 registrací denně za celé období náboru. */
const CIL_DENNE = 5;

/** O kolik se zvedá sedmidenní průměr při stanovení cíle na zítřek. */
const PRIRAZKA = 0.2;

/** Hodiny pražského času, ve kterých status odchází. */
const SLOTY = [8, 10, 12, 14, 16, 18, 20, 22];

/** Sloty s plným reportem. Ve zbytku jde jen změna od posledně. */
const HLAVNI_SLOTY = [8, 20];

const DEN_MS = 24 * 60 * 60 * 1000;

/* ==================== pražský čas ==================== */

/**
 * Railway běží v UTC, cíle i sloty jsou ale v pražském čase. Tohle je
 * jediné místo, kde se ta dvě pásma potkávají — počítá se přes `Intl`,
 * takže letní i zimní čas řeší systémová databáze časových pásem a ne
 * natvrdo napsaná konstanta, která by v říjnu přestala platit.
 */
function prazskeCasti(kdy = new Date()) {
  const f = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const d = Object.fromEntries(
    f.formatToParts(kdy).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return {
    rok: Number(d.year), mesic: Number(d.month), den: Number(d.day),
    hodina: Number(d.hour === '24' ? '0' : d.hour), minuta: Number(d.minute),
    sekunda: Number(d.second),
  };
}

function prazskyCas(kdy = new Date()) {
  const { hodina, minuta } = prazskeCasti(kdy);
  return `${String(hodina).padStart(2, '0')}:${String(minuta).padStart(2, '0')}`;
}

function prazskeDatum(kdy = new Date()) {
  const { rok, mesic, den } = prazskeCasti(kdy);
  return `${den}. ${mesic}. ${rok}`;
}

/** `2026-09-19` v pražském čase — klíč, pod kterým se drží cíl na den. */
function prazskyKlicDne(kdy = new Date()) {
  const { rok, mesic, den } = prazskeCasti(kdy);
  return `${rok}-${String(mesic).padStart(2, '0')}-${String(den).padStart(2, '0')}`;
}

/** O kolik je pražský čas napřed proti UTC v daném okamžiku, v ms. */
function posunPasma(kdy) {
  const { rok, mesic, den, hodina, minuta, sekunda } = prazskeCasti(kdy);
  return Date.UTC(rok, mesic - 1, den, hodina, minuta, sekunda) - kdy.getTime();
}

/**
 * Půlnoc pražského dne, ve kterém `kdy` leží.
 *
 * **Nedá se to spočítat odečtením uplynulých hodin** — to selže přesně
 * 25. 10. 2026, kdy má pražský den 25 hodin: večer už platí zimní čas
 * (+1), ale půlnoc byla ještě v letním (+2), takže odečtení 21 hodin od
 * 21:00 skončí o hodinu vedle. A ten den padne doprostřed náboru.
 *
 * Proto se půlnoc skládá z data a dopočítává se k ní posun pásma. Dvě
 * kola stačí: první odhad se může trefit do špatné strany přechodu,
 * druhé už počítá s posunem platným v tu půlnoc.
 */
function zacatekDne(kdy = new Date()) {
  const { rok, mesic, den } = prazskeCasti(kdy);
  const pulnocJakoUTC = Date.UTC(rok, mesic - 1, den, 0, 0, 0);
  let t = pulnocJakoUTC;
  for (let i = 0; i < 2; i += 1) {
    t = pulnocJakoUTC - posunPasma(new Date(t));
  }
  return new Date(t);
}

/** Půlnoc předchozího pražského dne. Přes 12 h zpět, ať DST nevadí. */
function zacatekVcerejska(kdy = new Date()) {
  return zacatekDne(new Date(zacatekDne(kdy).getTime() - 12 * 60 * 60 * 1000));
}

/**
 * Má se teď poslat?
 *
 * Ano, když je pražská hodina jedním ze slotů a od začátku toho slotu ještě
 * nic neodešlo. **Okno je celá hodina schválně:** kdyby se backend zrovna
 * v 8:00 nasazoval, ranní status by jinak vypadl úplně — takhle odejde
 * v 8:05 nebo v 8:40, jen o kousek později.
 *
 * `poslednePoslano` se čte z databáze (`Settings`), ne z paměti: restart
 * Railway je běžná věc a v paměti by se zapomnělo, že status už šel — a
 * lidem by chodily dva stejné e-maily za sebou.
 */
function jeCasPoslat(poslednePoslano, kdy = new Date()) {
  const { hodina, minuta } = prazskeCasti(kdy);
  if (!SLOTY.includes(hodina)) return false;

  const zacatek = new Date(kdy.getTime() - minuta * 60 * 1000);
  zacatek.setSeconds(0, 0);

  if (!poslednePoslano) return true;
  return new Date(poslednePoslano) < zacatek;
}

/** Je tenhle slot plný report? */
function jeHlavni(kdy = new Date()) {
  return HLAVNI_SLOTY.includes(prazskeCasti(kdy).hodina);
}

/* ==================== čísla ==================== */

/** Registrace všech rolí v daném okně. Jedno místo, ať se to nerozejde. */
async function registraciOd(od, do_ = null) {
  const kde = { createdAt: do_ ? { gte: od, lt: do_ } : { gte: od } };
  const [hracu, tymu, rozhodcich] = await Promise.all([
    prisma.player.count({ where: kde }),
    prisma.team.count({ where: kde }),
    prisma.referee.count({ where: kde }),
  ]);
  return { hracu, tymu, rozhodcich, celkem: hracu + tymu + rozhodcich };
}

/**
 * Všechno, co se do e-mailu dává. Jedna funkce schválně: kdo bude chtít
 * status někam jinam (na web, do Slacku), vezme si tohle a nebude znovu
 * skládat dotazy.
 *
 * `poslednePoslano` slouží ke krátkému reportu — „co přibylo od posledně".
 * Když chybí (první běh vůbec), bere se okno dvou hodin, tedy jeden slot.
 */
async function sesbirej(poslednePoslano = null, cilNaDnes = null) {
  const ted = new Date();
  const pred24h = new Date(ted.getTime() - DEN_MS);
  const dnesOd = zacatekDne(ted);
  const vceraOd = zacatekVcerejska(ted);
  const pred7dny = new Date(dnesOd.getTime() - 7 * DEN_MS);
  const odMinule = poslednePoslano
    ? new Date(poslednePoslano)
    : new Date(ted.getTime() - 2 * 60 * 60 * 1000);

  const hodinOdMinule = Math.max(1, Math.ceil((ted - odMinule) / (60 * 60 * 1000)));

  const [
    tymu, hracu, hracuVDraftu, rozhodcich, hracuSLicenci,
    za24h, dnes, vcera, za7dni, odZacatkuR, odPosledne,
    trychtyr, trychtyrOdMinule,
  ] = await Promise.all([
    prisma.team.count(),
    prisma.player.count(),
    prisma.player.count({ where: { teamId: null } }),
    prisma.referee.count(),
    prisma.player.count({ where: { licensed: true } }),

    registraciOd(pred24h),
    registraciOd(dnesOd),
    registraciOd(vceraOd, dnesOd),
    registraciOd(pred7dny, dnesOd),
    registraciOd(ZACATEK),
    registraciOd(odMinule),

    spocitejTrychtyr(24),
    spocitejTrychtyr(hodinOdMinule),
  ]);

  /* Dny se počítají nahoru (`ceil`), aby se prvních pár hodin propagace
     nedělilo číslem blízkým nule a nevyrobilo tím nesmyslně vysoký průměr. */
  const dnuBehem = Math.max(1, Math.ceil((ted - ZACATEK) / DEN_MS));
  const dnuCelkem = Math.max(1, Math.ceil((UZAVERKA - ZACATEK) / DEN_MS));
  const dnuZbyva = Math.max(0, Math.ceil((UZAVERKA - ted) / DEN_MS));

  /* Sedmidenní průměr se počítá z **uzavřených** dní (do dnešní půlnoci).
     Kdyby se do něj počítal i rozdělaný dnešek, ráno by průměr spadl jen
     tím, že den teprve začal — a cíl na zítřek by se tím podstřelil. */
  const dnuVOkne = Math.min(7, Math.max(1, Math.ceil((dnesOd - ZACATEK) / DEN_MS)));
  const prumer7 = za7dni.celkem / dnuVOkne;

  const prumerCelkem = odZacatkuR.celkem / dnuBehem;
  const cilCelkem = CIL_DENNE * dnuCelkem;
  const chybi = Math.max(0, cilCelkem - odZacatkuR.celkem);
  const potrebaDenne = dnuZbyva > 0 ? chybi / dnuZbyva : null;

  /* Cíl na zítřek: sedmidenní průměr + 20 %, nahoru, nejmíň 1. Nula by
     znamenala „stačí nic", což není cíl. */
  const cilZitra = Math.max(1, Math.ceil(prumer7 * (1 + PRIRAZKA)));

  return {
    ted,
    hlavni: jeHlavni(ted),
    odMinule,
    hodinOdMinule,
    databaze: { tymu, hracu, hracuVDraftu, rozhodcich, hracuSLicenci },
    za24h, dnes, vcera, odPosledne,
    cil: { dnes: cilNaDnes, zitra: cilZitra, prumer7, dnuVOkne },
    tempo: {
      odZacatku: odZacatkuR.celkem, dnuBehem, dnuZbyva, dnuCelkem,
      prumer: prumerCelkem, cilDlouhodoby: CIL_DENNE, cilCelkem, chybi, potrebaDenne,
    },
    trychtyr,
    trychtyrOdMinule,
  };
}

/* ==================== text ==================== */

const cislo1 = (x) => (x === null || x === undefined ? '—' : x.toFixed(1).replace('.', ','));

/** `+3` / `0` — u změn je znaménko informace, ne ozdoba. */
const seZnamenkem = (x) => (x > 0 ? `+${x}` : `${x}`);

/**
 * Jeden krok trychtýře jako řádek. Kroky, na kterých nikdo nebyl, se
 * vynechávají — nula na patnácti řádcích schová ty tři, kde se něco děje.
 */
function radkyKroku(kroky) {
  return kroky
    .filter((k) => k.navstev > 0)
    .map((k) => `    ${k.krok}: ${k.navstev}`)
    .join('\n');
}

/**
 * Časy na kroku. **Pod 20 měřenými průchody se nevykládají** — na menším
 * vzorku vypadá každý poměr přesvědčivě a není. Proto se vypíšou čísla
 * a rovnou se u nich řekne, že jsou malá.
 */
function radekCasu(krok, casy) {
  if (!casy || casy.mereno === 0) return null;
  const o = casy.odchody;
  const zaklad = `  ${krok}: měřeno ${casy.mereno}, medián ${casy.median} s, `
    + `do 3 s ${casy.do3s}, nad 10 s ${casy.nad10s}\n`
    + `    odchody: klik ${o.klik}, jinam ${o.jinam}, zavřel ${o.zavrel}`;
  return casy.mereno < 20 ? `${zaklad}\n    (malý vzorek, závěr z toho nedělat)` : zaklad;
}

/**
 * Rozpad kliků podle karet na obrazovce výběru role.
 *
 * Vypisují se **všechny čtyři včetně nul** — na rozdíl od kroků trychtýře,
 * kde nula znamená „sem nikdo nedošel". Tady nula znamená „tuhle nabídku
 * nikdo nechtěl", a to je zrovna ta informace, kvůli které to vzniklo.
 */
function radkyKaret(karty) {
  if (!karty?.length) return '    (neměří se)';
  const sirka = Math.max(...karty.map((k) => k.nazev.length));
  return karty
    .map((k) => `    ${k.nazev.padEnd(sirka)}  ${k.pocet}`)
    .join('\n');
}

/** Podíl „z lidí na výběru role si roli vybralo". Hlavní ukazatel webu. */
function volbaRole(trychtyr) {
  const role = trychtyr.trychtyr.vyberRole[0];
  const na = role?.navstev ?? 0;
  const zvolilo = role?.casy?.odchody?.klik ?? 0;
  /* `zvolilo` se bere z odchodů, a ty existují jen u **změřených**
     průchodů. Poměřovat je proti všem návštěvám by u krátkého okna mohlo
     vyjít „z 17 si roli vybralo 23" — proto se vedle vrací i `mereno`. */
  return {
    na, zvolilo, mereno: role?.casy?.mereno ?? 0,
    podil: na > 0 ? (zvolilo / na) * 100 : null,
    casy: role?.casy,
  };
}

/**
 * Diagnóza výběru role podle časů.
 *
 * Nejsou to úvahy, jsou to prahy — a schválně: úvahu píše jednou denně
 * asistent, tohle má být stejné čtení stejných čísel každý den, aby se
 * dal porovnávat vývoj a ne formulace.
 */
function diagnoza(casy) {
  if (!casy || casy.mereno < 20) return 'vzorek pod 20 měřených průchodů, závěr nedělat';
  const o = casy.odchody;
  const podilDo3s = casy.do3s / casy.mereno;
  const podilNad10s = casy.nad10s / casy.mereno;
  const podilJinam = o.jinam / casy.mereno;

  if (podilDo3s > 0.5) {
    return 'většina odchází do 3 s — nechtěné prokliky, problém je v cílení reklamy';
  }
  if (podilNad10s > 0.5) {
    const dovetek = podilJinam > 0.15
      ? ' a část z nich odchází jinam na web, tedy si to jde zjistit'
      : '';
    return `lidé obrazovku čtou (nad 10 s ${casy.nad10s} z ${casy.mereno}) a stejně odejdou`
      + `${dovetek} — problém je v obsahu obrazovky, ne v cílení`;
  }
  return 'časy nejsou vyhraněné, na jednoznačnou diagnózu to nestačí';
}

/** Plný report — ráno a večer. */
function teloPlne(d) {
  const { databaze: db, za24h, dnes, vcera, cil, tempo, trychtyr } = d;
  const v = volbaRole(trychtyr);

  const casy = [
    radekCasu('výběr role', v.casy),
    ...['player', 'manager', 'referee'].flatMap((r) =>
      trychtyr.trychtyr[r].map((k) => radekCasu(`${r}/${k.krok}`, k.casy)),
    ),
  ].filter(Boolean);

  const plneniDnes = cil.dnes
    ? `  dnes ${dnes.celkem} z cíle ${cil.dnes} (${seZnamenkem(dnes.celkem - cil.dnes)})`
    : `  dnes ${dnes.celkem}, cíl na dnešek nebyl stanoven`;

  return `Status náboru, ${prazskeDatum(d.ted)} ${prazskyCas(d.ted)} — plný report.

REGISTRACE V DATABÁZI
  týmy ${db.tymu}, hráči ${db.hracu} (z toho ${db.hracuVDraftu} v draftu), rozhodčí ${db.rozhodcich}
  zaplacených licencí: ${db.hracuSLicenci}

DNEŠEK PROTI CÍLI
${plneniDnes}
  cíl na zítřek: ${cil.zitra} (sedmidenní průměr ${cislo1(cil.prumer7)} + 20 %)

POROVNÁNÍ
  dnes zatím:      ${dnes.celkem}  (hráči ${dnes.hracu}, vedoucí ${dnes.tymu}, rozhodčí ${dnes.rozhodcich})
  včera celkem:    ${vcera.celkem}  (hráči ${vcera.hracu}, vedoucí ${vcera.tymu}, rozhodčí ${vcera.rozhodcich})
  posledních 24 h: ${za24h.celkem}
  průměr 7 dní:    ${cislo1(cil.prumer7)}/den

DLOUHODOBÉ TEMPO PROTI CÍLI ${tempo.cilDlouhodoby}/DEN
  od 15. 9. celkem ${tempo.odZacatku} registrací za ${tempo.dnuBehem} dní
  průměr ${cislo1(tempo.prumer)}/den
  do 1. 11. zbývá ${tempo.dnuZbyva} dní, chybí ${tempo.chybi} registrací
  = ${cislo1(tempo.potrebaDenne)}/den po zbytek náboru

TRYCHTÝŘ PŘIHLÁŠKY (24 h)
  průchodů přihláškou: ${trychtyr.navstev}
  výběr role: ${v.na} → zvolilo roli ${v.zvolilo} (${cislo1(v.podil)} %)
  kliklo na „Jak liga funguje": ${trychtyr.odkazy['jak-funguje']}

  na kterou kartu se kliklo:
${radkyKaret(trychtyr.karty)}

  hráč:
${radkyKroku(trychtyr.trychtyr.player) || '    nikdo'}
  vedoucí:
${radkyKroku(trychtyr.trychtyr.manager) || '    nikdo'}
  rozhodčí:
${radkyKroku(trychtyr.trychtyr.referee) || '    nikdo'}

ČAS NA OBRAZOVCE
${casy.length ? casy.join('\n') : '  nic se nenaměřilo'}

DIAGNÓZA VÝBĚRU ROLE
  ${diagnoza(v.casy)}

NÁVŠTĚVNOST
  vercel.com/fsl12/fsl-web/analytics

Čísla posílá backend přímo z databáze. Delší hodnocení chodí jednou denně zvlášť.
`;
}

/** Krátký report — jen co se změnilo od posledního e-mailu. */
function teloKratke(d) {
  const { odPosledne, dnes, cil, trychtyrOdMinule } = d;
  const v = volbaRole(trychtyrOdMinule);
  /* V krátkém reportu jen karty, na které se za tu dobu kliklo. Čtyři nuly
     každé dvě hodiny by byly jen šum — od toho je plný report. */
  const kliknuteKarty = (trychtyrOdMinule.karty ?? []).filter((k) => k.pocet > 0);

  const plneni = cil.dnes
    ? `${dnes.celkem} z ${cil.dnes}, zbývá ${Math.max(0, cil.dnes - dnes.celkem)}`
    : `${dnes.celkem} (cíl na dnešek nestanoven)`;

  return `Status náboru, ${prazskeDatum(d.ted)} ${prazskyCas(d.ted)} — změna za ${d.hodinOdMinule} h.

  nové registrace: ${odPosledne.celkem}`
    + (odPosledne.celkem > 0
      ? ` (hráči ${odPosledne.hracu}, vedoucí ${odPosledne.tymu}, rozhodčí ${odPosledne.rozhodcich})`
      : '')
    + `
  dnešní cíl: ${plneni}
  průchodů přihláškou za tu dobu: ${trychtyrOdMinule.navstev}`
    + (v.na > 0 ? `\n  na výběru role ${v.na}` : '')
    + (v.mereno > 0 ? `, z ${v.mereno} změřených si roli vybralo ${v.zvolilo}` : '')
    + (kliknuteKarty.length
      ? `\n  karty: ${kliknuteKarty.map((k) => `${k.nazev} ${k.pocet}`).join(', ')}`
      : '')
    + `

Plný report chodí v 8:00 a ve 20:00.
`;
}

function telo(d) {
  return d.hlavni ? teloPlne(d) : teloKratke(d);
}

/* ==================== odeslání ==================== */

/**
 * Pošle status. Vrací `{ ok, duvod }` — nikdy nevyhodí výjimku ven, protože
 * se volá z budíku a spadlý status nesmí shodit proces.
 */
async function posliStatusNaboru({ vynutit = false } = {}) {
  try {
    const nastaveni = await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });

    if (!vynutit && !jeCasPoslat(nastaveni.statusNaboruPoslanoAt)) {
      return { ok: false, duvod: 'mimo-slot' };
    }

    /* Cíl platí jen pro den, na který byl stanoven. Po půlnoci se
       nedotažený včerejší cíl zahodí, místo aby tiše platil dál. */
    const dnesKlic = prazskyKlicDne();
    const cilNaDnes = nastaveni.statusNaboruCilDen === dnesKlic
      ? nastaveni.statusNaboruCil
      : null;

    const data = await sesbirej(nastaveni.statusNaboruPoslanoAt, cilNaDnes);

    const vysledek = await sendMail({
      to: prijemce(),
      subject: `FSL status — ${prazskeDatum(data.ted)} ${prazskyCas(data.ted)}`
        + (data.hlavni ? '' : ' (změna)'),
      text: telo(data),
    });

    /* Zapisuje se i po neúspěšném odeslání: kdyby Resend vracel chybu,
       tenhle slot se nebude zkoušet dokola každých pět minut. Že se
       neodeslalo, je vidět v logu a v Resendu. */
    const zapis = { statusNaboruPoslanoAt: new Date() };

    /* Cíl na zítřek se stanoví ve večerním plném reportu — tam už je den
       skoro celý a sedmidenní průměr se do rána nezmění. Ranní report ho
       jen připomíná. */
    if (data.hlavni && prazskeCasti(data.ted).hodina === 20) {
      const zitra = new Date(zacatekDne(data.ted).getTime() + 36 * 60 * 60 * 1000);
      zapis.statusNaboruCil = data.cil.zitra;
      zapis.statusNaboruCilDen = prazskyKlicDne(zitra);
    }

    await prisma.settings.update({ where: { id: 'singleton' }, data: zapis });

    if (!vysledek.ok) {
      console.error('[Status] Odeslání selhalo:', vysledek.reason);
      return { ok: false, duvod: vysledek.reason };
    }
    console.log(`[Status] Odesláno na ${prijemce()} (${data.hlavni ? 'plný' : 'krátký'})`);
    return { ok: true };
  } catch (err) {
    console.error('[Status] Chyba:', err?.message ?? err);
    return { ok: false, duvod: err?.message ?? 'chyba' };
  }
}

module.exports = {
  posliStatusNaboru,
  prijemce,
  sesbirej,
  telo,
  teloPlne,
  teloKratke,
  diagnoza,
  jeCasPoslat,
  jeHlavni,
  zacatekDne,
  zacatekVcerejska,
  posunPasma,
  prazskyCas,
  prazskeDatum,
  prazskyKlicDne,
  ZACATEK,
  UZAVERKA,
  CIL_DENNE,
  SLOTY,
  HLAVNI_SLOTY,
};
