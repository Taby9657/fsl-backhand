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

/**
 * **Odložení 1. ročníku na sezónu 2027/28 — rozhodnuto 31. 10. 2026.**
 *
 * Haly se rezervovaly pozdě a na 2026/27 zbyly jen nevhodné termíny. Start je
 * v září 2027, přihlášky se otevřou v dubnu 2027, zaplacené peníze se vrátily.
 *
 * Dokud platí, backend **nepřijímá nové přihlášky ani platby**
 * (`zavrenoPriOdlozeni`), draft se neotevře a upomínky plateb se neposílají.
 * Supervisor projde, aby šlo cokoli opravit ručně.
 *
 * Stejný příznak je na webu: `fsl-web/src/lib/sezona.ts` (`ODLOZENI.aktivni`).
 * **V dubnu 2027 přepsat termíny na 2027/28 a tohle dát na `false`.**
 */
// `FSL_ODLOZENO=0` jen pro testy, které ověřují normální provoz registrace a plateb.
const ODLOZENO = process.env.FSL_ODLOZENO !== '0';
const ODLOZENI_TEXT = '1. ročník FSL startuje v září 2027, přihlášky otevřeme v dubnu 2027.';

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
 * Rozlosování. Po něm vzniká rozpis, tabulka i soupisky — a teprve pak se
 * dá říct, kde se který zápas hraje.
 */
const LOS = new Date('2026-11-02T00:00:00+01:00');

/** Název ročníku, hrací dny a čas. Panda je cituje, ať mluví jako web. */
const NAZEV = '2026/27';
const MESTO = 'Praze';
const HRACI_DNY = 'pondělí až čtvrtek';
const HRACI_CAS = '18:00 a 22:00';

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
  if (ODLOZENO) return false;
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
  if (ODLOZENO) return false;
  return ted.getTime() >= START_SEZONY.getTime();
}

/**
 * Middleware: při odložení ročníku odmítne novou přihlášku nebo platbu.
 * `410 Gone` — staré buildy appky i web dostanou srozumitelnou hlášku.
 */
function zavrenoPriOdlozeni(req, res, next) {
  if (!ODLOZENO) return next();
  // Líný require — auth.js si sezona.js nenatahuje, cyklus nehrozí, ale ať je to jisté.
  const { isSupervisorUser } = require('../middleware/auth');
  if (req.user && isSupervisorUser(req.user)) return next();
  return res.status(410).json({
    error: `Registrace i platby na sezónu 2026/27 jsou uzavřené. ${ODLOZENI_TEXT}`,
    code: 'SEZONA_ODLOZENA',
  });
}

module.exports = {
  ODLOZENO, ODLOZENI_TEXT, zavrenoPriOdlozeni,
  KONEC_PRIHLASEK, OTEVRENI_DRAFTU, START_SEZONY, LOS,
  NAZEV, MESTO, HRACI_DNY, HRACI_CAS,
  den, draftOtevren, sezonaZacala,
};
