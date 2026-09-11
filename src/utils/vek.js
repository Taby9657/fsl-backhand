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

module.exports = {
  VEKOVA_HRANICE,
  NEJSTARSI_ROK,
  naDatum,
  vek,
  zkontrolujDatumNarozeni,
};
