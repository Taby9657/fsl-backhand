/**
 * Co Panda ví — znalosti první linky.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 4 a 8.3.
 *
 * **Každá odpověď má zdroj.** Panda neskládá věty z ničeho: buď na otázku
 * sedí záznam odsud, a pak odejde jeho text, nebo nesedí a dotaz jde na
 * supervisora. Třetí možnost — vymyslet něco pravděpodobného — je ta, která
 * ligu stojí důvěru, a proto tu není.
 *
 * **Čísla se nepíšou dvakrát.** Termíny si bere z `utils/sezona.js`, ceny
 * a pravidla startů jsou opsané z veřejného ceníku
 * (`fsl-web/src/app/cenik/page.tsx`) — kdo mění ceník, mění i tohle.
 * Proto u každého záznamu stojí, odkud je.
 *
 * **Je to hloupé, a schválně.** Žádný model, jen slova a body. Než přijde
 * jazykový model (E2), tohle je celá Pandina pravomoc — a i potom zůstane
 * jako záchranná síť pro chvíle, kdy model není dostupný nebo jeho odpověď
 * neprojde kontrolou.
 */

const sezona = require('../utils/sezona');

/* ─────────────────────────── porovnávání textu ─────────────────────────── */

/** „Kdy začíná sezóna?" → „kdy zacina sezona" — bez diakritiky a interpunkce. */
function normalizuj(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sedí kmen na text? Hledá se od hranice slova s volným koncem — čeština
 * skloňuje („licence", „licenci", „licencí") a kmen to pokryje líp než
 * seznam tvarů.
 *
 * **Svislítko na konci kmene konec uzavře.** U krátkých slov je volný konec
 * past: „spor" by chytilo „sportovní" a „úraz" by chytilo „urážel" — tedy
 * stížnost na chování by skončila jako zranění. Kde to hrozí, píše se
 * `spor|` a kmen musí slovo dokončit.
 */
function obsahuje(text, kmen) {
  const presne = kmen.endsWith('|');
  const holy = (presne ? kmen.slice(0, -1) : kmen).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^| )${holy}${presne ? '(?= |$)' : ''}`).test(text);
}

/* ───────────────────────────── tvrdý seznam ────────────────────────────── */

/**
 * Témata, u kterých se Panda **nikdy** nepokouší odpovídat.
 *
 * Trefa sem znamená eskalaci, i kdyby odpověď v ceníku stála. Jsou to věci,
 * kde chyba stojí peníze nebo vztah: konkrétní platba, spor, zranění,
 * výjimka z pravidel, osobní údaje, jiný člověk, trest, novinář.
 *
 * Pozor na rozdíl: **„kolik stojí licence" je ceník** a Panda ho řekne.
 * **„zaplatil jsem a nepřišlo to" je moje platba** a jde na člověka.
 */
const TVRDY_SEZNAM = [
  { kategorie: 'penize', slova: [
    'zaplatil', 'zaplatila', 'zaplaceno', 'neprisl', 'nedoslo', 'nesedi', 'vratit penize',
    'vraceni', 'refundac', 'reklamac', 'dluh', 'dluzim', 'faktur', 'strhl', 'strhlo',
    'uctoval', 'uctovan', 'omylem', 'dvakrat', 'poslal jsem',
  ] },
  // Stížnost na člověka se řeší dřív než zranění — „urážel" a „úraz" jsou
  // si v bezdiakritickém textu nebezpečně blízko.
  { kategorie: 'jiny-hrac', slova: [
    'nahlas', 'chovan', 'urazel', 'urazky', 'vulgar', 'sikan', 'obtezov',
  ] },
  { kategorie: 'spor', slova: [
    'stiznost', 'stezuj', 'nesouhlas', 'protest', 'odvolan', 'spor|', 'spory|',
    'podvod', 'nefer',
  ] },
  { kategorie: 'trest', slova: [
    'trest', 'pokut', 'kontumac', 'diskvalifik', 'zakaz', 'vylouc',
  ] },
  { kategorie: 'zraneni', slova: [
    'zranen', 'zranim', 'zranil', 'zran|', 'uraz|', 'urazu|', 'urazem|',
    'zlomen', 'natrzen', 'otres', 'pojistk', 'nemocnic', 'doktor',
  ] },
  { kategorie: 'vyjimka', slova: [
    'vyjimk', 'vyjimecne', 'dalo by se', 'mimoradn', 'slo by to',
  ] },
  { kategorie: 'osobni-udaje', slova: [
    'gdpr', 'osobni udaj', 'zrusit ucet', 'smazat ucet', 'vymazat me', 'smazte me',
  ] },
  { kategorie: 'media', slova: [
    'novinar', 'redakce', 'rozhovor', 'reportaz', 'tiskov',
  ] },
  // Kdo si řekne o člověka, dostane člověka. Bez tohohle by se z první linky
  // stala zeď: hráč by se doptával a Panda by mu pořád vracela ceník.
  { kategorie: 'chce-cloveka', slova: [
    'na ligu', 'lize', 'na supervisora', 'supervisor', 'na cloveka', 's clovekem',
    'nepomohlo', 'to neodpovida', 'spatna odpoved', 'nerozumis',
  ] },
];

/** Vrátí kategorii z tvrdého seznamu, nebo null. */
function tvrdaTrefa(text) {
  const t = normalizuj(text);
  for (const radek of TVRDY_SEZNAM) {
    // Kmeny se píšou rovnou bez diakritiky — kdyby se hnaly přes
    // normalizuj(), spolklo by to svislítko na konci.
    const slovo = radek.slova.find(s => obsahuje(t, s));
    if (slovo) return { kategorie: radek.kategorie, ruleHit: slovo };
  }
  return null;
}

/* ──────────────────────────────── znalosti ─────────────────────────────── */

const den = sezona.den;

/**
 * Záznamy.
 *
 * `klicova` jsou slova, která téma určují (2 body), `slova` ho jen podpírají
 * (1 bod). Víceslovné spojení dostává bod navíc — „kolik stojí zápas" je
 * konkrétnější otázka než „kolik stojí".
 */
/* Kmeny se všude píšou **bez diakritiky a malými písmeny** — porovnávají se
   s už znormalizovaným dotazem. */
const ZNALOSTI = [
  {
    klic: 'terminy',
    klicova: ['termin', 'deadline', 'rozlosov', 'prihlask', 'prihlasit se do', 'zacina', 'zacne'],
    slova: ['kdy', 'dokdy', 'los|', 'sezon', 'hrat', 'hraje', 'start'],
    zdroj: 'Termíny sezóny — fslleague.cz',
    odpoved: () =>
      `Přihlášky běží do ${den(sezona.KONEC_PRIHLASEK)}, hned nato je ${den(sezona.LOS)} los `
      + `a první zápasy se hrají od ${den(sezona.START_SEZONY)}.`,
  },
  {
    klic: 'kde-se-hraje',
    klicova: ['hala', 'hale', 'telocvicn', 'adresa', 'rozpis', 've kterem meste'],
    slova: ['kde', 'hrat', 'hraje', 'misto', 'praha'],
    zdroj: 'Termíny sezóny — fslleague.cz',
    odpoved: () =>
      `Hraje se v ${sezona.MESTO}, ${sezona.HRACI_DNY} mezi ${sezona.HRACI_CAS}. Konkrétní haly `
      + `se teprve domlouvají — rozpis s adresami vyjde po losu ${den(sezona.LOS)}. Dřív ti halu `
      + `říct nemůžu, nebyla by to pravda.`,
  },
  {
    klic: 'cena-licence',
    klicova: ['licenc', 'cenik', 'registrace klubu', 'poplat', 'startovn'],
    slova: ['kolik stoji', 'cena', 'stoji', 'korun'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Hráčská licence stojí 300 Kč na sezónu, registrace klubu 3 000 Kč. Superlicence, '
      + 'se kterou jde hrát i za cizí tým, je dalších 300 Kč. Kdo nemá tým, kupuje si '
      + 'Virtuálního vedoucího za 800 Kč — v tom je startovné 500 Kč i licence.',
  },
  {
    klic: 'balicky',
    klicova: ['balic', 'kolik stoji zapas', 'cena zapasu', 'zapas stoji', 'za zapas', 'vstupne'],
    slova: ['start', 'zapas'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Zápasy si platí hráč, ne tým. Jeden start stojí 200 Kč, ve větším balíčku míň — '
      + '3 starty 550 Kč, 7 za 1 200 Kč, 12 za 2 000 Kč, 16 za 2 600 Kč a 20 za 3 000 Kč, '
      + 'tedy 150 Kč za zápas.',
  },
  {
    klic: 'starty-propadaji',
    klicova: ['propad', 'nevycerpan', 'prenes', 'prenasej', 'zbyle start'],
    slova: ['start', 'zustan', 'playoff', 'play off'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Nevyčerpané starty nepropadají. Do play-off se přenášejí vždycky a ze všech balíčků, '
      + 'do další sezóny ve chvíli, kdy si na ni zaplatíš licenci.',
  },
  {
    klic: 'odhlaseni-ze-zapasu',
    klicova: ['odhlas', 'nestiham', 'zrusit ucast', 'vrati se start', 'nemuzu prijit'],
    slova: ['start', 'zapas'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Do 12 hodin před začátkem zápasu se start vrátí celý. Potom se odhlásit dá pořád, '
      + 'jen to ten zápas stojí — a kdo se na něj vrátí, neplatí znovu.',
  },
  {
    klic: 'jak-platit',
    klicova: ['jak zaplat', 'jak plat', 'cim zaplat', 'zaplat', 'kartou', 'qr', 'apple pay', 'google pay', 'prevodem', 'variabilni symbol', 'kosik'],
    slova: ['plat', 'jak'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Kartou, přes Apple Pay a Google Pay, nebo převodem s QR kódem — cena je všude stejná. '
      + 'Položky jdou do košíku a zaplatí se najednou, jedním variabilním symbolem. '
      + 'Stav svých plateb najdeš po přihlášení v sekci Platby.',
  },
  {
    klic: 'nemam-tym',
    klicova: ['nemam tym', 'bez tymu', 'draft', 'virtualn', 'slozi mi tym', 'zaradi me'],
    slova: ['tym', 'sam', 'sama'],
    zdroj: 'Ceník a pravidla soutěže — fslleague.cz',
    odpoved: () =>
      'Tým mít nemusíš. Koupíš si Virtuálního vedoucího za 800 Kč, vyplníš profil v draftu '
      + `a liga ti tým složí — zařazuje se po losu ${den(sezona.LOS)}. Do té doby tě ostatní `
      + 'vedoucí v seznamu volných hráčů nevidí, aby si nikdo nerozebral hráče dřív, než je '
      + 'jasné, kdo v soutěži je.',
  },
  {
    klic: 'prihlaseni-na-zapas',
    klicova: ['uzaverk', 'sestav', 'kdo jede', 'nominac', 'prihlasit na zapas', 'hraju nebo nemuzu'],
    slova: ['zapas', 'hraju', 'muj tym'],
    zdroj: 'Můj tým — pravidla sestavy',
    odpoved: () =>
      'V sekci Můj tým dáš u nejbližšího zápasu Hraju, nebo nemůžu. Sestava se zavírá '
      + '48 hodin před začátkem a pak se nemění. Hraje se, když se sejde devět lidí '
      + 'včetně brankáře.',
  },
  {
    klic: 'brankar',
    klicova: ['brankar', 'golman', 'do brany', 'brana'],
    slova: ['zapas', 'chybi'],
    zdroj: 'Můj tým — pravidla sestavy',
    odpoved: () =>
      'Bez brankáře se zápas nezačne — proto na něj upozorňuju dřív než na počet hráčů. '
      + 'Brankáři drží na soupisce první dvě místa a dva nejsou luxus: tým s jediným gólmanem '
      + 'je při běžné docházce bez brankáře zhruba každý třetí zápas. Do brány jde jeden, '
      + 'druhý normálně hraje v poli.',
  },
  {
    klic: 'zapisovatel',
    klicova: ['zapisovat', 'zapisovatel', 'zapis', 'kdo pise zapas'],
    slova: ['los', 'zapas'],
    zdroj: 'Pravidla soutěže — zapisovatel',
    odpoved: () =>
      'Zapisovatel se losuje z lidí, kteří na zápas jdou — nikdy z celé soupisky. '
      + 'Vedoucí může los vyvolat u zápasu a každý pokus zůstane vidět i s pořadím, '
      + 'aby se z losu nestal výběr.',
  },
  {
    klic: 'superlicence',
    klicova: ['superlicenc', 'hostov', 'za cizi tym', 'za dva tymy', 'za vic tymu'],
    slova: ['licenc', 'tym'],
    zdroj: 'Ceník — fslleague.cz/cenik',
    odpoved: () =>
      'Superlicence stojí 300 Kč a umožňuje nastupovat i za cizí tým — nejvýš za tři '
      + 'soupisky za sezónu.',
  },

  /* ── pravidla soutěže (`fsl-pravidla-souteze.md`) ────────────────────── */

  {
    klic: 'format-hry',
    klicova: ['format', 'kolik hracu na hristi', 'na hristi', 'hraci cas', 'cisty cas', 'hruby cas', 'tretin', 'jak dlouho trva zapas', 'jak dlouho se hraje'],
    slova: ['minut', 'zapas', 'hracu'],
    zdroj: 'Pravidla soutěže — formát hry',
    odpoved: () =>
      'Hraje se 5 + 1, tedy pět hráčů do pole a brankář, na 3 × 15 minut čistého času — '
      + 'hodiny se při každém přerušení zastavují, a to ve všech zápasech od prvního kola '
      + 'po finále. Odehraje se tedy celých 45 minut hry.',
  },
  {
    klic: 'zakladni-cast',
    klicova: ['kolik kol', 'zakladni cast', 'playoff', 'play off', 'postupuj', 'vyrazovac'],
    slova: ['sezon', 'kol|', 'tabulk'],
    zdroj: 'Pravidla soutěže — sezóna',
    odpoved: () =>
      'Základní část má 15 až 20 kol podle počtu přihlášených týmů a hraje se od listopadu '
      + 'do března. Pak je play-off a postupují do něj všechny týmy — základní část rozhoduje '
      + 'jen o nasazení. Předkolo a čtvrtfinále se hrají na dvě vítězná utkání, semifinále '
      + 'a finále na tři.',
  },
  {
    klic: 'soupiska-sestava',
    klicova: ['soupisk', 'kolik lidi', 'kolik hracu', 'strop', 'maximum', 'minimum', 'nejmene'],
    slova: ['tym', 'sestav'],
    zdroj: 'Pravidla soutěže — soupiska a sestava',
    odpoved: () =>
      'Sestava na zápas je 8 + 1 až 18 + 2. Soupiska na sezónu má minimum 9 + 1 a horní strop '
      + 'nemá — platí to i pro otevřené týmy. Nominace je schválně větší než šestice na hřišti, '
      + 'protože se střídá průběžně.',
  },
  {
    klic: 'splatnost',
    klicova: ['splatnost', 'dokdy zaplat', 'dokdy', '48 hodin', 'do kdy zaplat'],
    slova: ['zaplat', 'start', 'zapas'],
    zdroj: 'Pravidla soutěže — splatnost',
    odpoved: () =>
      'Každý poplatek musí být zaplacený nejpozději 48 hodin před začátkem nejbližšího zápasu. '
      + 'Kdo nemá volný start, do sestavy nejde; kdo nemá licenci, nesmí nastoupit vůbec.',
  },
  {
    klic: 'dph',
    klicova: ['dph', 'danovy doklad', 'platce dane', 's dph', 'bez dph'],
    slova: ['cena', 'doklad'],
    zdroj: 'Pravidla soutěže — poplatky',
    odpoved: () =>
      'Liga není plátce DPH, takže ceny jsou konečné a daň se k nim nikde nepřipočítává. '
      + 'Ke každé platbě chodí doklad — u karty od platební brány, u převodu ho vystaví systém '
      + 'při spárování.',
  },
  {
    klic: 'doporuceni',
    klicova: ['doporuc', 'privedu', 'priveden', 'zapas zdarma', 'referral'],
    slova: ['kod', 'kamarad'],
    zdroj: 'Pravidla soutěže — přiveď hráče',
    odpoved: () =>
      'Přivedeš hráče, máš zápas zdarma. Když s tvým kódem přijde nový hráč, zaplatí registraci '
      + 'a koupí si balíček od tří zápasů výš, připíše se ti jeden zápas zdarma — a kolik lidí '
      + 'přivedeš, omezené není. Vlastní kód se ti v účtu odemkne po prvním odehraném zápase.',
  },
  {
    klic: 'pozdni-prichod',
    klicova: ['pozdni prichod', 'dorazim pozdeji', 'prijdu pozdeji', 'rozehran', 'pozde na zapas'],
    slova: ['zapas', 'doplnit'],
    zdroj: 'Pravidla soutěže — pozdní příchod',
    odpoved: () =>
      'Do rozehraného zápasu jde doplnit kmenový hráč s platnou licencí a volným startem. '
      + 'Hostující hráč se po zahájení přidat nedá a doplnění zůstane v zápise vidět jako '
      + 'štítek „doplněn".',
  },
  {
    klic: 'zaskok',
    klicova: ['zaskok', 'zaskoc', 'vypomoc', 'pujcit hrace'],
    slova: ['otevren', 'tym'],
    zdroj: 'Pravidla soutěže — záskok',
    odpoved: () =>
      'Záskok se spustí, jen když otevřený tým 48 hodin před zápasem nemá 8 + 1. Jde jen '
      + 'z jiného otevřeného týmu, superlicenci nepotřebuje a je nejvýš třikrát za sezónu '
      + 'na hráče. Do nároku na play-off se nepočítá — je to výpomoc, ne členství.',
  },
  {
    klic: 'dvojice',
    klicova: ['dvojice', 've dvou', 'stejny kod', 'spolu do tymu', 's kamaradem do stejneho'],
    slova: ['kod', 'tym'],
    zdroj: 'Pravidla soutěže — otevřené týmy',
    odpoved: () =>
      'Dvojice se drží pohromadě: obě přihlášky se stejným kódem zařadíme do stejného týmu. '
      + 'Trojice a víc už ne — to je zárodek týmu a patří do běžné registrace.',
  },
  {
    klic: 'playoff-volba',
    klicova: ['za koho', 'primarni tym', 'sekundarni tym', 'volba tymu'],
    slova: ['playoff', 'play off', 'tym'],
    zdroj: 'Pravidla soutěže — play-off',
    odpoved: () =>
      'Po základní části si zvolíš primární tým a volitelně sekundární — vybírat můžeš jen '
      + 'z týmů, za které jsi odehrál aspoň tři zápasy. Za sekundární tým smíš nastoupit, '
      + 'teprve až primárnímu play-off skončí. Volba se zamyká, jakmile play-off začne.',
  },
];

/**
 * Samotný pozdrav bez otázky.
 *
 * „Ahoj" není dotaz pro supervisora a nemá smysl ho posílat do fronty —
 * ale mlčet na pozdrav je horší než cokoliv jiného. Panda pozdraví zpátky
 * a zeptá se, o co jde.
 */
const POZDRAVY = ['ahoj', 'cau', 'cus', 'nazdar', 'zdravim', 'dobry den', 'dobry vecer', 'hello', 'hi', 'zdar'];

function jenPozdrav(text) {
  const t = normalizuj(text);
  if (!t || t.split(' ').length > 3) return false;
  return POZDRAVY.some(p => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
}

/** Body jednoho záznamu proti dotazu. */
function skore(zaznam, t) {
  let body = 0;
  for (const kmen of zaznam.klicova ?? []) {
    if (obsahuje(t, kmen)) body += kmen.includes(' ') ? 3 : 2;
  }
  for (const kmen of zaznam.slova ?? []) {
    if (obsahuje(t, kmen)) body += kmen.includes(' ') ? 2 : 1;
  }
  return body;
}

/**
 * Najde odpověď. Vrací `null`, když si Panda není jistá — a to je správná
 * odpověď častěji, než se zdá.
 *
 * Práh jsou **dva body** (jedno určující slovo, nebo dvě podpůrná)
 * a **žádná remíza**: když stejně dobře sedí dvě témata, neví se, na co se
 * ptá, a otázka patří člověku.
 */
function najdi(text) {
  const t = normalizuj(text);
  if (t.length < 3) return null;

  const poradi = ZNALOSTI
    .map(z => ({ z, body: skore(z, t) }))
    .sort((a, b) => b.body - a.body);

  const nej = poradi[0];
  if (!nej || nej.body < 2) return null;
  if (poradi[1] && poradi[1].body === nej.body) return null;

  return { klic: nej.z.klic, odpoved: nej.z.odpoved(), zdroj: nej.z.zdroj, body: nej.body };
}

module.exports = { normalizuj, obsahuje, tvrdaTrefa, najdi, skore, jenPozdrav, ZNALOSTI, TVRDY_SEZNAM };
