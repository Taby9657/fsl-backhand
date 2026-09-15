/**
 * Kolik lidí smí být na soupisce a v sestavě.
 *
 * Počítá se zvlášť pole a zvlášť brankáři — jedno číslo by nestačilo.
 * Sestava 7 hráčů do pole a 2 brankáři má devět lidí a brankáře, a přesto
 * je podle pravidel neplatná; přesně tuhle díru měla dosavadní kontrola
 * `MIN_PLAYERS = 9 && někdo je brankář`.
 *
 * Kdo je brankář, rozhoduje `TeamRoster.slot`, ne `Player.position`.
 *
 * **`null` jako strop znamená „bez stropu", ne nulu.** Kdo ho někde porovná
 * číslem bez kontroly, propustí tiše všechno — `pole >= null` je vždycky
 * `false`. Proto se všude testuje `limity.max... != null` napřed.
 */

/**
 * Soupiska na sezónu — **9 + 1 minimum, bez horního stropu**.
 *
 * Strop padl 15. 9. 2026. Do té doby byla soupiska 15 + 2 a tým, který
 * sehnal šestnáctého hráče, ho musel odmítnout, přestože by si licenci
 * i starty platil sám. **Minimum zůstává:** bez 9 + 1 tým supervisor do
 * soutěže nezařadí.
 */
const SOUPISKA = { minPole: 9, minBrankaru: 1, maxPole: null, maxBrankaru: null };

/**
 * Otevřený tým měl do 15. 9. 2026 soupisku přísnější (12 + 2). Dnes platí
 * pro všechny stejná, tedy bez stropu. Konstanta zůstává schválně: díky ní
 * má `limitySoupisky` pořád kam sáhnout a strop se dá otevřeným týmům vrátit
 * na jednom místě, ne po celém backendu.
 */
const SOUPISKA_OTEVRENY = { ...SOUPISKA };

/**
 * Sestava na zápas — **8 + 1 minimum, 18 + 2 maximum**.
 *
 * Strop se 15. 9. 2026 zvedl z 15 na 18. **Sestava je od té doby jediné
 * místo, kde se počet hlídá shora** — soupiska strop nemá vůbec, takže se
 * o něj sestava nemůže opřít tak, jak to dělala dřív („kdo je na soupisce,
 * může nastoupit"). Drží se kvůli zápisu a střídání, ne kvůli soupisce.
 */
const SESTAVA = { minPole: 8, minBrankaru: 1, maxPole: 18, maxBrankaru: 2 };

/** Limity soupisky podle typu týmu. */
function limitySoupisky(team) {
  return team?.isOpen ? SOUPISKA_OTEVRENY : SOUPISKA;
}

/** Spočítá pole a brankáře v seznamu řádků se `slot`. */
function rozdel(radky) {
  let pole = 0, brankaru = 0;
  for (const r of radky ?? []) {
    if (r?.slot === 'GOALKEEPER') brankaru += 1;
    else pole += 1;
  }
  return { pole, brankaru };
}

/**
 * Vejde se další hráč na soupisku?
 * Vrací `{ ok, code, error }` — `code` používá klient pro hezčí hlášku.
 */
function vejdeSeNaSoupisku({ pole, brankaru }, slot, limity = SOUPISKA) {
  if (slot === 'GOALKEEPER') {
    if (limity.maxBrankaru != null && brankaru >= limity.maxBrankaru) {
      return {
        ok: false, code: 'GK_LIMIT',
        error: `Tým už má ${limity.maxBrankaru} brankáře, víc jich na soupisku nepatří`,
      };
    }
    return { ok: true };
  }
  if (limity.maxPole != null && pole >= limity.maxPole) {
    return {
      ok: false, code: 'FIELD_LIMIT',
      error: `Tým už má ${limity.maxPole} hráčů do pole, víc se jich na soupisku nevejde`,
    };
  }
  return { ok: true };
}

/**
 * Je soupiska dost velká, aby tým mohl do soutěže?
 * Kontroluje se při rozlosování, ne při registraci — tým vzniká prázdný.
 */
function soupiskaStaci({ pole, brankaru }, limity = SOUPISKA) {
  const chybi = [];
  if (pole < limity.minPole) chybi.push(`hráčů do pole (${pole}/${limity.minPole})`);
  if (brankaru < limity.minBrankaru) chybi.push(`brankářů (${brankaru}/${limity.minBrankaru})`);
  return chybi.length === 0 ? { ok: true } : { ok: false, code: 'ROSTER_TOO_SMALL', chybi };
}

/**
 * Kontrola sestavy na zápas. Vrací seznam hlášek, prázdný = v pořádku.
 * `popis` je zkratka týmu, ať vedoucí pozná, o koho jde.
 */
function zkontrolujSestavu({ pole, brankaru }, popis = '') {
  const p = popis ? `${popis}: ` : '';
  const chyby = [];
  if (pole < SESTAVA.minPole) {
    chyby.push(`${p}min. ${SESTAVA.minPole} hráčů do pole (má ${pole})`);
  }
  if (brankaru < SESTAVA.minBrankaru) chyby.push(`${p}chybí brankář`);
  if (pole > SESTAVA.maxPole) {
    chyby.push(`${p}max. ${SESTAVA.maxPole} hráčů do pole (má ${pole})`);
  }
  if (brankaru > SESTAVA.maxBrankaru) {
    chyby.push(`${p}max. ${SESTAVA.maxBrankaru} brankáři (má ${brankaru})`);
  }
  return chyby;
}

module.exports = {
  SOUPISKA, SOUPISKA_OTEVRENY, SESTAVA,
  limitySoupisky, rozdel, vejdeSeNaSoupisku, soupiskaStaci, zkontrolujSestavu,
};
