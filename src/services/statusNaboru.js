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
 * ── Celkový cíl ─────────────────────────────────────────────────────────
 * Od 21. 9. 2026 má nábor **jeden celkový cíl k uzávěrce** místo dosavadní
 * abstrakce „5 registrací denně": 250 hráčů do pole, 25 brankářů, 6 týmů
 * a 10 rozhodčích. Majitel chce jako první věc v e-mailu vidět **jak
 * daleko jsme**, ne tempo — proto je postup k cíli nahoře a zbytek pod
 * čarou. Viz `CIL` níž.
 *
 * **Brankáři se počítají mimo těch 250**, ne z nich: gólman je úzké hrdlo
 * celé ligy (bez dvou na tým se zápas nehraje), takže se sleduje zvlášť,
 * aby se neschoval v hromadě hráčů do pole.
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
const { jeBrankar } = require('../utils/posty');

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

/**
 * Celkový cíl náboru k uzávěrce. Nastavil majitel 21. 9. 2026.
 *
 * **`hraci` jsou hráči do pole, brankáři jsou navíc** — dohromady tedy 275
 * hráčů. Kdyby se to mělo číst obráceně (25 gólmanů uvnitř 250), stačí
 * změnit tyhle dvě čísla; zbytek souboru počítá z nich.
 *
 * `tymy` se do „celkem lidí" nesčítají — je to jiná jednotka.
 */
const CIL = {
  hraci: 250,
  brankari: 25,
  tymy: 6,
  rozhodci: 10,
};

/** Kolik lidí je celkem potřeba zaregistrovat. Týmy sem schválně nepatří. */
const CIL_LIDI = CIL.hraci + CIL.brankari + CIL.rozhodci;

/**
 * Mezicíle — **plán schválně není rovná čára.**
 *
 * Majitel čeká, že se největší počet lidí sežene na konci, a u amatérských
 * lig je to rozumná domněnka: uzávěrka je spouštěč a lidé se hlásí na
 * poslední chvíli. Rovnoměrné dělení cíle by proto hlásilo poplach už
 * v září, kdy žádný není.
 *
 * **Domněnka se tím ale nestává nenapadnutelnou — právě naopak.** Plán
 * s ní počítá dopředu a tím ji dělá testovatelnou: v každém okamžiku je
 * vidět, jestli jsme nad nejbližším kontrolním bodem, nebo pod ním. Zjistit
 * 1. 11., že vlna neměla co násobit, je pozdě.
 *
 * Křivka je zadní: do 5. 10. teprve pětina, do 20. 10. polovina, zbylá
 * třetina v posledních pěti dnech.
 */
const MEZICILE = [
  { datum: '2026-10-05', podil: 0.20 },
  { datum: '2026-10-20', podil: 0.50 },
  { datum: '2026-10-27', podil: 0.65 },
  { datum: '2026-11-01', podil: 1.00 },
];

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
 * Poslední okamžik pražského dne zadaného jako `2026-10-05`.
 *
 * Poledne UTC padne do správného pražského dne v letním i zimním čase, a na
 * začátek dalšího dne se skáče přes 36 h — stejný trik jako u `zacatekVcerejska`,
 * ze stejného důvodu: přičíst 24 h by 25. 10. skončilo o hodinu vedle.
 */
function konecPrazskehoDne(isoDatum) {
  const [r, m, d] = isoDatum.split('-').map(Number);
  const zacatek = zacatekDne(new Date(Date.UTC(r, m - 1, d, 12, 0, 0)));
  const dalsi = zacatekDne(new Date(zacatek.getTime() + 36 * 60 * 60 * 1000));
  return new Date(dalsi.getTime() - 1000);
}

/** `2026-10-05` → `5. 10.` */
function kratkeDatum(isoDatum) {
  const [, m, d] = isoDatum.split('-').map(Number);
  return `${d}. ${m}.`;
}

/**
 * Nejbližší mezicíl, kterého se ještě dá dosáhnout, a jak na něm stojíme.
 * Po posledním kontrolním bodu vrací `null` — nábor tou dobou skončil.
 */
function nejblizsiMezicil(ted, lidiHotovo) {
  for (const m of MEZICILE) {
    const konec = konecPrazskehoDne(m.datum);
    if (konec <= ted) continue;
    const cil = Math.round(m.podil * CIL_LIDI);
    const dnu = Math.max(1, Math.ceil((konec - ted) / DEN_MS));
    const chybi = Math.max(0, cil - lidiHotovo);
    return {
      datum: m.datum, podil: m.podil, cil, dnu, chybi,
      rozdil: lidiHotovo - cil, denne: chybi / dnu,
    };
  }
  return null;
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
    tymu, hracu, hracuVDraftu, rozhodcich, hracuSLicenci, posty,
    za24h, dnes, vcera, za7dni, odZacatkuR, odPosledne,
    trychtyr, trychtyrOdMinule,
  ] = await Promise.all([
    prisma.team.count(),
    prisma.player.count(),
    prisma.player.count({ where: { teamId: null } }),
    prisma.referee.count(),
    prisma.player.count({ where: { licensed: true } }),

    /* Brankáře nejde spočítat dotazem: `Player.position` je volný text, ve
       kterém se potkávají kódy (`GK`) i česká slova (`Brankář`) — viz
       `utils/posty.js`. Proto se vytáhnou jen posty a přepočítají v paměti.
       Při řádech stovek hráčů je to jeden malý dotaz, ne problém. */
    prisma.player.findMany({ select: { position: true } }),

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

  /* Postup k cíli se měří **proti celé databázi**, ne proti tomu, co přibylo
     od začátku propagace. Otázka „jak daleko jsme" se ptá na to, kolik lidí
     liga má — ne kolik jich přivedla reklama. */
  const brankaru = posty.filter((p) => jeBrankar(p.position)).length;
  const hracuDoPole = Math.max(0, hracu - brankaru);
  const lidiHotovo = hracu + rozhodcich;
  const chybi = Math.max(0, CIL_LIDI - lidiHotovo);
  const potrebaDenne = dnuZbyva > 0 ? chybi / dnuZbyva : null;

  /* Místo odhadu „kam to dojde při dosavadním tempu" se hlásí **nejbližší
     mezicíl**. Rovná čára by u zadní křivky lhala oběma směry: v září by
     strašila a v půlce října uklidňovala. Kontrolní bod se ptá na jedinou
     věc, která se dá dnes zodpovědět — jsme nad plánem, nebo pod ním. */
  const mezicil = nejblizsiMezicil(ted, lidiHotovo);

  /* Cíl na zítřek: sedmidenní průměr + 20 %, nahoru, nejmíň 1. Nula by
     znamenala „stačí nic", což není cíl. */
  const cilZitra = Math.max(1, Math.ceil(prumer7 * (1 + PRIRAZKA)));

  return {
    ted,
    hlavni: jeHlavni(ted),
    odMinule,
    hodinOdMinule,
    databaze: { tymu, hracu, hracuDoPole, brankaru, hracuVDraftu, rozhodcich, hracuSLicenci },
    za24h, dnes, vcera, odPosledne,
    cil: { dnes: cilNaDnes, zitra: cilZitra, prumer7, dnuVOkne },
    postup: {
      polozky: [
        { nazev: 'hráči do pole', hotovo: hracuDoPole, cil: CIL.hraci },
        { nazev: 'brankáři', hotovo: brankaru, cil: CIL.brankari },
        { nazev: 'týmy', hotovo: tymu, cil: CIL.tymy },
        { nazev: 'rozhodčí', hotovo: rozhodcich, cil: CIL.rozhodci },
      ],
      lidiHotovo, lidiCil: CIL_LIDI, chybi, potrebaDenne, mezicil,
      podil: (lidiHotovo / CIL_LIDI) * 100,
    },
    tempo: {
      odZacatku: odZacatkuR.celkem, dnuBehem, dnuZbyva, dnuCelkem,
      prumer: prumerCelkem, chybi, potrebaDenne,
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
 * Pruh postupu. **Plní se po pěti procentech** (20 dílků) — jemnější dělení
 * by u jednociferných procent stejně nebylo poznat a v proporcionálním
 * písmu poštovního klienta by se rozjelo.
 */
function pruh(hotovo, cil, sirka = 20) {
  const dilku = cil > 0 ? Math.round(Math.min(1, hotovo / cil) * sirka) : 0;
  /* Jeden dílek i při rozdělaném prvním procentu: nula dílků vedle „1 %"
     vypadá jako chyba. Prázdno zůstane prázdné jen při skutečné nule. */
  const plnych = hotovo > 0 ? Math.max(1, dilku) : 0;
  return '#'.repeat(plnych) + '.'.repeat(sirka - plnych);
}

/**
 * Blok „jak daleko jsme" — první věc v e-mailu. Sloupce se zarovnávají
 * podle nejdelší položky, ať jdou čísla číst pod sebou.
 */
function blokPostupu(p, dnuZbyva) {
  const sirkaNazvu = Math.max(...p.polozky.map((x) => x.nazev.length));
  const sirkaHotovo = Math.max(...p.polozky.map((x) => String(x.hotovo).length));
  const sirkaCile = Math.max(...p.polozky.map((x) => String(x.cil).length));

  const radky = p.polozky.map((x) => {
    const procent = x.cil > 0 ? Math.round((x.hotovo / x.cil) * 100) : 0;
    return `  ${x.nazev.padEnd(sirkaNazvu)}  ${String(x.hotovo).padStart(sirkaHotovo)}`
      + ` / ${String(x.cil).padStart(sirkaCile)}  ${String(procent).padStart(3)} %`
      + `  ${pruh(x.hotovo, x.cil)}`;
  });

  const tempoVeta = p.potrebaDenne === null
    ? '  po uzávěrce'
    : `  chybí ${p.chybi} lidí = ${cislo1(p.potrebaDenne)}/den po zbytek náboru`;

  return `POSTUP K CÍLI (do 1. 11. 2026, zbývá ${dnuZbyva} dní)
${radky.join('\n')}
  ${'celkem lidí'.padEnd(sirkaNazvu)}  ${String(p.lidiHotovo).padStart(sirkaHotovo)}`
    + ` / ${String(p.lidiCil).padStart(sirkaCile)}  ${String(Math.round(p.podil)).padStart(3)} %
${tempoVeta}
${vetaMezicile(p.mezicil)}`;
}

/**
 * Jak stojíme proti nejbližšímu kontrolnímu bodu. **Dva tvary schválně:**
 * když jsme nad plánem, zajímá nás o kolik; když pod, zajímá nás, jaké tempo
 * to znamená — to je číslo, se kterým se dá něco udělat.
 */
function vetaMezicile(m) {
  if (!m) return '  poslední mezicíl je za námi';
  const hlavicka = `  mezicíl ${kratkeDatum(m.datum)}: ${m.cil} lidí `
    + `(${Math.round(m.podil * 100)} % cíle), zbývá ${m.dnu} dní`;
  if (m.chybi === 0) return `${hlavicka}\n    splněno, ${seZnamenkem(m.rozdil)} proti plánu`;

  /* Dovětek o vlně dává smysl jen u průběžných bodů. U posledního (to je
     sama uzávěrka) by tvrdil, že se čeká na něco, co už nepřijde. */
  const dovetek = m.podil < 1
    ? '; plán počítá s tím, že většina lidí přijde až před uzávěrkou'
    : ' — tohle je uzávěrka, dál se čekat nedá';
  return `${hlavicka}\n    chybí ${m.chybi} = ${cislo1(m.denne)}/den${dovetek}`;
}

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

${blokPostupu(d.postup, tempo.dnuZbyva)}

───────────────────────── detail ─────────────────────────

REGISTRACE V DATABÁZI
  hráči ${db.hracu} (z toho ${db.brankaru} brankářů, ${db.hracuVDraftu} v draftu)
  zaplacených licencí: ${db.hracuSLicenci}

DNEŠEK PROTI CÍLI
${plneniDnes}
  cíl na zítřek: ${cil.zitra} (sedmidenní průměr ${cislo1(cil.prumer7)} + 20 %)

POROVNÁNÍ
  dnes zatím:      ${dnes.celkem}  (hráči ${dnes.hracu}, vedoucí ${dnes.tymu}, rozhodčí ${dnes.rozhodcich})
  včera celkem:    ${vcera.celkem}  (hráči ${vcera.hracu}, vedoucí ${vcera.tymu}, rozhodčí ${vcera.rozhodcich})
  posledních 24 h: ${za24h.celkem}
  průměr 7 dní:    ${cislo1(cil.prumer7)}/den

TEMPO OD ZAČÁTKU PROPAGACE
  od 15. 9. celkem ${tempo.odZacatku} registrací za ${tempo.dnuBehem} dní
  průměr ${cislo1(tempo.prumer)}/den, potřeba ${cislo1(tempo.potrebaDenne)}/den

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
  const { odPosledne, dnes, cil, postup, tempo, trychtyrOdMinule } = d;
  const v = volbaRole(trychtyrOdMinule);
  /* V krátkém reportu jen karty, na které se za tu dobu kliklo. Čtyři nuly
     každé dvě hodiny by byly jen šum — od toho je plný report. */
  const kliknuteKarty = (trychtyrOdMinule.karty ?? []).filter((k) => k.pocet > 0);

  const plneni = cil.dnes
    ? `${dnes.celkem} z ${cil.dnes}, zbývá ${Math.max(0, cil.dnes - dnes.celkem)}`
    : `${dnes.celkem} (cíl na dnešek nestanoven)`;

  /* I krátký report začíná postupem — jedním řádkem. Majitel se ptá na
     „jak daleko jsme" a odpověď nemá čekat na osmou hodinu. */
  return `Status náboru, ${prazskeDatum(d.ted)} ${prazskyCas(d.ted)} — změna za ${d.hodinOdMinule} h.

  cíl: ${postup.lidiHotovo} z ${postup.lidiCil} lidí (${Math.round(postup.podil)} %), `
    + `týmy ${d.databaze.tymu} z ${CIL.tymy}, zbývá ${tempo.dnuZbyva} dní`
    + (postup.mezicil
      ? `\n  mezicíl ${kratkeDatum(postup.mezicil.datum)}: ${postup.mezicil.cil}`
        + (postup.mezicil.chybi === 0
          ? ` (splněno, ${seZnamenkem(postup.mezicil.rozdil)})`
          : ` (chybí ${postup.mezicil.chybi})`)
      : '')
    + `
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
  blokPostupu,
  vetaMezicile,
  nejblizsiMezicil,
  konecPrazskehoDne,
  pruh,
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
  CIL,
  CIL_LIDI,
  MEZICILE,
  SLOTY,
  HLAVNI_SLOTY,
};
