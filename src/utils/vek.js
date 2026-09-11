/**
 * Věk a datum narození.
 *
 * Do soutěže smí jen dospělí — **18 let ke dni registrace**. Hranice je
 * tvrdá a hlídá se na serveru, protože formulář na webu i v aplikaci se dá
 * obejít. Klientská validace je jen ohleduplnost k uživateli, ne pojistka.
 *
 * Věk se počítá **ke dni registrace**, ne k začátku sezóny. Kdo dovrší
 * osmnáct až v průběhu sezóny, registruje se až potom. Kdyby se to mělo
 * změnit na začátek sezóny, mění se to tady na jednom místě — proto všechny
 * funkce berou `kDatu`.
 */

/** Kolik let musí být každému, kdo vstupuje do ligy. */
const VEKOVA_HRANICE = 18;

/** Nejstarší přijímaný ročník. Starší datum je skoro jistě překlep. */
const NEJSTARSI_ROK = 1920;

/**
 * Přísný převod na datum. Bere `YYYY-MM-DD` i ISO řetězec s časem.
 *
 * `new Date('2007-02-31')` v JS nespadne, jen tiše posune na 3. března —
 * proto se u `YYYY-MM-DD` kontroluje, že se složky po převodu shodují.
 *
 * @returns {Date|null} `null`, když to datum není nebo nedává smysl
 */
function naDatum(hodnota) {
  if (hodnota instanceof Date) {
    return Number.isNaN(hodnota.getTime()) ? null : hodnota;
  }
  const text = String(hodnota ?? '').trim();
  if (!text) return null;

  const shoda = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!shoda) return null;

  const [, r, m, d] = shoda.map(Number);
  const datum = new Date(Date.UTC(r, m - 1, d));
  if (
    datum.getUTCFullYear() !== r ||
    datum.getUTCMonth() !== m - 1 ||
    datum.getUTCDate() !== d
  ) {
    return null; // 31. února a spol.
  }
  return datum;
}

/**
 * Dovršený věk v letech.
 *
 * @param {Date|string} narozeni
 * @param {Date} [kDatu] Ke kterému dni se počítá. Výchozí je dnešek.
 * @returns {number|null}
 */
function vek(narozeni, kDatu = new Date()) {
  const datum = naDatum(narozeni);
  if (!datum) return null;

  let let_ = kDatu.getUTCFullYear() - datum.getUTCFullYear();
  const mesic = kDatu.getUTCMonth() - datum.getUTCMonth();
  if (mesic < 0 || (mesic === 0 && kDatu.getUTCDate() < datum.getUTCDate())) let_ -= 1;
  return let_;
}

/**
 * Jediné místo, kde se rozhoduje, jestli datum narození projde.
 *
 * @returns {{ ok: boolean, datum: Date|null, chyba: string|null, kod: string|null }}
 */
function zkontrolujDatumNarozeni(hodnota, kDatu = new Date()) {
  const datum = naDatum(hodnota);
  if (!datum) {
    return { ok: false, datum: null, kod: 'BIRTHDATE_INVALID', chyba: 'Datum narození není platné.' };
  }
  if (datum.getTime() > kDatu.getTime()) {
    return { ok: false, datum: null, kod: 'BIRTHDATE_INVALID', chyba: 'Datum narození není platné.' };
  }
  if (datum.getUTCFullYear() < NEJSTARSI_ROK) {
    return { ok: false, datum: null, kod: 'BIRTHDATE_INVALID', chyba: 'Datum narození není platné.' };
  }
  if (vek(datum, kDatu) < VEKOVA_HRANICE) {
    return {
      ok: false,
      datum: null,
      kod: 'UNDERAGE',
      chyba: `Do FSL smí jen hráči od ${VEKOVA_HRANICE} let.`,
    };
  }
  return { ok: true, datum, kod: null, chyba: null };
}

/**
 * Datum narození z rodného čísla.
 *
 * Formát je `RRMMDD/XXX[X]`. U žen je k měsíci přičteno 50, od roku 2004
 * navíc 20 (a u žen tedy 70), když v jednom dni došla čísla.
 *
 * Ročník: devítimístné rodné číslo se přidělovalo do roku 1953, takže
 * `19RR`. U desetimístného platí 54–99 → 19xx, 00–53 → 20xx.
 *
 * Kontrolní číslice se **záměrně neověřuje** — u starších rodných čísel
 * neplatí a odmítnout platné RČ by bylo horší než pustit překlep. Pro věk
 * stačí datum.
 *
 * @returns {Date|null}
 */
function datumZRodnehoCisla(rodneCislo) {
  const cisla = String(rodneCislo ?? '').replace(/[^\d]/g, '');
  if (cisla.length !== 9 && cisla.length !== 10) return null;

  const rr = Number(cisla.slice(0, 2));
  let mm = Number(cisla.slice(2, 4));
  const dd = Number(cisla.slice(4, 6));

  if (mm > 70) mm -= 70;        // žena, přetečená řada (od 2004)
  else if (mm > 50) mm -= 50;   // žena
  else if (mm > 20) mm -= 20;   // muž, přetečená řada (od 2004)

  const rok = cisla.length === 9 ? 1900 + rr : (rr <= 53 ? 2000 + rr : 1900 + rr);

  return naDatum(`${rok}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
}

/**
 * Kontrola věku rozhodčího. Datum narození se bere z rodného čísla —
 * vlastní pole by znamenalo ptát se na totéž dvakrát.
 */
function zkontrolujRodneCislo(rodneCislo, kDatu = new Date()) {
  const text = String(rodneCislo ?? '').trim();
  if (!text) {
    return { ok: false, datum: null, kod: 'BIRTHNO_REQUIRED', chyba: 'Rodné číslo je povinné.' };
  }
  const datum = datumZRodnehoCisla(text);
  if (!datum) {
    return {
      ok: false,
      datum: null,
      kod: 'BIRTHNO_INVALID',
      chyba: 'Rodné číslo zadej ve formátu 950615/1234.',
    };
  }
  return zkontrolujDatumNarozeni(datum, kDatu);
}

module.exports = {
  VEKOVA_HRANICE,
  NEJSTARSI_ROK,
  naDatum,
  vek,
  zkontrolujDatumNarozeni,
  datumZRodnehoCisla,
  zkontrolujRodneCislo,
};
