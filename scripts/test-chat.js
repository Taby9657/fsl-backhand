/**
 * Testy chatu bez databáze.
 *
 * Pokrývá to, co jde ověřit bez Prisma klienta: **počítání termínu
 * v pražském čase** (na tom se dá naletět přes přechod na zimní čas)
 * a **odvození avatara z hráče**. Matice `muzePsat()`, umlčení a příznak
 * „čeká na ligu" potřebují databázi a přijdou s integračními testy.
 *
 * Spouští se `npm run test:chat`.
 */

const chat = require('../src/services/chat');

let ok = 0, chyb = 0;

function je(popis, skutecnost, ocekavani) {
  if (String(skutecnost) === String(ocekavani)) { ok++; console.log(`  OK  ${popis}`); }
  else { chyb++; console.log(`  XX  ${popis}\n      cekal:  ${ocekavani}\n      dostal: ${skutecnost}`); }
}

const PRAHA = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Prague',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const vPraze = d => PRAHA.format(d).replace('T', ' ');

console.log('\nTermin odpovedi - konec nasledujiciho dne v Praze');

je('zprava z utery 23:50 ma termin ve stredu vecer',
   vPraze(chat.konecDalsihoDne(new Date('2026-09-22T21:50:00Z'))), '2026-09-23 23:59:59');

je('rano i vecer tehoz dne davaji stejny termin',
   vPraze(chat.konecDalsihoDne(new Date('2026-09-22T05:00:00Z'))), '2026-09-23 23:59:59');

je('termin sedi i pres prechod na zimni cas',
   vPraze(chat.konecDalsihoDne(new Date('2026-10-24T20:00:00Z'))), '2026-10-25 23:59:59');

je('posledni den v mesici pretece do dalsiho',
   vPraze(chat.konecDalsihoDne(new Date('2026-09-30T10:00:00Z'))), '2026-10-01 23:59:59');

console.log('\nOffset Prahy');
je('v zari je Praha dve hodiny pred UTC', chat.offsetPrahy(new Date('2026-09-22T12:00:00Z')), 120);
je('v prosinci jednu',                    chat.offsetPrahy(new Date('2026-12-22T12:00:00Z')), 60);

console.log('\nAvatar autora');
const hrac = { id: 'a1b2c3', firstName: 'Petr', lastName: 'Novak', photoUrl: null };
const a = chat.autorProKlienta(hrac);
je('bez fotky ma inicialy', a.iniciely, 'PN');
je('barva je z palety', chat.BARVY.some(b => b.pozadi === a.barva), true);
je('barva je pokazde stejna', chat.autorProKlienta(hrac).barva, a.barva);
je('jmeno se slozi', a.jmeno, 'Petr Novak');
je('neni to Panda', a.panda, false);
je('s fotkou se vraci fotka', chat.autorProKlienta({ ...hrac, photoUrl: 'https://x/y.jpg' }).photoUrl, 'https://x/y.jpg');

const panda = chat.autorProKlienta(null);
je('autor null je Panda', panda.panda, true);
je('Panda nema fotku z profilu', panda.photoUrl, 'null');


console.log('\nUzaverka sestavy');
je('zavira se 48 h pred vykopem',
   chat.uzaverka(new Date('2026-11-12T18:00:00Z')).toISOString(), '2026-11-10T18:00:00.000Z');
je('minimum je 8 + 1', chat.MIN_HRACU, 9);
je('bez brankare se nezacne', chat.MIN_BRANKARU, 1);
je('uzaverka bere i retezec', chat.uzaverka('2026-11-12T18:00:00Z').getTime(),
   new Date('2026-11-10T18:00:00Z').getTime());


console.log('\nSablony Pandy');
const { SABLONY, kdy } = require('../src/services/panda-texty');
const zapas = { date: new Date('2026-11-12T17:00:00Z') };   // 18:00 v Praze

je('cas se pise prazsky', kdy(zapas.date).includes('18:00'), true);
je('otevreni zve do Meho tymu',
   SABLONY.OTEVRENO({ zapas, hala: 'Sokolovna' }).includes('Sokolovna'), true);
je('chybejici brankar nese stav',
   SABLONY.CHYBI_BRANKAR({ stav: '7/9' }).includes('7/9'), true);
je('uzaverka kdyz se sejde',
   SABLONY.UZAVERKA({ stav: '10/9', sejdeSe: true, brankari: 2 }).includes('Sejdeme se'), true);
je('uzaverka kdyz je malo lidi',
   SABLONY.UZAVERKA({ stav: '6/9', sejdeSe: false, brankari: 0 }).includes('bez brankáře'), true);
je('den D pise dnes', SABLONY.DEN_D({ zapas, hala: null, stav: '9/9' }).startsWith('Dnes'), true);


console.log('\nLos zapisovatele');
const zapisovatel = require('../src/services/zapisovatel');

const sestava = [
  { playerId: 'g1', isGoalkeeper: true },
  { playerId: 'p1', isGoalkeeper: false },
  { playerId: 'p2', isGoalkeeper: false },
  { playerId: 'p3', isGoalkeeper: false },
];
const prihlaseni = [
  { playerId: 'g1', brankar: true },
  { playerId: 'p1', brankar: false },
  { playerId: 'p2', brankar: false },
  { playerId: 'p9', brankar: false },
];

je('sestava ma prednost pred prihlaskami',
   zapisovatel.kandidati({ sestava, prihlaseni }).join(','), 'p1,p2,p3');
je('brankar v brane se nelosuje',
   zapisovatel.kandidati({ sestava, prihlaseni }).includes('g1'), false);
je('bez sestavy se bere z prihlasenych',
   zapisovatel.kandidati({ sestava: [], prihlaseni }).join(','), 'p1,p2,p9');
je('nikdy z cele soupisky - kdo se neprihlasil, neni kandidat',
   zapisovatel.kandidati({ sestava: [], prihlaseni }).includes('p3'), false);
je('vyrazeny vedoucim je venku',
   zapisovatel.kandidati({ sestava, prihlaseni, vyrazeni: ['p2'] }).join(','), 'p1,p3');
je('kdo uz vylosovany byl, podruhe nejde',
   zapisovatel.kandidati({ sestava, prihlaseni, drive: ['p1'] }).join(','), 'p2,p3');
je('kdyz nezbyde nikdo, vrati se prazdno',
   zapisovatel.kandidati({ sestava, prihlaseni, drive: ['p1', 'p2', 'p3'] }).length, 0);
je('prazdny zapas nikoho nevylosuje', zapisovatel.vyber([]), 'null');
je('vyber sahne do seznamu', zapisovatel.vyber(['p1', 'p2'], () => 1), 'p2');

const prvni = zapisovatel.textKarty({ jmeno: 'Petr Novák', drawNo: 1, pocetKandidatu: 9 });
je('prvni los necisluje', prvni.startsWith('Los zapisovatele:'), true);
je('prvni los rekne, z kolika se losovalo', prvni.includes('z 9 hráčů'), true);

const druhy = zapisovatel.textKarty({
  jmeno: 'Martin Kříž', drawNo: 2, pocetKandidatu: 8,
  predchozi: 'Petr Novák', duvod: 'nedorazil',
});
je('druhy los nese poradi', druhy.includes('č. 2'), true);
je('druhy los ukaze, kdo vysel predtim', druhy.includes('Petr Novák'), true);
je('a taky proc se losovalo znovu', druhy.includes('nedorazil'), true);
je('jeden kandidat se sklonuje',
   zapisovatel.textKarty({ jmeno: 'A B', drawNo: 1, pocetKandidatu: 1 }).includes('z 1 hráče'), true);


console.log('\nPanda - prvni linka');
const linka = require('../src/services/panda-linka');

const akce = (text, opts) => linka.rozhodni({ text, ...(opts ?? {}) }).akce;
const kat  = (text, opts) => linka.rozhodni({ text, ...(opts ?? {}) }).kategorie;

// --- na co Panda odpovida sama ---
je('kde se hraje', kat('kde se bude hrat'), 'kde-se-hraje');
je('kdy zacina sezona', kat('kdy zacina sezona'), 'terminy');
je('cena licence', kat('kolik stoji licence'), 'cena-licence');
je('cena zapasu je balicek, ne licence', kat('kolik stoji zapas'), 'balicky');
je('jak zaplatit', kat('jak muzu zaplatit'), 'jak-platit');
je('nemam tym', kat('nemam tym co s tim'), 'nemam-tym');
je('uzaverka sestavy', kat('kdy se zavira sestava'), 'prihlaseni-na-zapas');
je('starty nepropadaji', kat('propadaji mi starty'), 'starty-propadaji');
je('odhlaseni ze zapasu', kat('jak se odhlasim ze zapasu'), 'odhlaseni-ze-zapasu');
je('hostovani', kat('muzu hrat za dva tymy'), 'superlicence');
je('zapisovatel', kat('kdo bude zapisovat zapas'), 'zapisovatel');
je('pozdrav nejde do fronty', akce('ahoj'), 'ODPOVED');
je('pozdrav ma svou kategorii', kat('dobry den'), 'pozdrav');

// --- co jde vzdycky na cloveka ---
je('moje platba je pro supervisora',
   kat('zaplatil jsem balicek a porad mi to pise nezaplaceno'), 'penize');
je('tvrdy seznam prebije znalost',
   kat('kolik stoji licence? uz jsem ji zaplatil a nesedi to'), 'penize');
je('zraneni', kat('co kdyz se zranim'), 'zraneni');
je('stiznost na hrace neni zraneni', kat('spoluhrac me urazel v chatu'), 'jiny-hrac');
je('spor', kat('mame spor s rozhodcim'), 'spor');
je('trest', kat('hrozi nam kontumace'), 'trest');
je('osobni udaje', kat('chci zrusit ucet'), 'osobni-udaje');
je('novinar', kat('jsem novinar a chci rozhovor'), 'media');
je('kdo chce cloveka, dostane cloveka', kat('predej to lize'), 'chce-cloveka');
je('obrazek bez textu Panda necte', kat('', { maPrilohu: true }), 'priloha');
je('vagni dotaz jde dal', akce('dotaz na platby'), 'ESKALACE');
je('nesmysl jde dal', kat('xyzzy'), 'nezatrideno');

// --- sportovni hala neni spor ---
je('sport neni spor', kat('sportovni hala kde'), 'kde-se-hraje');

// --- odpoved vzdycky nese zdroj a cestu k cloveku ---
const odp = linka.rozhodni({ text: 'kolik stoji licence' });
je('odpoved nese zdroj', linka.textOdpovedi(odp).includes('Ceník'), true);
je('odpoved nabizi cloveka', linka.textOdpovedi(odp).includes('předej to lize'), true);
je('odpoved nese cislo z ceniku', odp.odpoved.includes('300 Kč'), true);

// --- termin se rika dnem, ne datem ---
je('ve stredu, ne stredu', linka.vDen(new Date('2026-09-23T12:00:00Z')), 've středu 23. 9.');
je('v pondeli', linka.vDen(new Date('2026-09-21T12:00:00Z')), 'v pondělí 21. 9.');
je('ve ctvrtek', linka.vDen(new Date('2026-09-24T12:00:00Z')), 've čtvrtek 24. 9.');
je('v sobotu', linka.vDen(new Date('2026-09-26T12:00:00Z')), 'v sobotu 26. 9.');
je('slib nese den', linka.textEskalace(new Date('2026-09-23T12:00:00Z')).includes('ve středu'), true);

console.log(`\n${ok} v poradku, ${chyb} spatne\n`);
process.exit(chyb === 0 ? 0 : 1);
