/**
 * Tabulka soutěže.
 *
 * Vytažené ze `routes/stats.js`, aby stejné pořadí používalo i nasazení
 * do playoff — jinak by hrozilo, že si tabulka a pavouk odporují.
 *
 * Řadí se: body → rozdíl skóre → vstřelené góly.
 * Do tabulky se počítá jen základní část (playoff výsledky pořadí nemění).
 */

const prisma = require('../lib/prisma');

/** Where klauzule podle rozsahu. Nová struktura má přednost před textovou divizí. */
function matchScope({ leagueId, conferenceId, divisionId, division, season }) {
  const where = {};
  if (divisionId)   where.divisionId   = divisionId;
  if (conferenceId) where.conferenceId = conferenceId;
  if (leagueId)     where.leagueId     = leagueId;
  if (division && !leagueId && !conferenceId && !divisionId) where.division = division;
  if (season)       where.season       = season;
  return where;
}

/**
 * Vrací seřazenou tabulku: [{ teamId, team, p, w, d, l, gf, ga, gd, pts, form }]
 * `phase` výchozí REGULAR — pořadí pro nasazení se bere ze základní části.
 */
async function tabulka(rozsah, { phase = 'REGULAR' } = {}) {
  const matches = await prisma.match.findMany({
    where: {
      ...matchScope(rozsah),
      status: 'DONE',
      ...(phase ? { phase } : {}),
    },
    select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true, date: true },
    orderBy: { date: 'desc' },
  });

  const radky = {};
  const forma = {};

  const zaznam = (teamId) => {
    if (!radky[teamId]) radky[teamId] = { teamId, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
    return radky[teamId];
  };
  const pridejFormu = (teamId, vysledek) => {
    if (!forma[teamId]) forma[teamId] = [];
    if (forma[teamId].length < 5) forma[teamId].push(vysledek);
  };

  for (const m of matches) {
    const hs = m.homeScore ?? 0;
    const as = m.awayScore ?? 0;
    if (hs > as)      { pridejFormu(m.homeTeamId, 'W'); pridejFormu(m.awayTeamId, 'L'); }
    else if (hs < as) { pridejFormu(m.homeTeamId, 'L'); pridejFormu(m.awayTeamId, 'W'); }
    else              { pridejFormu(m.homeTeamId, 'D'); pridejFormu(m.awayTeamId, 'D'); }

    const h = zaznam(m.homeTeamId);
    const a = zaznam(m.awayTeamId);
    h.p++; a.p++;
    h.gf += hs; h.ga += as;
    a.gf += as; a.ga += hs;
    if (hs > as)      { h.w++; h.pts += 3; a.l++; }
    else if (hs < as) { a.w++; a.pts += 3; h.l++; }
    else              { h.d++; h.pts += 1; a.d++; a.pts += 1; }
  }

  const ids = Object.keys(radky);
  if (ids.length === 0) return [];

  const tymy = await prisma.team.findMany({
    where:  { id: { in: ids } },
    select: { id: true, name: true, abbr: true, color: true, logoUrl: true },
  });
  const podleId = Object.fromEntries(tymy.map(t => [t.id, t]));

  return Object.values(radky)
    .map(r => ({
      ...r,
      team: podleId[r.teamId],
      gd:   r.gf - r.ga,
      form: [...(forma[r.teamId] ?? [])].reverse(),
    }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
}

/**
 * Nasazení do playoff: 1–8, 2–7, 3–6, 4–5.
 * Lepší tým je vždy domácí. Vrací dvojice v pořadí od nejvyššího nasazení.
 */
function nasazeni(poradi) {
  const pary = [];
  for (let i = 0; i < poradi.length / 2; i += 1) {
    pary.push({
      seedHome: i + 1,
      seedAway: poradi.length - i,
      home:     poradi[i],
      away:     poradi[poradi.length - 1 - i],
    });
  }
  return pary;
}

module.exports = { matchScope, tabulka, nasazeni };
