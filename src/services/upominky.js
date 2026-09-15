/**
 * Plán upomínek — co komu a kdy chodí, když po registraci nezaplatí.
 *
 * ── Plán ────────────────────────────────────────────────────────────────
 *   hodina  →  den  →  týden  →  ticho
 *
 * Jedna připomínka nestačila: kdo si ji přečte v práci a odloží ji na
 * večer, druhou šanci od nás nedostal. Tři jsou dost na to, aby se ozval
 * ten, kdo chce, a málo na to, aby to někoho otrávilo. **Čtvrtá už
 * nepřijde** — kdo nereagoval třikrát, nepřesvědčí ho ani čtvrtý e-mail
 * a nezaplacené přihlášky vidí supervisor ve Správě hráčů a v Týmech.
 *
 * ── Komu se píše ────────────────────────────────────────────────────────
 *   · hráč v týmu bez zaplacené licence      → hodina, den, týden
 *   · tým bez zaplacené registrace (vedoucím) → hodina, den, týden
 *   · hráč bez týmu v draftu                  → den, týden
 *
 * **Hráč bez týmu nedostává upomínku, ale nabídku.** V draftu nic nedluží:
 * licenci potřebuje, teprve až ho někdo vezme. Chodí mu proto jiná zpráva —
 * že je pořád v draftu a že nemusí čekat, když nechce (`nabidkaVstupuMail`).
 * A nechodí hodinu po registraci: to by přistála hned za uvítacím e-mailem
 * a vypadala by jako upomínka za něco, co platit nemusí.
 *
 * ── Proč se nemaže ──────────────────────────────────────────────────────
 * Hrozba „zaplať, nebo tě smažeme" by byla lež: **převodem platba dorazí za
 * den dva** a párování z Fia běží v denním cyklu, takže by se mazali lidé,
 * kteří zaplatili. Skutečná páka je věcná a stojí v pravidlech — bez
 * licence hráč nenastoupí a tým bez registrace se do soutěže nezařadí.
 *
 * ── Proč se neposílá dvakrát ────────────────────────────────────────────
 * `upominekPoslano` říká, kolikátá fáze je na řadě, `upominkaAt` kdy odešla
 * poslední. Cron běží každých 15 minut, takže „hodinu po registraci" je ve
 * skutečnosti 60 až 75 minut — na připomínku víc než dost.
 */

const prisma = require('../lib/prisma');
const mailer = require('./mailer');

const HODINA = 60 * 60 * 1000;
const DEN    = 24 * HODINA;

/** Za jak dlouho po registraci odchází která fáze. Délka pole = kolik jich přijde. */
const PLAN_PLATBA = [1 * HODINA, 1 * DEN, 7 * DEN];

/** Hráč bez týmu dostane o jednu míň a začíná se až druhý den. */
const PLAN_DRAFT = [1 * DEN, 7 * DEN];

/**
 * Odkdy se upomínky posílají.
 *
 * Bez téhle hranice by první spuštění po nasazení rozeslalo připomínky
 * zpětně — včetně lidí, kteří se přihlásili v době, kdy žádný uvítací
 * e-mail neexistoval a tohle by pro ně byla první zpráva od ligy vůbec.
 */
const UPOMINKY_OD = new Date('2026-09-16T00:00:00Z');

/** Kolik jich poslat za jeden průchod. Brzda pro případ, že se něco nastřádá. */
const DAVKA = 50;

/** Je tahle fáze na řadě? `poslano` je počet už odeslaných zpráv. */
function naRade(plan, poslano, registrace, ted) {
  if (poslano >= plan.length) return false;
  return ted.getTime() - new Date(registrace).getTime() >= plan[poslano];
}

/**
 * `ted` a `od` jsou tu kvůli testu, produkce je nepředává. Bez nich by test
 * záležel na tom, kolikátého zrovna je — a `UPOMINKY_OD` je pevné datum.
 */
async function posliUpominky({ ted = new Date(), od = UPOMINKY_OD } = {}) {
  const [hracu, tymu, draftu] = await Promise.all([
    upominkyHracum(ted, od),
    upominkyTymum(ted, od),
    nabidkyVDraftu(ted, od),
  ]);
  return { hracu, tymu, draftu };
}

/** Hráč v týmu bez zaplacené licence. */
async function upominkyHracum(ted, od) {
  const platby = await prisma.playerPayment.findMany({
    where: {
      licStatus:       { in: ['PENDING', 'OVERDUE'] },
      upominekPoslano: { lt: PLAN_PLATBA.length },
      player: {
        teamId:    { not: null },
        userId:    { not: null },
        createdAt: { gte: od },
      },
    },
    include: {
      player: { select: { firstName: true, createdAt: true, user: { select: { email: true } } } },
    },
    take: DAVKA,
  });

  let odeslano = 0;
  for (const platba of platby) {
    if (!naRade(PLAN_PLATBA, platba.upominekPoslano, platba.player.createdAt, ted)) continue;
    const email = platba.player?.user?.email;
    if (!email) continue;

    const vysledek = await mailer.posliBezpecne(
      email,
      mailer.upominkaPlatbaMail({
        jmeno:   platba.player.firstName,
        polozky: [{ nazev: `Hráčská licence · sezóna ${platba.season}`, castka: platba.licFee }],
        castka:  platba.licFee,
        faze:    platba.upominekPoslano + 1,
      }),
      'upominka-licence',
    );

    // Počítadlo se zvyšuje i po neúspěchu. Kdyby se zvyšoval jen úspěch,
    // plná nebo neexistující schránka by znamenala pokus při každém
    // průchodu cronu donekonečna.
    await zapisOdeslani(prisma.playerPayment, platba, ted);
    if (vysledek.ok) odeslano += 1;
  }
  return odeslano;
}

/** Tým bez zaplacené registrace — píše se všem jeho vedoucím. */
async function upominkyTymum(ted, od) {
  const platby = await prisma.teamPayment.findMany({
    where: {
      status:          { in: ['PENDING', 'OVERDUE'] },
      upominekPoslano: { lt: PLAN_PLATBA.length },
      team:            { createdAt: { gte: od } },
    },
    include: {
      team: {
        select: {
          name: true, createdAt: true,
          managers: { select: { user: { select: { email: true } } } },
        },
      },
    },
    take: DAVKA,
  });

  let odeslano = 0;
  for (const platba of platby) {
    if (!naRade(PLAN_PLATBA, platba.upominekPoslano, platba.team.createdAt, ted)) continue;

    const adresy = (platba.team?.managers ?? []).map(m => m.user?.email).filter(Boolean);
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
          faze:   platba.upominekPoslano + 1,
        }),
        'upominka-registrace',
      );
      if (vysledek.ok) odeslano += 1;
    }

    await zapisOdeslani(prisma.teamPayment, platba, ted);
  }
  return odeslano;
}

/**
 * Hráč bez týmu — nabídka, ne upomínka.
 *
 * Posílá se, jen dokud nemá zaplacený balík ani licenci. Kdo si Virtuálního
 * vedoucího koupil, čeká na zařazení do týmu a psát mu „pořád jsi v draftu"
 * by bylo matoucí.
 */
async function nabidkyVDraftu(ted, od) {
  const platby = await prisma.playerPayment.findMany({
    where: {
      licStatus:       { in: ['PENDING', 'OVERDUE'] },
      upominekPoslano: { lt: PLAN_DRAFT.length },
      player: {
        teamId:    null,
        userId:    { not: null },
        createdAt: { gte: od },
      },
    },
    include: {
      player: { select: { firstName: true, createdAt: true, user: { select: { email: true } } } },
    },
    take: DAVKA,
  });

  let odeslano = 0;
  for (const platba of platby) {
    if (!naRade(PLAN_DRAFT, platba.upominekPoslano, platba.player.createdAt, ted)) continue;
    const email = platba.player?.user?.email;
    if (!email) continue;

    const vysledek = await mailer.posliBezpecne(
      email,
      mailer.nabidkaVstupuMail({
        jmeno: platba.player.firstName,
        faze:  platba.upominekPoslano + 1,
      }),
      'nabidka-vstupu',
    );

    await zapisOdeslani(prisma.playerPayment, platba, ted);
    if (vysledek.ok) odeslano += 1;
  }
  return odeslano;
}

function zapisOdeslani(model, platba, ted) {
  return model.update({
    where: { id: platba.id },
    data:  { upominkaAt: ted, upominekPoslano: platba.upominekPoslano + 1 },
  });
}

module.exports = { posliUpominky, PLAN_PLATBA, PLAN_DRAFT, UPOMINKY_OD };
