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

// ── rodné číslo ──
const den = (rc) => {
  const d = vekSvc.datumZRodnehoCisla(rc);
  return d ? d.toISOString().slice(0, 10) : null;
};
ok(den('950615/1234') === '1995-06-15', 'muž, s lomítkem');
ok(den('9506151234') === '1995-06-15', 'muž, bez lomítka');
ok(den('955615/1234') === '1995-06-15', 'žena má k měsíci +50');
ok(den('0432311234') === '2004-12-31', 'přetečená řada od 2004 má +20');
ok(den('0482311234') === '2004-12-31', 'žena v přetečené řadě má +70');
ok(den('530615123')  === '1953-06-15', 'devítimístné RČ je vždy 19xx');
ok(den('0406151234') === '2004-06-15', 'desetimístné 00–53 je 20xx');
ok(den('9902301234') === null, '30. února v RČ neprojde');
ok(den('nesmysl') === null, 'text místo RČ neprojde');

const kodRC = (rc) => vekSvc.zkontrolujRodneCislo(rc, DNES).kod;
ok(kodRC('') === 'BIRTHNO_REQUIRED', 'prázdné rodné číslo je chyba, ne povolený stav');
ok(kodRC('abc') === 'BIRTHNO_INVALID', 'nesmysl se pozná');
ok(kodRC('100615/1234') === 'UNDERAGE', 'nezletilý rozhodčí neprojde');
ok(vekSvc.zkontrolujRodneCislo('080911/1234', DNES).ok, 'rozhodčí v den osmnáctin projde');

console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
process.exit(fail === 0 ? 0 : 1);
