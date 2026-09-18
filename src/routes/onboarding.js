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
const metaCapi = require('../utils/metaCapi');

/* Seznamy platných kroků, rolí a odchodů — a taky samotný výpočet
   trychtýře — žijí od 18. 9. 2026 v `services/trychtyr.js`. Potřebuje je
   i status e-mail, který si backend posílá sám, a dvě kopie téhož výpočtu
   by se při první úpravě rozešly. */
const {
  KROKY, ROLE, ODCHODY, spocitejTrychtyr,
} = require('../services/trychtyr');

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
// 120, ne 60: od 16. 9. večer posílá web na každý krok dva požadavky --
// příchod (`/krok`) a odchod (`/konec`). Strop zůstal stejně velkoryse nad
// nejdelší cestou, je to brzda pro robota, ne kvóta pro člověka.
const MAX_ZA_OKNO = 120;
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
 * POST /api/onboarding/konec
 *
 * Dopíše k už zapsanému kroku, **jak dlouho na něm člověk byl a jak odešel**.
 * Web to posílá jednou, při opuštění kroku.
 *
 * Proč to existuje: trychtýř uměl říct „ze 167 lidí šel dál 21", ale ne jestli
 * těch 146 odešlo do dvou sekund (nechtěný proklik z reklamy), nebo si obrazovku
 * přečetli a stejně nekliknuli (špatná obrazovka). To jsou dvě úplně různé
 * diagnózy a každá se opravuje jinde.
 *
 * `sekundy: null` v podmínce znamená **první slovo platí**: když se stránka
 * vrátí z bfcache a odejde podruhé, druhý odchod se zahodí. Jinak by se čas
 * čtení přepsal časem, kdy se člověk jen mihl zpátky.
 *
 * Odpovídá vždycky 204, ze stejného důvodu jako `/krok`.
 */
router.post('/konec', async (req, res) => {
  res.status(204).end();

  try {
    const { navsteva, krok, sekundy, odchod = null, scroll, vyskaOkna } = req.body ?? {};

    if (typeof navsteva !== 'string' || !/^[0-9a-f-]{16,64}$/i.test(navsteva)) return;
    if (typeof krok !== 'string' || !KROKY.includes(krok)) return;
    if (odchod !== null && !ODCHODY.includes(odchod)) return;
    if (prekrocenLimit(req.ip)) return;

    /** Číslo z ciziny: cokoli mimo rozsah je nesmysl a uloží se null. */
    const cislo = (v, max) => (
      typeof v === 'number' && Number.isFinite(v) && v >= 0
        ? Math.min(Math.round(v), max)
        : null
    );

    await prisma.onboardingStep.updateMany({
      where: { navsteva, krok, sekundy: null },
      data: {
        sekundy: cislo(sekundy, 3600),
        odchod,
        scroll: cislo(scroll, 100),
        vyskaOkna: cislo(vyskaOkna, 10000),
      },
    });
  } catch (err) {
    console.error('[Onboarding] Odchod z kroku se nepodařilo uložit:', err?.message ?? err);
  }
});

/**
 * POST /api/onboarding/meta-konverze
 *
 * Serverová kopie konverzní události pro Metu. Web sem zavolá hned po
 * dokončené přihlášce a pošle `eventId` — stejné, jaké v tu chvíli poslal
 * pixel z prohlížeče. Meta si obě spáruje a započítá jednou.
 *
 * **Proč to nejde rovnou z `players.js`, kde hráč vzniká:** backend neví, jestli
 * člověk dal souhlas s marketingovým měřením. Souhlas žije v prohlížeči a bez
 * něj se Metě posílat nesmí nic. Volá se proto odsud, z prohlížeče, který to ví.
 *
 * Co se tím získá a co ne: **blokátory reklam tuhle cestu nezastaví** (jde na
 * naši doménu, ne na `facebook.net`), takže registrace zablokovaným pixelem
 * se započítá. Před zavřením karty ještě dřív, než požadavek odejde, to
 * neochrání — web proto volá s `keepalive`.
 *
 * Odpovídá vždycky 204, ze stejného důvodu jako `/krok`: je to měření, ne
 * součást registrace, a nesmí být na přihlášce vidět.
 */
router.post('/meta-konverze', async (req, res) => {
  res.status(204).end();

  try {
    const { eventId, nazev = 'CompleteRegistration', souhlas, url, role } = req.body ?? {};

    // Bez výslovného souhlasu se nikam nic neposílá. Chybějící pole je „ne".
    if (souhlas !== true) return;
    if (typeof eventId !== 'string' || !/^[\w-]{8,64}$/.test(eventId)) return;
    if (nazev !== 'CompleteRegistration' && nazev !== 'Lead') return;
    if (prekrocenLimit(req.ip)) return;

    // `_fbp` a `_fbc` si pixel ukládá jako cookie na naší doméně, takže
    // dorazí samy. Když souhlas není, nejsou — a to je v pořádku.
    const cookies = req.headers.cookie ?? '';
    const zCookie = (jmeno) => {
      const m = cookies.match(new RegExp('(?:^|; )' + jmeno + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : undefined;
    };

    await metaCapi.posli({
      nazev,
      eventId,
      url: typeof url === 'string' && url.startsWith('https://') ? url.slice(0, 500) : undefined,
      ip: req.ip,
      ua: req.headers['user-agent'],
      fbp: zCookie('_fbp'),
      fbc: zCookie('_fbc'),
      vlastni: typeof role === 'string' && ROLE.includes(role) ? { content_category: role } : undefined,
    });
  } catch (err) {
    console.error('[Onboarding] Konverzi se nepodařilo poslat Metě:', err?.message ?? err);
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
    res.json(await spocitejTrychtyr(req.query.hodin));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
