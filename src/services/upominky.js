/**
 * Plán upomínek — co komu a kdy chodí, když po registraci nezaplatí.
 *
 * ── Plán ────────────────────────────────────────────────────────────────
 *   dva dny  →  devět dní  →  měsíc  →  ticho
 *
 * Jedna připomínka nestačila: kdo si ji přečte v práci a odloží ji na
 * večer, druhou šanci od nás nedostal. Tři jsou dost na to, aby se ozval
 * ten, kdo chce, a málo na to, aby to někoho otrávilo. **Čtvrtá už
 * nepřijde** — kdo nereagoval třikrát, nepřesvědčí ho ani čtvrtý e-mail
 * a nezaplacené přihlášky vidí supervisor ve Správě hráčů a v Týmech.
 *
 * **Do 16. 9. 2026 chodila první připomínka hodinu po registraci.** Bylo to
 * moc brzo: přistála člověku ve schránce hned za uvítacím e-mailem, který
 * říká přesně totéž, a vypadala jako upomínka za něco, co ještě nestihl
 * ani přečíst. Dva dny jsou dost na to, aby uvítání doznělo, a málo na to,
 * aby přihláška zapadla. Druhá fáze je devátý den schválně, ne sedmý —
 * jinak by obě zprávy padly na stejný den v týdnu.
 *
 * ── Komu se píše ────────────────────────────────────────────────────────
 *   · hráč v týmu bez zaplacené licence      → 2 dny, 9 dní, 30 dní
 *   · tým bez zaplacené registrace (vedoucím) → 2 dny, 9 dní, 30 dní
 *   · hráč bez týmu v draftu                  → 3 dny, 14 dní
 *
 * **Hráč bez týmu nedostává upomínku, ale nabídku.** V draftu nic nedluží:
 * licenci potřebuje, teprve až ho někdo vezme. Chodí mu proto jiná zpráva —
 * že je pořád v draftu a že nemusí čekat, když nechce (`nabidkaVstupuMail`).
 * A nechodí hned po registraci: to by přistála za uvítacím e-mailem a
 * vypadala by jako upomínka za něco, co platit nemusí.
 *
 * ── Proč se nemaže ──────────────────────────────────────────────────────
 * Hrozba „zaplať, nebo tě smažeme" by byla lež: **převodem platba dorazí za
 * den dva** a párování z Fia běží v denním cyklu, takže by se mazali lidé,
 * kteří zaplatili. Skutečná páka je věcná a stojí v pravidlech — bez
 * licence hráč nenastoupí a tým bez registrace se do soutěže nezařadí.
 *
 * **Jedna výjimka, a není to výjimka ze smazání:** kdo je zařazený do
 * otevřeného týmu a nezaplatí vstupní balík do 72 hodin, přestane držet
 * místo v soupisce (`services/vstupy.js`). Nic se mu nemaže, balík mu
 * zůstává v košíku a po zaplacení se zařadí zpátky — drží se tedy jen
 * místo, na které čeká někdo další, ne člověk.
 *
 * ── Proč se neposílá dvakrát ────────────────────────────────────────────
 * `upominekPoslano` říká, kolikátá fáze je na řadě, `upominkaAt` kdy odešla
 * poslední. **Cron je jen budík, ne frekvence psaní** — že se každou hodinu
 * kouká, jestli někomu nezačala další fáze, neznamená, že někomu každou
 * hodinu píše. Nejkratší úsek plánu jsou dva dny, takže hodinová přesnost
 * bohatě stačí.
 *
 * ── Denní okno ──────────────────────────────────────────────────────────
 * Fáze se počítá od registrace, takže kdo se přihlásil ve tři ráno, by ve
 * tři ráno dostal i připomínku. Odesílá se proto jen mezi **9:00 a 20:00
 * pražského času**; co dozraje mimo okno, počká na jeho otevření. Plán se
 * tím neposouvá — jen se nedoručuje v noci.
 */

const prisma = require('../lib/prisma');
const mailer = require('./mailer');
const vstupy = require('./vstupy');

const HODINA = 60 * 60 * 1000;
const DEN    = 24 * HODINA;

/** Za jak dlouho po registraci odchází která fáze. Délka pole = kolik jich přijde. */
const PLAN_PLATBA = [2 * DEN, 9 * DEN, 30 * DEN];

/** Hráč bez týmu dostane o jednu míň a začíná se později — nic nedluží. */
const PLAN_DRAFT = [3 * DEN, 14 * DEN];

/** Hodiny pražského času, mezi kterými se smí odesílat. */
const OKNO_OD = 9;
const OKNO_DO = 20;

const PRAZSKA_HODINA = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', hour: 'numeric', hour12: false,
});

/**
 * Je teď denní okno? Hodina se bere přes `Intl`, ne přes `getHours()` —
 * server běží v UTC a proti Praze je o hodinu (v létě o dvě) vedle.
 */
function vOkne(ted) {
  const hodina = Number(PRAZSKA_HODINA.format(ted));
  return hodina >= OKNO_OD && hodina < OKNO_DO;
}

/**
 * Odkdy se upomínky posílají.
 *
 * Bez téhle hranice by první spuštění po nasazení rozeslalo připomínky
 * zpětně — včetně lidí, kteří se přihlásili v době, kdy žádný uvítací
 * e-mail neexistoval a tohle by pro ně byla první zpráva od ligy vůbec.
 */
const UPOMINKY_OD = new Date('2026-09-16T00:00:00Z');

/**
 * Kolik jich poslat za jeden průchod. Brzda pro případ, že se něco nastřádá.
 *
 * Průchodů je od 16. 9. 2026 míň — jednou za hodinu, a jen v denním okně —
 * takže strop musí být vyšší. Jedenáct běhů po padesáti by na nápor kolem
 * uzávěrky přihlášek nestačilo.
 */
const DAVKA = 200;

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
  // Mimo okno se ani nesahá do databáze — co dozrálo, počká na ráno.
  if (!vOkne(ted)) return { hracu: 0, tymu: 0, draftu: 0, mimoOkno: true };

  const [hracu, tymu, draftu] = await Promise.all([
    upominkyHracum(ted, od),
    upominkyTymum(ted, od),
    nabidkyVDraftu(ted, od),
  ]);

  // Veze se na stejném budíku schválně: je to hodinový průchod se stejným
  // denním oknem a vlastní cron by za to nestál. Spadlé uvolňování nesmí
  // shodit rozesílku, proto `catch` — upomínky jsou důležitější.
  let uvolneno = 0;
  try {
    uvolneno = await vstupy.uvolniNezaplacenaMista({ ted });
  } catch (err) {
    console.error('[upomínky] Uvolnění nezaplacených míst selhalo:', err.message);
  }

  return { hracu, tymu, draftu, uvolneno };
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

module.exports = {
  posliUpominky, vOkne,
  PLAN_PLATBA, PLAN_DRAFT, UPOMINKY_OD, OKNO_OD, OKNO_DO,
};
