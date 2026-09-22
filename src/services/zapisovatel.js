/**
 * Zapisovatel — kdo píše zápis.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 9.
 *
 * **Losování je funkce aplikace, ne Pandina služba.** Běží i při
 * `pandaMode = OFF` a výsledek jde do chatu jako systémová karta — bez
 * Pandina hlasu. Kdyby viselo na Pandě, vedoucí, který si ji vypnul, by
 * přišel o jediný nástroj, jak zapisovatele určit spravedlivě.
 *
 * Dvě pravidla, na kterých to celé stojí:
 *
 *   · **Losuje se z lidí, kteří na zápas jdou** — z odeslané sestavy, a než
 *     existuje, z přihlášených. **Nikdy z celé soupisky**: vylosovat někoho,
 *     kdo na zápas nejede, není los, ale trest pro toho dalšího v pořadí.
 *   · **Každý pokus je vlastní řádek a pořadí se ukazuje.** V kartě stojí
 *     „los č. 2" a kdo vyšel předtím. Bez toho by se z losu stal výběr —
 *     vedoucí by losoval tak dlouho, dokud by nevyšel ten, koho chtěl.
 *
 * Čisté rozhodování (`kandidati`, `vyber`) je schválně bez databáze, aby
 * šlo otestovat v `npm run test:chat`.
 */

const crypto = require('crypto');

/**
 * Z koho se losuje.
 *
 * @param {object} vstup
 * @param {Array<{playerId: string, isGoalkeeper: boolean}>} vstup.sestava
 *        Odeslaná sestava. Má přednost před přihláškami — když existuje,
 *        přihlášky se ignorují úplně.
 * @param {Array<{playerId: string, brankar: boolean}>} vstup.prihlaseni
 *        Kdo řekl „hraju". `brankar` = má na soupisce slot GOALKEEPER, tedy
 *        půjde do brány (před odesláním sestavy nic přesnějšího nevíme).
 * @param {string[]} vstup.vyrazeni  `excludePlayerIds` od vedoucího.
 * @param {string[]} vstup.drive     Kdo už u tohohle zápasu vylosovaný byl.
 * @returns {string[]} id hráčů, mezi kterými se losuje
 */
function kandidati({ sestava = [], prihlaseni = [], vyrazeni = [], drive = [] }) {
  const ven = new Set([...vyrazeni, ...drive]);

  const zaklad = sestava.length
    ? sestava.filter(h => !h.isGoalkeeper).map(h => h.playerId)
    : prihlaseni.filter(h => !h.brankar).map(h => h.playerId);

  return [...new Set(zaklad)].filter(id => !ven.has(id));
}

/**
 * Vybere jednoho. `nahoda` se dá v testu podstrčit, jinak jede
 * `crypto.randomInt` — `Math.random()` je na los, o kterém se bude mluvit
 * v kabině, málo.
 */
function vyber(seznam, nahoda) {
  if (!seznam.length) return null;
  const i = nahoda ? nahoda(seznam.length) : crypto.randomInt(seznam.length);
  return seznam[i];
}

/**
 * Text karty. Pořadí pokusu a předchozí vylosovaný jsou v něm schválně —
 * viz poznámka nahoře.
 */
function textKarty({ jmeno, drawNo, pocetKandidatu, predchozi, duvod }) {
  const uvod = drawNo > 1 ? `Los zapisovatele č. ${drawNo}` : 'Los zapisovatele';
  const zKoho = `Losovalo se z ${pocetKandidatu} ${pocetKandidatu === 1 ? 'hráče' : 'hráčů'}.`;
  const predtim = predchozi
    ? ` Předtím vyšel ${predchozi}${duvod ? ` — ${duvod}` : ''}.`
    : '';
  return `${uvod}: zapisuje ${jmeno}. ${zKoho}${predtim}`;
}

module.exports = { kandidati, vyber, textKarty };
