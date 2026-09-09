/**
 * Pokuty za kontumaci.
 *
 * Když se tým nedostaví nebo nesehná sestavu, hřiště a rozhodčí jsou
 * zaplacení a nikdo nehrál. Trest má proto dvě části:
 *
 *   1. hráčům viníka propadnou starty z balíčku (`kredit.vyresKontumaci`),
 *      soupeři se vrátí — ten za nic nemůže,
 *   2. tým dostane pokutu ve výši ušlého zápasného a platí ji vedoucí.
 *
 * Proč obojí a ne jen jedno: samotné propadlé starty trestají tým tím víc,
 * čím víc lidí se přihlásilo — a tým, kterému se nepřihlásil nikdo, by
 * nezaplatil nic. Samotná pokuta zase nechává hráče, kteří dorazili,
 * a hráče, kteří to zabalili, na stejné lodi. Dohromady to sedí.
 *
 * Dokud je pokuta nezaplacená, rozhodčí týmu další zápas nespustí. Vymáhání
 * tak není na organizátorovi — buď tým zaplatí, nebo nehraje.
 */

const prisma = require('../lib/prisma');

/** Ušlé zápasné za hřiště a rozhodčího. Plochá částka, viz komentář výš. */
const POKUTA_KONTUMACE = 2200;

/** Stavy, ve kterých pokuta pořád visí. */
const NEZAPLACENO = ['PENDING', 'OVERDUE'];

/**
 * Předepíše pokutu za kontumaci.
 *
 * Jedna kontumace = jedna pokuta (unikát na `matchId`), takže opakované
 * volání nic nezdvojí — vrátí tu původní.
 */
async function predepis(match, vinikTeamId, tx = prisma) {
  const uz = await tx.fine.findUnique({ where: { matchId: match.id } });
  if (uz) return { pokuta: uz, uzBylo: true };

  const datum = new Date(match.date).toLocaleDateString('cs-CZ');
  const pokuta = await tx.fine.create({
    data: {
      teamId: vinikTeamId,
      matchId: match.id,
      season: match.season,
      amount: POKUTA_KONTUMACE,
      reason: `Kontumace zápasu ${datum} — ušlé zápasné za hřiště a rozhodčího.`,
    },
  });
  return { pokuta, uzBylo: false };
}

/**
 * Nezaplacené pokuty týmu. Na tomhle stojí brána rozhodčího.
 */
async function nezaplacene(teamId, tx = prisma) {
  return tx.fine.findMany({
    where:   { teamId, status: { in: NEZAPLACENO } },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Kolik kontumací má tým za sezónu.
 *
 * Po třetí tým ze soutěže končí — ale vyloučení nedělá systém sám.
 * Je to rozhodnutí s dopadem na rozlosování a na peníze ostatních,
 * takže se jen upozorní supervisor.
 */
async function pocetKontumaci(teamId, season, tx = prisma) {
  return tx.match.count({ where: { forfeitTeamId: teamId, season } });
}

module.exports = {
  POKUTA_KONTUMACE, NEZAPLACENO,
  predepis, nezaplacene, pocetKontumaci,
};
