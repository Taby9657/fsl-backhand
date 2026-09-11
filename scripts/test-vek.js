#!/usr/bin/env node
/**
 * Věková hranice 18 let — `src/utils/vek.js`.
 *
 * Běží bez databáze i bez serveru, je to čistá funkce. Hlídá hlavně hranu:
 * v den osmnáctých narozenin se **smí**, o den dřív ne.
 */

const vekSvc = require('../src/utils/vek');

let fail = 0;
const ok = (podminka, popis) => {
  console.log((podminka ? '✓ ' : '✗ ') + popis);
  if (!podminka) fail++;
};

// Pevný „dnešek", ať test neselže jednou za čtyři roky kvůli přestupnému dni.
const DNES = new Date(Date.UTC(2026, 8, 11)); // 11. 9. 2026

// ── věk ──
ok(vekSvc.vek('2008-09-11', DNES) === 18, 'v den 18. narozenin je člověku 18');
ok(vekSvc.vek('2008-09-12', DNES) === 17, 'den před 18. narozeninami je mu 17');
ok(vekSvc.vek('1990-01-01', DNES) === 36, 'běžný ročník se spočítá správně');

// ── datum narození ──
const kod = (h) => vekSvc.zkontrolujDatumNarozeni(h, DNES).kod;
ok(vekSvc.zkontrolujDatumNarozeni('2008-09-11', DNES).ok, 'osmnáctiny dnes → projde');
ok(kod('2008-09-12') === 'UNDERAGE', 'o den mladší → neprojde');
ok(kod('') === 'BIRTHDATE_INVALID', 'prázdné datum neprojde');
ok(kod(null) === 'BIRTHDATE_INVALID', 'chybějící datum neprojde');
ok(kod('2007-02-31') === 'BIRTHDATE_INVALID', '31. února neprojde (JS ho jinak tiše posune)');
ok(kod('2030-01-01') === 'BIRTHDATE_INVALID', 'datum v budoucnosti neprojde');
ok(kod('1919-05-05') === 'BIRTHDATE_INVALID', 'ročník před 1920 je skoro jistě překlep');
ok(vekSvc.zkontrolujDatumNarozeni('1995-06-15T00:00:00.000Z', DNES).ok, 'bere i celé ISO z toISOString()');

console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
process.exit(fail === 0 ? 0 : 1);
