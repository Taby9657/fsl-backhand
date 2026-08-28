/**
 * Přechod na novou sezónu.
 *
 * Supervisor přechod naplánuje na konkrétní datum a v druhém kroku ho potvrdí
 * opsáním názvu sezóny. Naplánovaný a potvrzený přechod pak proběhne sám.
 *
 * Klíčové pravidlo: **přechod se neprovede, dokud existují neodehrané zápasy
 * staré sezóny.** Místo mlčenlivého zrušení zápasů se přechod odloží a
 * supervisoři dostanou notifikaci. Sezóna se přepne až ve chvíli, kdy je
 * stará dohraná.
 */

const prisma = require('../lib/prisma');
const { createNotifications } = require('../routes/notifications');

const SEASON_RE = /^\d{4}\/\d{2}$/;

/** Aktuální sezóna = sezóna posledního založeného zápasu. */
async function currentSeason() {
  const latest = await prisma.match.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { season: true },
  });
  return latest?.season ?? null;
}

/** Zápasy, které brání přechodu — nezahrané nebo rozehrané v dané sezóně. */
async function blockingMatches(season) {
  if (!season) return { count: 0, matches: [] };
  const matches = await prisma.match.findMany({
    where: { season, status: { in: ['UPCOMING', 'LIVE'] } },
    orderBy: { date: 'asc' },
    take: 20,
    select: {
      id: true, date: true, status: true,
      homeTeam: { select: { abbr: true } },
      awayTeam: { select: { abbr: true } },
    },
  });
  const count = await prisma.match.count({
    where: { season, status: { in: ['UPCOMING', 'LIVE'] } },
  });
  return { count, matches };
}

/** ID všech supervisorů — z databáze i z env záchranné brzdy. */
async function supervisorIds() {
  const supervisors = await prisma.user.findMany({
    where: {
      OR: [
        { isSupervisor: true },
        { player: { isSupervisor: true } },
      ],
    },
    select: { id: true },
  });
  const envIds = (process.env.SUPERVISOR_USER_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...supervisors.map(s => s.id), ...envIds])];
}

/** Rozešle notifikaci všem supervisorům. */
async function notifySupervisors(title, body) {
  const ids = await supervisorIds();
  if (!ids.length) return;
  await createNotifications(ids.map(userId => ({ userId, title, body, screen: 'admin' })));
}

/**
 * Smí tenhle uživatel potvrdit tenhle přechod?
 *
 * Pravidlo čtyř očí: potvrzuje někdo jiný než ten, kdo přechod naplánoval.
 * Když je v lize jediný supervisor, není komu to předat — potvrzuje sám,
 * pořád ale ve druhém kroku a s opsáním názvu sezóny.
 */
async function canConfirm(transition, userId) {
  if (!transition || transition.status !== 'PENDING_CONFIRM') return false;
  const ids = await supervisorIds();
  if (ids.length < 2) return true;
  return transition.createdById !== userId;
}

/**
 * Samotné přepnutí sezóny. Resetuje licence hráčů a platby týmů,
 * WAIVED záznamy nechává být (jsou odpuštěné supervisorem).
 *
 * Soupisky (`TeamRoster`) se schválně NEPŘENÁŠEJÍ. Jsou vázané na sezónu,
 * takže nová sezóna začíná s prázdnými soupiskami a každý tým se skládá
 * znovu — kmenové hráče doplní vedoucí jedním klepnutím
 * (`POST /teams/:id/roster/home`), hostování se musí sjednat nanovo
 * a s nově zaplacenou superlicencí. Staré řádky zůstávají jako historie.
 */
async function applyNewSeason(newSeason) {
  const oldSeason = await currentSeason();
  if (oldSeason === newSeason) {
    return { skipped: true, reason: 'Tato sezóna je již aktivní', oldSeason, newSeason };
  }

  const [resetLic, resetTeam] = await Promise.all([
    prisma.playerPayment.updateMany({
      where: { licStatus: { not: 'WAIVED' } },
      data: {
        licStatus: 'PENDING', licPaidAt: null, licMethod: null,
        superStatus: 'PENDING', superPaidAt: null, season: newSeason,
      },
    }),
    prisma.teamPayment.updateMany({
      where: { status: { not: 'WAIVED' } },
      data: { status: 'PENDING', paidAt: null, method: null, season: newSeason },
    }),
  ]);

  const waived = await prisma.playerPayment.findMany({
    where: { licStatus: 'WAIVED' },
    select: { playerId: true },
  });
  const waivedIds = waived.map(p => p.playerId);
  await prisma.player.updateMany({
    where: waivedIds.length > 0 ? { id: { notIn: waivedIds } } : {},
    data: { licensed: false },
  });

  return {
    skipped: false,
    oldSeason,
    newSeason,
    resetLicenses: resetLic.count,
    resetTeams: resetTeam.count,
  };
}

/**
 * Zkontroluje naplánované přechody a provede ty, kterým nastal čas.
 * Volá se periodicky ze server.js.
 */
async function processDueTransitions() {
  const due = await prisma.seasonTransition.findMany({
    where: { status: 'CONFIRMED', scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
  });

  for (const t of due) {
    const oldSeason = await currentSeason();
    const { count } = await blockingMatches(oldSeason);

    if (count > 0) {
      // Neodehrané zápasy → přechod odložíme a jednou denně na to upozorníme.
      const den = 24 * 60 * 60 * 1000;
      const uzUpozorneno = t.blockedNotifiedAt && (Date.now() - t.blockedNotifiedAt.getTime() < den);
      if (!uzUpozorneno) {
        await prisma.seasonTransition.update({
          where: { id: t.id },
          data: { blockedNotifiedAt: new Date() },
        });
        await notifySupervisors(
          'Přechod sezóny čeká',
          `Sezóna ${t.newSeason} měla začít, ale ve staré sezóně zbývá ${count} neodehraných zápasů. Přechod proběhne, jakmile budou dohrané, nebo je zrušte ve správě zápasů.`,
        );
        console.warn(`[Sezóna] Přechod na ${t.newSeason} odložen – ${count} neodehraných zápasů.`);
      }
      continue;
    }

    try {
      const result = await applyNewSeason(t.newSeason);
      await prisma.seasonTransition.update({
        where: { id: t.id },
        data: {
          status: 'EXECUTED',
          executedAt: new Date(),
          result: result.skipped
            ? `Přeskočeno: ${result.reason}`
            : `Resetováno ${result.resetLicenses} licencí a ${result.resetTeams} plateb týmů.`,
        },
      });
      await notifySupervisors(
        `Sezóna ${t.newSeason} začala`,
        result.skipped
          ? `Přechod přeskočen — ${result.reason}.`
          : `Licence hráčů i platby týmů byly resetovány. Resetováno ${result.resetLicenses} licencí.`,
      );
      console.log(`[Sezóna] Přechod na ${t.newSeason} proveden.`);
    } catch (err) {
      await prisma.seasonTransition.update({
        where: { id: t.id },
        data: { status: 'FAILED', result: err.message?.slice(0, 500) ?? 'Neznámá chyba' },
      });
      await notifySupervisors(
        'Přechod sezóny selhal',
        `Automatický přechod na ${t.newSeason} skončil chybou. Zkontrolujte nastavení ve správě ligy.`,
      );
      console.error(`[Sezóna] Přechod na ${t.newSeason} selhal:`, err.message);
    }
  }
}

module.exports = {
  SEASON_RE,
  supervisorIds,
  canConfirm,
  currentSeason,
  blockingMatches,
  notifySupervisors,
  applyNewSeason,
  processDueTransitions,
};
