/**
 * Pravidla licencí.
 *
 * Hráčská licence  — bez ní hráč nesmí nastoupit vůbec (hlídá se u soupisky).
 * Superlicence     — umožňuje nastupovat i za jiné týmy než kmenový:
 *
 *   Základní část: nejvýš 3 týmy dohromady (kmenový + 2 hostování).
 *   Playoff:       jen za týmy, které si hráč po základní části zvolil jako
 *                  primární a sekundární. Nárok vzniká odehráním alespoň
 *                  MIN_STARTU_PRO_PLAYOFF zápasů za daný tým v základní části.
 *                  Za sekundární tým smí nastoupit teprve tehdy, když
 *                  primárnímu týmu playoff skončí — nikdy tedy nehraje
 *                  dvě série naráz a nemůže rozhodovat vzájemný zápas.
 */

const prisma = require('../lib/prisma');

const MAX_TYMU_V_ZAKLADNI    = 3;
const MIN_STARTU_PRO_PLAYOFF = 3;

/** Má hráč zaplacenou (nebo odpuštěnou) superlicenci? */
function maSuperlicenci(payment) {
  return ['PAID', 'WAIVED'].includes(payment?.superStatus);
}

/** Má hráč platnou základní licenci? */
function maZakladniLicenci(payment) {
  return ['PAID', 'WAIVED'].includes(payment?.licStatus);
}

/**
 * Starty hráče podle týmů. Start = byl na soupisce odehraného zápasu.
 * `phase` omezí počítání na základní část nebo playoff.
 */
async function startyPodleTymu(playerId, season, phase = null) {
  const slots = await prisma.lineupPlayer.findMany({
    where: {
      playerId,
      lineup: {
        match: {
          status: 'DONE',
          ...(season ? { season } : {}),
          ...(phase  ? { phase }  : {}),
        },
      },
    },
    select: { lineup: { select: { teamId: true } } },
  });

  const podleTymu = new Map();
  for (const s of slots) {
    const t = s.lineup.teamId;
    podleTymu.set(t, (podleTymu.get(t) ?? 0) + 1);
  }
  return podleTymu;
}

/**
 * Týmy, za které hráč v sezóně figuruje — tedy kde je na jakékoli soupisce
 * (i na nadcházející zápas) plus jeho kmenový tým. Podle toho se počítá
 * strop tří týmů: nasazení do sestavy se počítá hned, ne až po odehrání.
 */
async function tymyVSezone(playerId, season, kmenovyTymId = null) {
  const slots = await prisma.lineupPlayer.findMany({
    where: {
      playerId,
      lineup: { match: { season, status: { not: 'CANCELLED' } } },
    },
    select: { lineup: { select: { teamId: true } } },
  });

  const tymy = new Set(slots.map(s => s.lineup.teamId));
  if (kmenovyTymId) tymy.add(kmenovyTymId);
  return tymy;
}

/**
 * Skončilo týmu playoff? Bere se jako „nemá naplánovaný ani rozehraný
 * playoff zápas". Tým, který se do playoff vůbec nedostal, je tím pádem
 * skončený hned — sekundární tým se hráči odemkne bez čekání.
 */
async function playoffSkoncil(teamId, season) {
  const zbyva = await prisma.match.count({
    where: {
      season,
      phase:  'PLAYOFF',
      status: { in: ['UPCOMING', 'LIVE'] },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
  });
  return zbyva === 0;
}

/** Týmy, za které si hráč může zvolit playoff — tedy kde má dost startů. */
async function narokyNaPlayoff(playerId, season) {
  const starty = await startyPodleTymu(playerId, season, 'REGULAR');
  const idcka  = [...starty.entries()]
    .filter(([, pocet]) => pocet >= MIN_STARTU_PRO_PLAYOFF)
    .map(([teamId]) => teamId);

  if (idcka.length === 0) return [];

  const tymy = await prisma.team.findMany({
    where:  { id: { in: idcka } },
    select: { id: true, name: true, abbr: true, color: true },
  });

  return tymy
    .map(t => ({ ...t, starts: starty.get(t.id) ?? 0 }))
    .sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name));
}

/**
 * Smí tenhle hráč nastoupit za tenhle tým v tomhle zápase?
 * Vrací { ok, code, error } — `code` používá aplikace pro hezčí hlášku.
 */
async function overNastup(playerId, teamId, match) {
  const player = await prisma.player.findUnique({
    where:  { id: playerId },
    select: { id: true, teamId: true, firstName: true, lastName: true, payment: true },
  });
  if (!player) return { ok: false, code: 'NO_PLAYER', error: 'Hráč nenalezen' };

  if (!maZakladniLicenci(player.payment)) {
    return { ok: false, code: 'NO_LICENCE', error: 'Hráč nemá platnou licenci' };
  }

  // Kmenový tým je zdarma — na ten stačí základní licence
  if (player.teamId && player.teamId === teamId) return { ok: true };

  if (!maSuperlicenci(player.payment)) {
    return {
      ok: false, code: 'NO_SUPER',
      error: 'Za cizí tým smí nastoupit jen hráč se superlicencí',
    };
  }

  const season = match.season;

  if (match.phase === 'PLAYOFF') {
    const volba = await prisma.playoffChoice.findUnique({
      where: { playerId_season: { playerId, season } },
    });
    if (!volba) {
      return {
        ok: false, code: 'NO_PLAYOFF_CHOICE',
        error: 'Hráč si pro playoff nezvolil týmy',
      };
    }
    if (volba.primaryTeamId === teamId) return { ok: true };

    if (volba.secondaryTeamId === teamId) {
      const uvolneno = await playoffSkoncil(volba.primaryTeamId, season);
      if (uvolneno) return { ok: true };
      return {
        ok: false, code: 'SECONDARY_LOCKED',
        error: 'Sekundární tým se odemkne, až primárnímu týmu playoff skončí',
      };
    }

    return {
      ok: false, code: 'NOT_CHOSEN',
      error: 'Tenhle tým si hráč pro playoff nezvolil',
    };
  }

  // Základní část — strop tří týmů
  const tymy = await tymyVSezone(playerId, season, player.teamId);
  if (!tymy.has(teamId) && tymy.size >= MAX_TYMU_V_ZAKLADNI) {
    return {
      ok: false, code: 'TEAM_LIMIT',
      error: `Hráč už v sezóně figuruje ve ${MAX_TYMU_V_ZAKLADNI} týmech`,
    };
  }

  return { ok: true };
}

/** Přehled pro obrazovku licencí. */
async function prehledHrace(playerId, season) {
  const player = await prisma.player.findUnique({
    where:  { id: playerId },
    select: {
      id: true, teamId: true, payment: true,
      team: { select: { id: true, name: true, abbr: true, color: true } },
    },
  });
  if (!player) return null;

  const starty  = await startyPodleTymu(playerId, season, 'REGULAR');
  const tymyIds = await tymyVSezone(playerId, season, player.teamId);

  const tymy = await prisma.team.findMany({
    where:  { id: { in: [...tymyIds] } },
    select: { id: true, name: true, abbr: true, color: true },
  });

  const volba = await prisma.playoffChoice.findUnique({
    where: { playerId_season: { playerId, season } },
    include: {
      primary:   { select: { id: true, name: true, abbr: true, color: true } },
      secondary: { select: { id: true, name: true, abbr: true, color: true } },
    },
  });

  const sekundarniOdemcen = volba
    ? await playoffSkoncil(volba.primaryTeamId, season)
    : false;

  return {
    season,
    licStatus:   player.payment?.licStatus   ?? 'PENDING',
    superStatus: player.payment?.superStatus ?? 'PENDING',
    superLic:    maSuperlicenci(player.payment),
    homeTeam:    player.team ?? null,
    maxTeams:    MAX_TYMU_V_ZAKLADNI,
    minStarts:   MIN_STARTU_PRO_PLAYOFF,
    teams: tymy
      .map(t => ({
        ...t,
        isHome:  t.id === player.teamId,
        starts:  starty.get(t.id) ?? 0,
        playoffEligible: (starty.get(t.id) ?? 0) >= MIN_STARTU_PRO_PLAYOFF,
      }))
      .sort((a, b) => Number(b.isHome) - Number(a.isHome) || b.starts - a.starts),
    playoff: {
      choice:             volba ?? null,
      eligibleTeams:      await narokyNaPlayoff(playerId, season),
      secondaryUnlocked:  sekundarniOdemcen,
    },
  };
}

module.exports = {
  MAX_TYMU_V_ZAKLADNI,
  MIN_STARTU_PRO_PLAYOFF,
  maSuperlicenci,
  maZakladniLicenci,
  startyPodleTymu,
  tymyVSezone,
  playoffSkoncil,
  narokyNaPlayoff,
  overNastup,
  prehledHrace,
};
