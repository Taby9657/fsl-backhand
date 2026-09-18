/**
 * Status náboru — e-mail, který si backend posílá sám.
 *
 * ── Proč to dělá backend, a ne naplánovaný běh asistenta ────────────────
 * Do 18. 9. 2026 status skládal naplánovaný běh v cloudu: zavolal veřejné
 * API a napsal shrnutí. **Dvakrát za dva dny přišel prázdný** — jednou se
 * úloha vůbec nespustila, podruhé si nástroj na stahování vyžádal schválení
 * adresy, které v běhu bez člověka nemá kdo potvrdit. Status, který chodí
 * jen když u toho někdo je, není status.
 *
 * Backend má data přímo pod rukou a Resend už používá na všechno ostatní,
 * takže tady nemá co selhat: žádná síť ven kromě odeslání, žádné schvalování.
 * **Co tím naopak nezískáš, je výklad** — tenhle e-mail čísla nekomentuje
 * a nehádá, čím to je. Od toho je člověk nebo asistent nad týmiž čísly.
 *
 * ── Co se počítá do tempa ───────────────────────────────────────────────
 * **Každá dokončená registrace jakékoli role** — hráč, vedoucí (tým) i
 * rozhodčí. Tak si to majitel nastavil 18. 9. 2026. Míchá to dohromady věci
 * s různou pracností, ale odpovídá to otázce „roste liga dost rychle".
 *
 * Cíl je **5 registrací denně** a měří se proti němu průměr od začátku
 * propagace (15. 9. 2026) do uzávěrky přihlášek (1. 11. 2026).
 *
 * ── Kdy chodí ───────────────────────────────────────────────────────────
 * 8:00, 14:00 a 20:00 pražského času. Budík v `server.js` se kouká každých
 * pět minut; co se smí odeslat, rozhoduje `jeCasPoslat()` tady, aby to šlo
 * změnit na jednom místě.
 */

const prisma = require('../lib/prisma');
const { sendMail } = require('./mailer');
const { spocitejTrychtyr } = require('./trychtyr');

/**
 * Kam status chodí.
 *
 * **Schválně ne `supervisorAddress()`**, i když je to jinde v projektu
 * zavedený způsob: ta funkce čte `SUPERVISOR_EMAIL`, a kdyby ho někdo
 * někdy přepnul na soukromou schránku, odešel by tam i tenhle e-mail
 * s celou statistikou náboru. Firemní adresa je tu proto napevno jako
 * výchozí a přebít ji jde jen vědomě, vlastní proměnnou.
 */
function prijemce() {
  return process.env.STATUS_EMAIL ?? 'info@fslleague.cz';
}

/** Začátek propagace na Meta. Od tohohle dne se počítá průměr. */
const ZACATEK = new Date('2026-09-15T00:00:00+02:00');

/** Uzávěrka přihlášek. Do tohohle dne se má cíl stihnout. */
const UZAVERKA = new Date('2026-11-01T23:59:59+01:00');

/** Kolik registrací denně si majitel drží jako cíl. */
const CIL_DENNE = 5;

/** Hodiny pražského času, ve kterých status odchází. */
const SLOTY = [8, 14, 20];

const DEN_MS = 24 * 60 * 60 * 1000;

/* ==================== pražský čas ==================== */

/**
 * Railway běží v UTC, cíle i sloty jsou ale v pražském čase. Tohle je
 * jediné místo, kde se ta dvě pásma potkávají — počítá se přes `Intl`,
 * takže letní i zimní čas řeší systémová databáze časových pásem a ne
 * natvrdo napsaná konstanta, která by v říjnu přestala platit.
 */
function prazskeCasti(kdy = new Date()) {
  const f = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const d = Object.fromEntries(
    f.formatToParts(kdy).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return {
    rok: Number(d.year), mesic: Number(d.month), den: Number(d.day),
    hodina: Number(d.hour === '24' ? '0' : d.hour), minuta: Number(d.minute),
  };
}

function prazskyCas(kdy = new Date()) {
  const { hodina, minuta } = prazskeCasti(kdy);
  return `${String(hodina).padStart(2, '0')}:${String(minuta).padStart(2, '0')}`;
}

function prazskeDatum(kdy = new Date()) {
  const { rok, mesic, den } = prazskeCasti(kdy);
  return `${den}. ${mesic}. ${rok}`;
}

/**
 * Má se teď poslat?
 *
 * Ano, když je pražská hodina jedním ze slotů a od začátku toho slotu ještě
 * nic neodešlo. **Okno je celá hodina schválně:** kdyby se backend zrovna
 * v 8:00 nasazoval, ranní status by jinak vypadl úplně — takhle odejde
 * v 8:05 nebo v 8:40, jen o kousek později.
 *
 * `poslednePoslano` se čte z databáze (`Settings`), ne z paměti: restart
 * Railway je běžná věc a v paměti by se zapomnělo, že status už šel — a
 * lidem by chodily dva stejné e-maily za sebou.
 */
function jeCasPoslat(poslednePoslano, kdy = new Date()) {
  const { hodina, minuta } = prazskeCasti(kdy);
  if (!SLOTY.includes(hodina)) return false;

  /* Začátek slotu se nepočítá z UTC, ale odečtením uplynulých minut od
     „teď" — to platí ve všech pásmech i o víkendu přechodu na zimní čas,
     kdy by ruční přepočet hodin selhal. */
  const zacatek = new Date(kdy.getTime() - minuta * 60 * 1000);
  zacatek.setSeconds(0, 0);

  if (!poslednePoslano) return true;
  return new Date(poslednePoslano) < zacatek;
}

/* ==================== čísla ==================== */

/**
 * Všechno, co se do e-mailu dává. Jedna funkce schválně: kdo bude chtít
 * status někam jinam (na web, do Slacku), vezme si tohle a nebude znovu
 * skládat dotazy.
 */
async function sesbirej() {
  const ted = new Date();
  const pred24h = new Date(ted.getTime() - DEN_MS);

  const [
    tymu, hracu, hracuVDraftu, rozhodcich, hracuSLicenci,
    novychHracu, novychTymu, novychRozhodcich,
    hracuOdZacatku, tymuOdZacatku, rozhodcichOdZacatku,
    trychtyr,
  ] = await Promise.all([
    prisma.team.count(),
    prisma.player.count(),
    prisma.player.count({ where: { teamId: null } }),
    prisma.referee.count(),
    prisma.player.count({ where: { licensed: true } }),

    prisma.player.count({ where: { createdAt: { gte: pred24h } } }),
    prisma.team.count({ where: { createdAt: { gte: pred24h } } }),
    prisma.referee.count({ where: { createdAt: { gte: pred24h } } }),

    prisma.player.count({ where: { createdAt: { gte: ZACATEK } } }),
    prisma.team.count({ where: { createdAt: { gte: ZACATEK } } }),
    prisma.referee.count({ where: { createdAt: { gte: ZACATEK } } }),

    spocitejTrychtyr(24),
  ]);

  const novych24h = novychHracu + novychTymu + novychRozhodcich;
  const odZacatku = hracuOdZacatku + tymuOdZacatku + rozhodcichOdZacatku;

  /* Dny se počítají nahoru (`ceil`), aby se prvních pár hodin propagace
     nedělilo číslem blízkým nule a nevyrobilo tím nesmyslně vysoký průměr. */
  const dnuBehem = Math.max(1, Math.ceil((ted - ZACATEK) / DEN_MS));
  const dnuCelkem = Math.max(1, Math.ceil((UZAVERKA - ZACATEK) / DEN_MS));
  const dnuZbyva = Math.max(0, Math.ceil((UZAVERKA - ted) / DEN_MS));

  const prumer = odZacatku / dnuBehem;
  const cilCelkem = CIL_DENNE * dnuCelkem;
  const chybi = Math.max(0, cilCelkem - odZacatku);
  /* Kolik denně je potřeba po zbytek náboru, aby průměr za celé období
     vyšel na cíl. Když už dny došly, tempo se nedopočítává — dělit nulou
     by dalo nekonečno a to není informace. */
  const potrebaDenne = dnuZbyva > 0 ? chybi / dnuZbyva : null;

  return {
    ted,
    databaze: { tymu, hracu, hracuVDraftu, rozhodcich, hracuSLicenci },
    za24h: { hracu: novychHracu, tymu: novychTymu, rozhodcich: novychRozhodcich, celkem: novych24h },
    tempo: {
      odZacatku, dnuBehem, dnuZbyva, dnuCelkem,
      prumer, cil: CIL_DENNE, cilCelkem, chybi, potrebaDenne,
    },
    trychtyr,
  };
}

/* ==================== text ==================== */

const cislo1 = (x) => (x === null ? '—' : x.toFixed(1).replace('.', ','));

/**
 * Jeden krok trychtýře jako řádek. Kroky, na kterých nikdo nebyl, se
 * vynechávají — nula na patnácti řádcích schová ty tři, kde se něco děje.
 */
function radkyKroku(kroky) {
  return kroky
    .filter((k) => k.navstev > 0)
    .map((k) => `    ${k.krok}: ${k.navstev}`)
    .join('\n');
}

/**
 * Časy na kroku. **Pod 20 měřenými průchody se nevykládají** — na menším
 * vzorku vypadá každý poměr přesvědčivě a není. Proto se vypíšou čísla
 * a rovnou se u nich řekne, že jsou malá.
 */
function radekCasu(krok, casy) {
  if (!casy || casy.mereno === 0) return null;
  const o = casy.odchody;
  const zaklad = `  ${krok}: měřeno ${casy.mereno}, medián ${casy.median} s, `
    + `do 3 s ${casy.do3s}, nad 10 s ${casy.nad10s}\n`
    + `    odchody: klik ${o.klik}, jinam ${o.jinam}, zavřel ${o.zavrel}`;
  return casy.mereno < 20 ? `${zaklad}\n    (malý vzorek, závěr z toho nedělat)` : zaklad;
}

function telo(d) {
  const { databaze: db, za24h, tempo, trychtyr } = d;
  const role = trychtyr.trychtyr.vyberRole[0];
  const naVyberu = role?.navstev ?? 0;
  const zvolilo = role?.casy?.odchody?.klik ?? 0;
  const podil = naVyberu > 0 ? (zvolilo / naVyberu) * 100 : 0;

  const casy = [
    radekCasu('výběr role', role?.casy),
    ...['player', 'manager', 'referee'].flatMap((r) =>
      trychtyr.trychtyr[r].map((k) => radekCasu(`${r}/${k.krok}`, k.casy)),
    ),
  ].filter(Boolean);

  return `Status náboru, ${prazskeDatum(d.ted)} ${prazskyCas(d.ted)}.

REGISTRACE V DATABÁZI
  týmy ${db.tymu}, hráči ${db.hracu} (z toho ${db.hracuVDraftu} v draftu), rozhodčí ${db.rozhodcich}
  zaplacených licencí: ${db.hracuSLicenci}

NOVÉ ZA 24 H
  hráči ${za24h.hracu}, vedoucí ${za24h.tymu}, rozhodčí ${za24h.rozhodcich}
  celkem ${za24h.celkem} (cíl ${tempo.cil} denně)

TEMPO PROTI CÍLI ${tempo.cil}/DEN
  od 15. 9. celkem ${tempo.odZacatku} registrací za ${tempo.dnuBehem} dní
  průměr ${cislo1(tempo.prumer)}/den
  do 1. 11. zbývá ${tempo.dnuZbyva} dní
  k průměru ${tempo.cil}/den za celé období chybí ${tempo.chybi} registrací
  = ${cislo1(tempo.potrebaDenne)}/den po zbytek náboru

TRYCHTÝŘ PŘIHLÁŠKY (24 h)
  průchodů přihláškou: ${trychtyr.navstev}
  výběr role: ${naVyberu} → zvolilo roli ${zvolilo} (${cislo1(podil)} %)
  kliklo na „Jak liga funguje": ${trychtyr.odkazy['jak-funguje']}

  hráč:
${radkyKroku(trychtyr.trychtyr.player) || '    nikdo'}
  vedoucí:
${radkyKroku(trychtyr.trychtyr.manager) || '    nikdo'}
  rozhodčí:
${radkyKroku(trychtyr.trychtyr.referee) || '    nikdo'}

ČAS NA OBRAZOVCE
${casy.length ? casy.join('\n') : '  nic se nenaměřilo'}

NÁVŠTĚVNOST
  vercel.com/fsl12/fsl-web/analytics

Tenhle e-mail posílá backend přímo z databáze, takže čísla nekomentuje.
`;
}

/* ==================== odeslání ==================== */

/**
 * Pošle status. Vrací `{ ok, duvod }` — nikdy nevyhodí výjimku ven, protože
 * se volá z budíku a spadlý status nesmí shodit proces.
 */
async function posliStatusNaboru({ vynutit = false } = {}) {
  try {
    const nastaveni = await prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });

    if (!vynutit && !jeCasPoslat(nastaveni.statusNaboruPoslanoAt)) {
      return { ok: false, duvod: 'mimo-slot' };
    }

    const data = await sesbirej();
    const vysledek = await sendMail({
      to: prijemce(),
      subject: `FSL status — ${prazskeDatum(data.ted)} ${prazskyCas(data.ted)}`,
      text: telo(data),
    });

    /* Zapisuje se i po neúspěšném odeslání: kdyby Resend vracel chybu,
       tenhle slot se nebude zkoušet dokola každých pět minut. Že se
       neodeslalo, je vidět v logu a v Resendu. */
    await prisma.settings.update({
      where: { id: 'singleton' },
      data: { statusNaboruPoslanoAt: new Date() },
    });

    if (!vysledek.ok) {
      console.error('[Status] Odeslání selhalo:', vysledek.reason);
      return { ok: false, duvod: vysledek.reason };
    }
    console.log('[Status] Odesláno na', prijemce());
    return { ok: true };
  } catch (err) {
    console.error('[Status] Chyba:', err?.message ?? err);
    return { ok: false, duvod: err?.message ?? 'chyba' };
  }
}

module.exports = {
  posliStatusNaboru,
  prijemce,
  sesbirej,
  telo,
  jeCasPoslat,
  prazskyCas,
  prazskeDatum,
  ZACATEK,
  UZAVERKA,
  CIL_DENNE,
  SLOTY,
};
