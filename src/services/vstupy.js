/**
 * Nezaplacený vstup do otevřeného týmu — po 72 hodinách se místo uvolní.
 *
 * ── Proč to tu je ───────────────────────────────────────────────────────
 * Otevřený tým se skládá na počet: dokud někdo drží místo a nezaplatil
 * vstupní balík, tým kvůli němu nemá kompletní soupisku a nikdo jiný to
 * místo nedostane. Čekat na takového člověka měsíc jako u upomínek nejde —
 * tím by se rozpadla celá logika skládání týmů před losem.
 *
 * ── Čím se to liší od „nikomu se nevyhrožuje smazáním" ──────────────────
 * Pravidlo z `upominky.js` platí dál a tohle ho neruší, protože **se nic
 * nemaže**. Hráč zůstane v systému se vším, co má; jen přestane držet místo
 * v týmu. Balík mu zůstává v košíku, takže po zaplacení ho supervisor
 * zařadí zpátky — a přesně tohle musí stát i v obou e-mailech.
 *
 * **Riziko, které z toho zbývá, je platba převodem.** Peníze dorazí za den
 * dva a párování z Fia běží v denním cyklu, takže se může stát, že se místo
 * uvolní člověku, který už zaplatil, jen to ještě nedorazilo. Proto je
 * lhůta 72 hodin (ne 24) a proto je krok vratný.
 *
 * ── Pojistky ────────────────────────────────────────────────────────────
 *   · jen `Team.isOpen` — klubovým týmům do soupisky nikdo nesahá,
 *   · kdo za tým **nastoupil**, se neodebírá nikdy (statistiky, play-off),
 *   · zaplacený `OpenEntry` samozřejmě ne,
 *   · běží jen v denním okně upomínek, takže nikoho neodhlásíme ve tři ráno
 *     a e-mail o tom nepřistane v noci. Lhůta se tím fakticky prodlouží
 *     nejvýš o dopoledne, což je na stranu hráče.
 *
 * Opakovaným zařazením se lhůta počítá znovu — `TeamRoster` vznikne nový,
 * takže `createdAt` je nové. Žádné další počítadlo na to není potřeba.
 */

const prisma  = require('../lib/prisma');
const mailer  = require('./mailer');
const licence = require('./licence');

const HODINA = 60 * 60 * 1000;

/** Kolik času má hráč na zaplacení vstupního balíku. */
const LHUTA = 72 * HODINA;

/** Strop na jeden průchod — brzda, ne cíl. */
const DAVKA = 100;

/**
 * `ted` a `lhuta` jsou kvůli testu, produkce je nepředává.
 */
async function uvolniNezaplacenaMista({ ted = new Date(), lhuta = LHUTA } = {}) {
  const hranice = new Date(ted.getTime() - lhuta);

  const soupisky = await prisma.teamRoster.findMany({
    where:   { createdAt: { lt: hranice }, team: { isOpen: true } },
    include: {
      team:   { select: { id: true, name: true } },
      player: { select: { id: true, firstName: true, teamId: true, userId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take:    DAVKA,
  });

  let uvolneno = 0;

  for (const radek of soupisky) {
    const hrac = radek.player;
    // Mezitím ho někdo přesunul jinam — tenhle řádek pak řeší ten tým,
    // ne my.
    if (!hrac || hrac.teamId !== radek.teamId) continue;

    const vstup = await prisma.openEntry.findUnique({
      where: { playerId_season: { playerId: hrac.id, season: radek.season } },
    });
    if (vstup?.status === 'PAID') continue;

    // Kdo za tým nastoupil, se neodebírá — na odehraných zápasech stojí
    // statistiky i nárok na play-off. Stejné pravidlo jako u odchodu
    // z týmu ve Správě hráčů.
    const starty = await licence.startyPodleTymu(hrac.id, radek.season);
    if ((starty.get(radek.teamId) ?? 0) > 0) continue;

    await licence.odebratZeSoupisky(hrac.id, radek.teamId, radek.season);
    await prisma.player.update({ where: { id: hrac.id }, data: { teamId: null } });
    uvolneno += 1;

    console.log(
      `[vstupy] ${radek.team.name}: uvolněno místo hráče ${hrac.id} — `
      + `vstupní balík nezaplacen do ${Math.round(lhuta / HODINA)} h`,
    );

    if (!hrac.userId) continue;

    // Částka se bere z košíku, ne z ceníku — je to to, co tam člověk vidí.
    const polozka = await prisma.cartItem.findFirst({
      where:  { kind: 'OPEN_ENTRY', playerId: hrac.id, cart: { status: 'PENDING' } },
      select: { amount: true },
    });

    try {
      const { createNotification } = require('../routes/notifications');
      await createNotification(
        hrac.userId,
        'Uvolnili jsme tvoje místo',
        `Za tým ${radek.team.name} nedorazila platba, tak jsme místo uvolnili. Po zaplacení tě zařadíme zpátky.`,
        'platby',
      );
    } catch (err) {
      console.error('[vstupy] Oznámení se nepodařilo vytvořit:', err.message);
    }

    const ucet = await prisma.user.findUnique({
      where: { id: hrac.userId }, select: { email: true },
    });
    await mailer.posliBezpecne(
      ucet?.email,
      mailer.uvolneneMistoMail({
        jmeno:  hrac.firstName,
        tym:    radek.team.name,
        castka: polozka?.amount,
        hodin:  Math.round(lhuta / HODINA),
      }),
      'uvolněné místo',
    );
  }

  return uvolneno;
}

module.exports = { uvolniNezaplacenaMista, LHUTA, HODINA };
