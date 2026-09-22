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

console.log(`\n${ok} v poradku, ${chyb} spatne\n`);
process.exit(chyb === 0 ? 0 : 1);
