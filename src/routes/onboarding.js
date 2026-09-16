/**
 * Měření trychtýře přihlášky — kde lidé v registraci odpadávají.
 *
 * 16. 9. 2026: za 24 hodin otevřelo `/registrace` 192 lidí a odeslaná přihláška
 * z toho nebyla ani jedna. Síťové logy Railway ukázaly, že na registrační cesty
 * nepřišel **jediný POST** — nikdo tedy nespadl na chybě ani na validaci, lidé
 * odcházeli někde uvnitř formuláře. Kde přesně, nešlo zjistit: krok je v `?krok=`
 * a Vercel Analytics na plánu Hobby dotaz nerozlišuje.
 *
 * Web sem proto hlásí každý krok, na který se člověk dostal. **Nic z formuláře
 * se neposílá** — jen náhodné id průchodu, role, krok a příznak zkrácené cesty.
 * Kdo sem začne posílat cokoli vyplněného, udělá z anonymní telemetrie sbírku
 * osobních údajů se vším, co k tomu patří.
 *
 * Bez přihlášení, schválně: měří se právě ti, kdo účet ještě nemají.
 */

const express = require('express');

const router = express.Router();
const prisma = require('../lib/prisma');

/** Slugy kroků, jak je zná `registrace/onboarding-client.tsx`. */
const KROKY = [
  'role', 'kod', 'jmeno', 'dres', 'doplnky',
  'tym', 'vzhled', 'ja', 'osobni', 'kontrola', 'hotovo',
];

const ROLE = ['player', 'manager', 'referee'];

/** Pořadí kroků v trychtýři. Mimo tenhle seznam se nic neuloží. */
const POSTUP = {
  null:     ['role'],
  player:   ['kod', 'jmeno', 'dres', 'doplnky', 'hotovo'],
  manager:  ['tym', 'vzhled', 'ja', 'hotovo'],
  referee:  ['osobni', 'kontrola', 'hotovo'],
};

/**
 * Strop na IP: 60 kroků za hodinu.
 *
 * Nejdelší cesta má pět kroků, takže tohle nepotká nikdo, kdo formulář
 * doopravdy vyplňuje — je to brzda pro robota, který by tabulku zaplevelil.
 * Stejně jako u `requests.js` je počítadlo v paměti: je to ochrana, ne účetní
 * záznam, a restart backendu ho může klidně vynulovat. **Při víc instancích
 * přestane platit** — každá si bude počítat svoje.
 */
const OKNO_MS = 60 * 60 * 1000;
const MAX_ZA_OKNO = 60;
const historie = new Map();

function prekrocenLimit(ip) {
  const ted = Date.now();
  const casy = (historie.get(ip) ?? []).filter((t) => ted - t < OKNO_MS);
  if (casy.length >= MAX_ZA_OKNO) {
    historie.set(ip, casy);
    return true;
  }
  casy.push(ted);
  historie.set(ip, casy);
  return false;
}

/** Úklid, ať mapa neroste donekonečna. */
setInterval(() => {
  const ted = Date.now();
  for (const [ip, casy] of historie) {
    const zive = casy.filter((t) => ted - t < OKNO_MS);
    if (zive.length === 0) historie.delete(ip);
    else historie.set(ip, zive);
  }
}, OKNO_MS).unref();

/**
 * POST /api/onboarding/krok
 *
 * Odpovídá vždycky 204, i když se záznam zahodí. Web tohle volá mimochodem
 * při překreslení kroku a chyba měření nesmí být vidět na přihlášce — ta je
 * to jediné, na čem tady záleží.
 */
router.post('/krok', async (req, res) => {
  res.status(204).end();

  try {
    const { navsteva, role = null, krok, bezTymu = false } = req.body ?? {};

    if (typeof navsteva !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(navsteva)) return;
    if (typeof krok !== 'string' || !KROKY.includes(krok)) return;
    if (role !== null && !ROLE.includes(role)) return;
    if (prekrocenLimit(req.ip)) return;

    await prisma.onboardingStep.create({
      data: { navsteva, role, krok, bezTymu: bezTymu === true },
    });
  } catch (err) {
    // P2002 = tenhle krok už tahle návštěva má. Návrat o krok zpět a zase
    // dopředu je normální chování člověka, ne chyba — a trychtýř by zkreslil.
    if (err?.code === 'P2002') return;
    console.error('[Onboarding] Krok se nepodařilo uložit:', err?.message ?? err);
  }
});

/**
 * GET /api/onboarding/trychtyr?hodin=24
 *
 * Kolik průchodů došlo na který krok. Veřejné schválně: jsou to holé počty bez
 * čehokoli osobního a čte je i naplánovaný status e-mail, který token nemá.
 */
router.get('/trychtyr', async (req, res, next) => {
  try {
    const hodin = Math.min(Math.max(parseInt(req.query.hodin, 10) || 24, 1), 24 * 30);
    const od = new Date(Date.now() - hodin * 60 * 60 * 1000);

    const radky = await prisma.onboardingStep.groupBy({
      by: ['role', 'krok'],
      where: { createdAt: { gte: od } },
      _count: { _all: true },
    });

    const pocet = (role, krok) => radky.find(
      (r) => r.role === role && r.krok === krok,
    )?._count?._all ?? 0;

    const trychtyr = {};
    for (const [role, kroky] of Object.entries(POSTUP)) {
      const klic = role === 'null' ? 'vyberRole' : role;
      trychtyr[klic] = kroky.map((krok) => ({
        krok,
        navstev: pocet(role === 'null' ? null : role, krok),
      }));
    }

    const navstev = await prisma.onboardingStep.findMany({
      where: { createdAt: { gte: od } },
      distinct: ['navsteva'],
      select: { navsteva: true },
    });

    res.json({ od, hodin, navstev: navstev.length, trychtyr });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
