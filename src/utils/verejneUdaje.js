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

/**
 * Co z týmu smí ven bez přihlášení.
 *
 * Vynechané je celé kolečko kolem registrace (`regStatus`, `regNote`,
 * `regAppeal`, `regAppealAt`) — důvod zamítnutí od supervisora ani text
 * odvolání týmu nemá číst kdokoliv — a `_count`, protože počty týmů
 * a velikosti soupisek jsou informace pro vedení ligy, ne pro veřejnost.
 */
const VEREJNY_TYM = {
  id: true,
  name: true,
  abbr: true,
  color: true,
  colorSecondary: true,
  logoUrl: true,
  venue: true,
  division: true,
  conference: true,
};

/** Ořezání už načteného týmu na veřejná pole. */
function verejnyZaznamTymu(team) {
  if (!team) return team;
  const orezany = {};
  for (const klic of Object.keys(VEREJNY_TYM)) {
    if (klic in team) orezany[klic] = team[klic];
  }
  return orezany;
}

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

module.exports = {
  VEREJNY_HRAC, VEREJNA_PLATBA, VEREJNY_TYM,
  verejnyHrac, verejnaPlatba, verejnyZaznamTymu,
};
