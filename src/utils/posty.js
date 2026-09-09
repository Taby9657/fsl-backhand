/**
 * Rozpoznání brankáře z pole `Player.position`.
 *
 * `position` je volný text s výchozí hodnotou „Útočník" a v projektu se v něm
 * potkávají **dva slovníky zároveň**: kódy `GK / F / D` (mapy `POS` v appce
 * i ve webu) a česká slova `Brankář / Obránce / Útočník`, která do sloupce
 * zapisují registrační formuláře. Draft přidává ještě `Univerzál`.
 * Test `position === 'Brankář'` proto část gólmanů minie.
 *
 * Tenhle modul je jediné místo, kde se ta nejednotnost řeší. Používá se
 * **jen k odvození výchozí hodnoty** `TeamRoster.slot` — jakmile řádek
 * na soupisce existuje, rozhoduje `slot`, ne tenhle odhad.
 */

/** Malá písmena bez diakritiky — ať „Brankář" a „brankar" padnou na totéž. */
function normalizuj(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const BRANKARI = new Set(['gk', 'g', 'b', 'brankar', 'goalkeeper', 'goalie']);

/** Je tenhle post brankářský? */
function jeBrankar(position) {
  return BRANKARI.has(normalizuj(position));
}

/** Výchozí místo na soupisce podle postu hráče. */
function slotZPostu(position) {
  return jeBrankar(position) ? 'GOALKEEPER' : 'FIELD';
}

/** Řazení soupisky: brankáři nahoru, pak kmenoví, pak podle čísla dresu. */
function porovnejNaSoupisce(a, b) {
  const brankarA = a.slot === 'GOALKEEPER' ? 0 : 1;
  const brankarB = b.slot === 'GOALKEEPER' ? 0 : 1;
  return brankarA - brankarB
    || Number(b.isHome) - Number(a.isHome)
    || (a.jersey ?? 999) - (b.jersey ?? 999);
}

module.exports = { jeBrankar, slotZPostu, porovnejNaSoupisce };
