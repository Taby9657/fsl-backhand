/**
 * Pravidla licencí.
 *
 * Hráčská licence  — bez ní hráč nesmí nastoupit vůbec (hlídá se u soupisky).
 * Superlicence     — umožňuje nastupovat i za jiné týmy než kmenový:
 *
 *   Základní část: hráč je na soupiskách nejvýš 3 týmů (kmenový + 2 hostování).
 *                  Vedoucí pak do sestavy vybírá jen z vlastní soupisky.
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

/** Týmy, na jejichž soupisce hráč v sezóně je. */
async function tymyVSezone(playerId, season) {
  const radky = await prisma.teamRoster.findMany({
    where:  { playerId, season },
    select: { teamId: true },
  });
  return new Set(radky.map(r => r.teamId));
}

/** Je hráč na soupisce tohohle týmu? */
async function jeNaSoupisce(playerId, teamId, season) {
  const radek = await prisma.teamRoster.findUnique({
    where: { playerId_teamId_season: { playerId, teamId, season } },
  });
  return radek ?? null;
}

/**
 * Přidání hráče na soupisku týmu.
 * Hostování (tedy jiný než kmenový tým) vyžaduje superlicenci
 * a dohromady smí být hráč nejvýš na MAX_TYMU_V_ZAKLADNI soupiskách.
 */
async function pridatDoSoupisky(playerId, teamId, season, { isHome = false } = {}) {
  const player = await prisma.player.findUnique({
    where:  { id: playerId },
    select: { id: true, teamId: true, payment: true, firstName: true, lastName: true },
  });
  if (!player) return { ok: false, code: 'NO_PLAYER', error: 'Hráč nenalezen' };

  const uz = await jeNaSoupisce(playerId, teamId, season);
  if (uz) return { ok: false, code: 'ALREADY_ON_ROSTER', error: 'Hráč už na soupisce je' };

  const kmenovy = isHome || player.teamId === teamId;

  if (!kmenovy && !maSuperlicenci(player.payment)) {
    return {
      ok: false, code: 'NO_SUPER',
      error: 'Hostovat v dalším týmu smí jen hráč se superlicencí',
    };
  }

  const pocet = await prisma.teamRoster.count({ where: { playerId, season } });
  if (pocet >= MAX_TYMU_V_ZAKLADNI) {
    return {
      ok: false, code: 'TEAM_LIMIT',
      error: `Hráč už je na soupiskách ${MAX_TYMU_V_ZAKLADNI} týmů, víc jich mít nemůže`,
    };
  }

  const radek = await prisma.teamRoster.create({
    data: { playerId, teamId, season, isHome: kmenovy },
  });
  return { ok: true, radek };
}

/** Odebrání ze soupisky. Kmenový tým se odebírá jen přes odchod z týmu. */
async function odebratZeSoupisky(playerId, teamId, season) {
  await prisma.teamRoster.deleteMany({ where: { playerId, teamId, season } });
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

  const season = match.season;

  // Do sestavy jen z vlastní soupisky — hostování se řeší dřív, ne u zápasu
  const radek = await jeNaSoupisce(playerId, teamId, season);
  if (!radek) {
    return {
      ok: false, code: 'NOT_ON_ROSTER',
      error: 'Hráč není na soupisce tohoto týmu',
    };
  }

  // Kmenový hráč nemá v základní části žádné další podmínky
  if (radek.isHome) {
    if (match.phase !== 'PLAYOFF') return { ok: true };
  } else if (!maSuperlicenci(player.payment)) {
    // Pojistka pro případ, že licence vypršela až po zapsání na soupisku
    return {
      ok: false, code: 'NO_SUPER',
      error: 'Za cizí tým smí nastoupit jen hráč se superlicencí',
    };
  }

  if (match.phase !== 'PLAYOFF') return { ok: true };

  // ── Playoff ──
  // Kmenový tým je zároveň volbou jen tehdy, když si ho hráč zvolil.
  const volba = await prisma.playoffChoice.findUnique({
    where: { playerId_season: { playerId, season } },
  });

  // Bez superlicence hraje hráč playoff prostě za svůj kmenový tým
  if (!maSuperlicenci(player.payment)) {
    return radek.isHome
      ? { ok: true }
      : { ok: false, code: 'NO_SUPER', error: 'Za cizí tým smí nastoupit jen hráč se superlicencí' };
  }

  // Hráč jen s jedním týmem na soupisce volbu potřebovat nemusí
  const tymy = await tymyVSezone(playerId, season);
  if (!volba) {
    if (tymy.size === 1) return { ok: true };
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
  const tymyIds = await tymyVSezone(playerId, season);

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
  jeNaSoupisce,
  pridatDoSoupisky,
  odebratZeSoupisky,
  playoffSkoncil,
  narokyNaPlayoff,
  overNastup,
  prehledHrace,
};
