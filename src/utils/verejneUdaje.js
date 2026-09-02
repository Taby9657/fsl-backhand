/**
 * Co z hráče smí ven bez přihlášení.
 *
 * Prisma při `include` vrací **všechny** skalární sloupce, takže veřejné
 * endpointy musí pole vyjmenovat ručně — jinak jde ven telefon, datum narození
 * a u vazby `payment` i variabilní symbol a identifikátory Stripe sessions.
 * Ze stejného důvodu je vynechané `userId` (spojka na účet) a `isSupervisor`
 * (kdo ligu organizuje, není veřejná informace).
 */
const VEREJNY_HRAC = {
  id: true,
  teamId: true,
  firstName: true,
  lastName: true,
  jersey: true,
  position: true,
  photoUrl: true,
  licensed: true,
};

/** Stav licence pro odznak u soupisky — bez čísel plateb. */
const VEREJNA_PLATBA = {
  season: true,
  licStatus: true,
  superStatus: true,
  superLic: true,
};

/**
 * Ořezání už načteného hráče, když se plný objekt potřebuje jinde v kódu
 * (typicky detail týmu, kde vedoucí vidí všechno a anonym jen soupisku).
 */
function verejnyHrac(player) {
  if (!player) return player;

  const orezany = {};
  for (const klic of Object.keys(VEREJNY_HRAC)) {
    if (klic in player) orezany[klic] = player[klic];
  }

  // Vazby, které jsou samy o sobě veřejné (statistiky, tým, počty).
  for (const klic of ['team', 'goals', 'assists', 'penalties', 'mvpVotes', '_count']) {
    if (player[klic] !== undefined) orezany[klic] = player[klic];
  }

  if (player.payment !== undefined) orezany.payment = verejnaPlatba(player.payment);

  return orezany;
}

/** Z platby nechá jen stavy licencí, žádné VS ani Stripe id. */
function verejnaPlatba(payment) {
  if (!payment) return payment;
  const orezana = {};
  for (const klic of Object.keys(VEREJNA_PLATBA)) {
    if (klic in payment) orezana[klic] = payment[klic];
  }
  return orezana;
}

module.exports = { VEREJNY_HRAC, VEREJNA_PLATBA, verejnyHrac, verejnaPlatba };
