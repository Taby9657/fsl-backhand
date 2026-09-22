/**
 * Texty Pandiných zpráv kolem zápasu.
 *
 * **Schválně ve vlastním souboru bez databáze.** Šablona je to jediné, co
 * jde otestovat bez Prisma klienta — a je to zároveň to, co odejde, když
 * jazykový model (E2) nebude dostupný nebo jeho odpověď neprojde kontrolou.
 *
 * Texty jsou krátké, konkrétní a bez nadšení: Panda mluví za ligu.
 * Čísla v nich nejsou dekorace — „7/9" je to jediné, co člověka donutí
 * kliknout.
 */

const DEN_A_CAS = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', weekday: 'long', day: 'numeric', month: 'numeric',
  hour: 'numeric', minute: '2-digit',
});

/** „čtvrtek 12. 11. 18:00" — vždycky v pražském čase, server běží v UTC. */
function kdy(d) {
  return DEN_A_CAS.format(new Date(d)).replace(/ /g, ' ');
}

const SABLONY = {
  OTEVRENO: ({ zapas, hala }) =>
    `${kdy(zapas.date)}${hala ? `, ${hala}` : ''}. Kdo jede? Přihlaš se v Mém týmu.`,

  CHYBI_BRANKAR: ({ stav }) =>
    `Zatím ${stav} a nikdo do brány. Bez brankáře se zápas nezačne — ozve se někdo?`,

  UZAVERKA: ({ stav, sejdeSe, brankari }) =>
    sejdeSe
      ? `Sestava je uzavřená: ${stav}, brankářů ${brankari}. Sejdeme se.`
      : `Sestava je uzavřená a je nás málo: ${stav}${brankari === 0 ? ', bez brankáře' : ''}. Řeší to liga.`,

  DEN_D: ({ zapas, hala, stav }) =>
    `Dnes ${kdy(zapas.date)}${hala ? `, ${hala}` : ''}. Jdeme v ${stav}.`,
};

module.exports = { SABLONY, kdy };
