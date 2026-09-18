/**
 * Trychtýř přihlášky — jedno místo, které umí spočítat, kde lidé odpadávají.
 *
 * **Proč to není v `routes/onboarding.js`, kde to vzniklo:** od 18. 9. 2026
 * ta samá čísla potřebuje i status e-mail, který si backend posílá sám
 * (`services/statusNaboru.js`). Dvě kopie výpočtu mediánu a časů by se
 * rozešly při první úpravě a nikdo by si toho nevšiml — čísla by seděla
 * v e-mailu a neseděla v API, nebo naopak.
 *
 * Route si odsud bere i seznamy pro validaci, takže „co je platný krok"
 * je taky jen na jednom místě.
 */

const prisma = require('../lib/prisma');

/** Slugy kroků, jak je zná `registrace/onboarding-client.tsx`. */
const KROKY = [
  'role', 'kod', 'jmeno', 'dres', 'doplnky', 'draft',
  'tym', 'vzhled', 'ja', 'osobni', 'kontrola', 'hotovo',
  // Ne krok, ale klik: viz ODKAZY níž.
  'jak-funguje',
];

const ROLE = ['player', 'manager', 'referee'];

/** Jak člověk krok opustil. Mimo tenhle seznam se nic neuloží. */
const ODCHODY = ['klik', 'jinam', 'zavrel'];

/** Pořadí kroků v trychtýři. Mimo tenhle seznam se nic neuloží. */
const POSTUP = {
  null:     ['role'],
  player:   ['kod', 'jmeno', 'dres', 'doplnky', 'draft', 'hotovo'],
  manager:  ['tym', 'vzhled', 'ja', 'hotovo'],
  referee:  ['osobni', 'kontrola', 'hotovo'],
};

/**
 * Kliknutí, která se zapisují do téže tabulky, ale **nejsou krokem v cestě**.
 *
 * `jak-funguje` = odkaz „Nevíš, co vybrat? Jak liga funguje" na obrazovce
 * výběru role. Bez něj se o odchodu vědělo jen `odchod: 'jinam'`, což je
 * „odešel někam jinam na web" a nerozliší člověka, který si šel přečíst
 * formát soutěže, od člověka, který odešel pryč.
 *
 * Kdo sem přidá další odkaz, ať ho přidá i do `KROKY` a do `POSTUP` **ne** —
 * jinak se objeví v trychtýři jako krok, kterým není.
 */
const ODKAZY = ['jak-funguje'];

function median(cisla) {
  if (!cisla.length) return null;
  const s = [...cisla].sort((a, b) => a - b);
  const p = Math.floor(s.length / 2);
  return s.length % 2 ? s[p] : Math.round((s[p - 1] + s[p]) / 2);
}

/**
 * Trychtýř za posledních `hodin` hodin.
 *
 * Vrací přesně to, co `GET /api/onboarding/trychtyr` posílá ven — ten
 * endpoint je od 18. 9. 2026 jen tenká slupka nad touhle funkcí.
 */
async function spocitejTrychtyr(hodin = 24) {
  const h = Math.min(Math.max(parseInt(hodin, 10) || 24, 1), 24 * 30);
  const od = new Date(Date.now() - h * 60 * 60 * 1000);

  const radky = await prisma.onboardingStep.groupBy({
    by: ['role', 'krok'],
    where: { createdAt: { gte: od } },
    _count: { _all: true },
  });

  const pocet = (role, krok) => radky.find(
    (r) => r.role === role && r.krok === krok,
  )?._count?._all ?? 0;

  /* Časy na krocích. Bere se to jedním dotazem a počítá v paměti: řádků je
     řádově stovky za den a medián `groupBy` neumí. */
  const merene = await prisma.onboardingStep.findMany({
    where: { createdAt: { gte: od }, sekundy: { not: null } },
    select: { role: true, krok: true, sekundy: true, scroll: true, odchod: true },
  });

  /**
   * Hranice 3 a 10 sekund nejsou nastavené od oka: do tří sekund člověk
   * obrazovku nepřečte, takže je to nechtěný proklik; nad deset už četl
   * a rozhodl se odejít. Mezi tím je šedá zóna, která se schválně nevykazuje
   * jako ani jedno.
   */
  const casy = (role, krok) => {
    const vybrane = merene.filter((r) => r.role === role && r.krok === krok);
    if (!vybrane.length) return null;
    const sekundy = vybrane.map((r) => r.sekundy);
    const odchody = { klik: 0, jinam: 0, zavrel: 0, nevime: 0 };
    for (const r of vybrane) odchody[r.odchod ?? 'nevime'] += 1;
    return {
      mereno: vybrane.length,
      median: median(sekundy),
      do3s: sekundy.filter((x) => x <= 3).length,
      nad10s: sekundy.filter((x) => x > 10).length,
      medianScroll: median(vybrane.map((r) => r.scroll).filter((x) => x !== null)),
      odchody,
    };
  };

  const trychtyr = {};
  for (const [role, kroky] of Object.entries(POSTUP)) {
    const klic = role === 'null' ? 'vyberRole' : role;
    const r = role === 'null' ? null : role;
    trychtyr[klic] = kroky.map((krok) => ({
      krok,
      navstev: pocet(r, krok),
      casy: casy(r, krok),
    }));
  }

  /* Kliky na odkazy se do počtu průchodů nezapočítávají. Dneska by to
     vyšlo nastejno — na „Jak liga funguje" se dá kliknout jedině
     z obrazovky výběru role, kde tentýž průchod už řádek `role` má —
     ale platí to jen do chvíle, než tenhle způsob měření někdo použije
     na stránce mimo přihlášku. Pak by `navstev` tiše narostlo a status
     e-mail by hlásil průchody přihláškou, které se nestaly. */
  const navstev = await prisma.onboardingStep.findMany({
    where: { createdAt: { gte: od }, krok: { notIn: ODKAZY } },
    distinct: ['navsteva'],
    select: { navsteva: true },
  });

  /* Odkazy stojí vedle trychtýře, ne v něm: jsou to kliky, ne kroky, a
     kdyby se přimíchaly mezi kroky, četly by se jako místo v cestě. */
  const odkazy = Object.fromEntries(
    ODKAZY.map((krok) => [krok, pocet(null, krok)]),
  );

  return { od, hodin: h, navstev: navstev.length, trychtyr, odkazy };
}

module.exports = { KROKY, ROLE, ODCHODY, POSTUP, ODKAZY, median, spocitejTrychtyr };
