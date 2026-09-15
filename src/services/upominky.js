/**
 * Připomínka nezaplaceného poplatku — hodinu po registraci.
 *
 * ── Komu se píše ────────────────────────────────────────────────────────
 * Jen tomu, kdo doopravdy platit má:
 *   · hráč, který je v týmu a nemá zaplacenou licenci,
 *   · tým, který nemá zaplacenou registraci (píše se jeho vedoucím).
 *
 * **Hráči bez týmu se nepíše nic.** Kdo se přihlásil do draftu, zatím nic
 * neplatí — nabídka Virtuálního vedoucího je možnost, ne dluh. Upomínka za
 * něco, co člověk platit nemusí, je spam a ničí přesně ten první dojem,
 * kvůli kterému uvítací e-maily vznikly.
 *
 * ── Proč se nemaže ──────────────────────────────────────────────────────
 * Hrozba „zaplať, nebo tě smažeme" by byla lež: **převodem platba dorazí za
 * den dva** a párování z Fia běží v denním cyklu, takže by se mazali lidé,
 * kteří zaplatili. Skutečná páka je věcná a stojí v pravidlech — bez
 * licence hráč nenastoupí a tým bez registrace se do soutěže nezařadí.
 *
 * ── Proč se neposílá dvakrát ────────────────────────────────────────────
 * `upominkaAt` se zapisuje hned po odeslání. Cron běží každých 15 minut,
 * takže „hodinu po registraci" je ve skutečnosti 60 až 75 minut — na
 * připomínku víc než dost.
 */

const prisma = require('../lib/prisma');
const mailer = require('./mailer');

/** Za jak dlouho po registraci se ozveme. */
const PO_REGISTRACI_MS = 60 * 60 * 1000;

/**
 * Odkdy se upomínky posílají.
 *
 * Bez téhle hranice by první spuštění po nasazení rozeslalo připomínku všem
 * nezaplaceným registracím zpětně — včetně lidí, kteří se přihlásili v době,
 * kdy žádný uvítací e-mail neexistoval a tohle by pro ně byla první zpráva
 * od ligy vůbec.
 */
const UPOMINKY_OD = new Date('2026-09-16T00:00:00Z');

/** Kolik jich poslat za jeden průchod. Brzda pro případ, že se něco nastřádá. */
const DAVKA = 50;

/**
 * `ted` a `od` jsou tu kvůli testu, produkce je nepředává. Bez nich by test
 * záležel na tom, kolikátého zrovna je — a `UPOMINKY_OD` je pevné datum.
 */
async function posliUpominky({ ted = new Date(), od = UPOMINKY_OD } = {}) {
  const hranice = new Date(ted.getTime() - PO_REGISTRACI_MS);
  const [hracu, tymu] = await Promise.all([
    upominkyHracum(hranice, od),
    upominkyTymum(hranice, od),
  ]);
  return { hracu, tymu };
}

/** Hráč v týmu bez zaplacené licence. */
async function upominkyHracum(hranice, od) {
  const platby = await prisma.playerPayment.findMany({
    where: {
      licStatus:  { in: ['PENDING', 'OVERDUE'] },
      upominkaAt: null,
      player: {
        teamId:    { not: null },
        createdAt: { lte: hranice, gte: od },
        userId:    { not: null },
      },
    },
    include: {
      player: {
        select: {
          firstName: true,
          user: { select: { email: true } },
        },
      },
    },
    take: DAVKA,
  });

  let odeslano = 0;
  for (const platba of platby) {
    const email = platba.player?.user?.email;
    if (!email) continue;

    const vysledek = await mailer.posliBezpecne(
      email,
      mailer.upominkaPlatbaMail({
        jmeno:   platba.player.firstName,
        polozky: [{ nazev: `Hráčská licence · sezóna ${platba.season}`, castka: platba.licFee }],
        castka:  platba.licFee,
      }),
      'upominka-licence',
    );

    // Zapisuje se i po neúspěchu. Kdyby se zapisoval jen úspěch, plná nebo
    // neexistující schránka by znamenala pokus při každém průchodu cronu
    // donekonečna.
    await prisma.playerPayment.update({
      where: { id: platba.id },
      data:  { upominkaAt: new Date() },
    });
    if (vysledek.ok) odeslano += 1;
  }
  return odeslano;
}

/** Tým bez zaplacené registrace — píše se všem jeho vedoucím. */
async function upominkyTymum(hranice, od) {
  const platby = await prisma.teamPayment.findMany({
    where: {
      status:     { in: ['PENDING', 'OVERDUE'] },
      upominkaAt: null,
      team:       { createdAt: { lte: hranice, gte: od } },
    },
    include: {
      team: {
        select: {
          name:     true,
          managers: { select: { user: { select: { email: true } } } },
        },
      },
    },
    take: DAVKA,
  });

  let odeslano = 0;
  for (const platba of platby) {
    const adresy = (platba.team?.managers ?? [])
      .map(m => m.user?.email)
      .filter(Boolean);

    for (const email of adresy) {
      const vysledek = await mailer.posliBezpecne(
        email,
        mailer.upominkaPlatbaMail({
          jmeno:   null,
          polozky: [{
            nazev:  `Registrace týmu ${platba.team.name} · sezóna ${platba.season}`,
            castka: platba.amount,
          }],
          castka: platba.amount,
        }),
        'upominka-registrace',
      );
      if (vysledek.ok) odeslano += 1;
    }

    await prisma.teamPayment.update({
      where: { id: platba.id },
      data:  { upominkaAt: new Date() },
    });
  }
  return odeslano;
}

module.exports = { posliUpominky, PO_REGISTRACI_MS, UPOMINKY_OD };
