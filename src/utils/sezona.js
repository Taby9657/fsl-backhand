/**
 * Termíny sezóny, které potřebuje backend.
 *
 * ⚠️ **Druhá kopie těchhle dat je ve `fsl-web/src/lib/sezona.ts`.** Je to
 * duplicita a ví se o ní: web je staticky prerenderovaný a datum si z API
 * netahá, backend zase nemá jak číst soubor z jiného repozitáře. **Kdo mění
 * termín, mění ho na obou místech** — jinak bude web psát jedno a e-maily
 * druhé.
 *
 * Proč to backend vůbec potřebuje: do otevření draft poolu **nevidí volné
 * hráče nikdo, ani vedoucí**. E-mail, který hráči tvrdí „tvoje karta je vidět
 * a vedoucí ti můžou poslat nabídku", je do té doby nepravda — a hráč z toho
 * čte, že o něj nikdo nestojí, místo aby věděl, že se zatím nic dít nemá.
 */

/** Poslední okamžik, kdy jde odeslat přihlášku. */
const KONEC_PRIHLASEK = new Date('2026-11-01T23:59:59+01:00');

/**
 * Kdy se vedoucím otevře seznam volných hráčů.
 *
 * Do té doby se hráči **normálně přihlašují** a v poolu jsou — jen je nikdo
 * zvenčí nevidí. Důvod je sportovní: přihlášky končí 1. 11. a hned nato je
 * los, takže si vedoucí nemají rozebrat hráče dřív, než je jasné, kdo do
 * soutěže nastoupí.
 */
const OTEVRENI_DRAFTU = new Date('2026-11-01T00:00:00+01:00');

/**
 * Start sezóny — do té doby je seznam účastníků neveřejný.
 *
 * Web od 18. 9. 2026 stránku `/tymy` schovává, jenže to je zámek v UI:
 * endpoint `/teams` vracel seznam i s divizí komukoliv, kdo znal adresu API.
 * Utajení musí umět backend, jinak je to jen zábrana proti náhodnému
 * návštěvníkovi a proti Googlu.
 *
 * **Kdo mění tohle datum, mění ho i v `fsl-web/src/lib/sezona.ts`** (SEZONA.start).
 */
const START_SEZONY = new Date('2026-11-09T00:00:00+01:00');

/**
 * Datum bez roku: „1. 11."
 *
 * Formátuje se **natvrdo v pražském pásmu**, ne lokálními gettery. Railway
 * běží v UTC a `new Date('2026-11-01T00:00:00+01:00').getDate()` tam vrátí
 * 31 — půlnoc v Praze je 23:00 předchozího dne v UTC. Na tohle se povedlo
 * naletět už jednou na webu.
 */
const FORMAT_DNE = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  day:      'numeric',
  month:    'numeric',
});

function den(d) {
  // cs-CZ dává „1. 11." — mezera je nezlomitelná, sjednotíme ji na obyčejnou.
  return FORMAT_DNE.format(d).replace(/ /g, ' ').trim();
}

/** Vidí už vedoucí seznam volných hráčů? */
function draftOtevren(ted = new Date()) {
  return ted.getTime() >= OTEVRENI_DRAFTU.getTime();
}

/**
 * Začala sezóna? Do té doby jsou účastníci (týmy i hráči) neveřejní.
 *
 * Pravidlo, které z toho plyne pro routy: **týmy vidí jen supervisor**
 * (a lidé z toho týmu svůj vlastní), **hráče vidí jen přihlášený** — vedoucí
 * musí umět složit soupisku a hráče k tomu potřebuje najít.
 */
function sezonaZacala(ted = new Date()) {
  return ted.getTime() >= START_SEZONY.getTime();
}

module.exports = {
  KONEC_PRIHLASEK, OTEVRENI_DRAFTU, START_SEZONY,
  den, draftOtevren, sezonaZacala,
};
