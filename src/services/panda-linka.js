/**
 * První linka — co se stane, když někdo napíše Pandě.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 4.
 *
 * Pořadí je celá podstata:
 *
 *   1. **Zpráva jen s obrázkem** → člověk. Panda obrázky nečte a hádat, co
 *      je na screenshotu, je ten nejrychlejší způsob, jak odpovědět mimo.
 *   2. **Tvrdý seznam** (peníze, spor, zranění, výjimka, osobní údaje, jiný
 *      hráč, trest, média, „chci člověka") → člověk. Sem se model neptá ani
 *      v E2: trefa znamená eskalaci, i kdyby odpověď v ceníku stála.
 *   3. **Znalost s dostatečnou jistotou** → odpoví a vlákno nikoho nečeká.
 *   4. **Jazykový model**, pokud je zapnutý, dostane tytéž znalosti jako
 *      podklad a smí z nich odpovědět na otázku, kterou porovnávání slov
 *      netrefilo. Nesmí ale nic přidat — hlídá se to zvlášť, viz
 *      `panda-model.js`. Bez klíče se tenhle krok přeskočí.
 *   5. **Cokoli jiného** → člověk. Nevědět je dovolené, vymýšlet ne.
 *
 * **Model je až čtvrtý, a to je celý vtip.** Běží až za tvrdým seznamem,
 * takže se k penězům, sporu ani trestu nedostane, ať se splete jakkoli.
 *
 * **Jedna odchylka od zadání, vědomá.** V zadání stojí „dokud konverzace
 * čeká, Panda mlčí". Platí to na slib („předala jsem to lize") — ten se
 * neopakuje a termín se neposouvá. **Na odpovědi to neplatí:** když se
 * člověk mezitím zeptá na něco, co Panda umí, odpoví. Mlčet na dotaz na
 * ceník jen proto, že se čeká na něco jiného, vypadá zvenčí jako rozbitá
 * appka — což byla první věc, které si Taby všiml.
 */

const prisma = require('../lib/prisma');
const chat = require('./chat');
const znalosti = require('./panda-znalosti');
const model = require('./panda-model');
const { createNotifications } = require('../routes/notifications');

/* ───────────────────────────── termín slovy ────────────────────────────── */

const CASTI_DNE = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', weekday: 'long', day: 'numeric', month: 'numeric',
});

/** 0 = neděle. Akuzativ, protože se to pojí s „v" / „ve". */
const DNY = ['neděli', 'pondělí', 'úterý', 'středu', 'čtvrtek', 'pátek', 'sobotu'];

/**
 * „ve středu 23. 9." — termín se říká dnem, ne datem v závorce.
 *
 * Předložka se mění: **ve** středu a **ve** čtvrtek, jinak **v**. Bez toho
 * z Pandy leze „ozve se ti nejpozději středa 23. 9.", což nikdo nenapíše.
 */
function vDen(d) {
  const casti = Object.fromEntries(
    CASTI_DNE.formatToParts(new Date(d)).map(({ type, value }) => [type, value]),
  );
  const index = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota']
    .indexOf(String(casti.weekday).toLowerCase());
  const nazev = DNY[index] ?? String(casti.weekday);
  const predlozka = nazev === 'středu' || nazev === 'čtvrtek' ? 've' : 'v';
  return `${predlozka} ${nazev} ${casti.day}. ${casti.month}.`;
}

/* ─────────────────────────────── rozhodnutí ────────────────────────────── */

/**
 * Co s tou zprávou? Čisté rozhodování bez databáze — jde otestovat
 * v `npm run test:chat`.
 *
 * @returns {{akce: 'ODPOVED'|'ESKALACE', kategorie: string, duvod: string,
 *            odpoved?: string, zdroj?: string, ruleHit?: string}}
 */
function rozhodni({ text = '', maPrilohu = false } = {}) {
  const cisty = String(text ?? '').trim();

  if (!cisty && maPrilohu) {
    return {
      akce: 'ESKALACE', kategorie: 'priloha',
      duvod: 'zpráva je jen obrázek — Panda obrázky nečte',
    };
  }

  if (znalosti.jenPozdrav(cisty)) {
    return {
      akce: 'ODPOVED', kategorie: 'pozdrav', duvod: 'samotný pozdrav',
      odpoved: 'Ahoj! Napiš, s čím potřebuješ pomoct — termíny, ceník, přihlášení na zápas. '
        + 'Co nezvládnu, předám lize.',
      zdroj: null,
    };
  }

  const tvrda = znalosti.tvrdaTrefa(cisty);
  if (tvrda) {
    return {
      akce: 'ESKALACE', kategorie: tvrda.kategorie, ruleHit: tvrda.ruleHit,
      duvod: `tvrdý seznam: ${tvrda.kategorie}`,
    };
  }

  const znalost = znalosti.najdi(cisty);
  if (znalost) {
    return {
      akce: 'ODPOVED', kategorie: znalost.klic,
      duvod: `znalost ${znalost.klic} (${znalost.body} b.)`,
      odpoved: znalost.odpoved, zdroj: znalost.zdroj,
    };
  }

  return {
    akce: 'ESKALACE', kategorie: 'nezatrideno',
    duvod: 'žádná znalost nesedí dost jistě',
  };
}

/**
 * Text, který jde do chatu.
 *
 * **Zdroj je vidět** — na něm stojí důvěra a hráč si může ověřit, odkud to
 * Panda má. A **cesta k člověku je v každé odpovědi**: odpověď od stroje,
 * ze které není úniku, je horší než žádná.
 */
function textOdpovedi({ odpoved, zdroj }) {
  const patka = zdroj
    ? `— ${zdroj} · když to nesedí, napiš „předej to lize" a pošlu to člověku.`
    : 'Když to bude na ligu, napiš „předej to lize" a pošlu to člověku.';
  return `${odpoved}\n\n${patka}`;
}

/** Text slibu. Termín je konkrétní den, ne „brzy". */
function textEskalace(dueAt) {
  return `Tohle za ligu rozhodnout nemůžu, tak jsem to předala dál. Ozve se ti nejpozději ${vDen(dueAt)}.`;
}

/* ────────────────────────────── obsluha ────────────────────────────────── */

/**
 * Zpracuje zprávu, která přišla Pandě, a zapíše, co z toho vyšlo.
 *
 * Volá se ze dvou míst — z `POST /support/message` (první zpráva, vlákno
 * ještě nemusí existovat) a z `POST /chat/conversations/:id/messages`
 * (doptávání se ve vlákně, které už je). Proto je to služba, ne kus routy:
 * dvě kopie téhle úvahy by se za měsíc rozešly.
 *
 * @param {object} p
 * @param {object} p.konverzace  vlákno podpory
 * @param {object} p.hrac        kdo píše (majitel vlákna)
 * @param {string} p.text        text zprávy
 * @param {string} p.zpravaId    id právě uložené zprávy — do auditu
 * @param {boolean} p.maPrilohu
 */
async function obsluz({ konverzace, hrac, text, zpravaId = null, maPrilohu = false }) {
  let rozhodnuti = rozhodni({ text, maPrilohu });

  // Model dostane slovo jen tam, kde porovnávání slov nic nenašlo — tedy
  // nikdy u tvrdého seznamu a nikdy u zprávy jen s obrázkem.
  if (rozhodnuti.kategorie === 'nezatrideno' && model.dostupny()) {
    const odModelu = await model.zeptejSe(text);
    if (odModelu) {
      rozhodnuti = {
        akce: 'ODPOVED',
        kategorie: odModelu.klic || 'model',
        duvod: `model odpověděl z podkladu ${odModelu.klic || 'neurčeno'}`,
        odpoved: odModelu.odpoved,
        zdroj: 'Pravidla a ceník FSL',
        zdrojDat: 'model',
      };
    }
  }
  const jmeno = `${hrac.firstName ?? ''} ${hrac.lastName ?? ''}`.trim() || 'Hráč';

  // Audit má dvě vrstvy a obě jsou k něčemu jinému. `PandaAction` drží, co
  // Panda **viděla** — včetně textu, kvůli pozdějšímu sporu. `TriageLog`
  // drží jen **jak se rozhodla**, zato v podobě, ze které jde po měsíci
  // spočítat, jestli se eskaluje moc, nebo málo.
  const zapisAudit = async (vysledek) => {
    await prisma.pandaAction.create({
      data: {
        kind: 'triage',
        playerId: hrac.id ?? null,
        input: { text: String(text ?? '').slice(0, 500), maPrilohu },
        result: { ...rozhodnuti, odpoved: undefined, ...vysledek },
        ok: true,
      },
    }).catch(() => {});
    // Otazník je tu schválně: dokud se po nasazení nepustí `prisma generate`,
    // klient tyhle modely nezná a bez něj by spadla celá zpráva.
    await prisma.triageLog?.create({
      data: {
        playerId: hrac.id ?? null,
        messageId: zpravaId,
        category: rozhodnuti.kategorie,
        handled: rozhodnuti.akce === 'ODPOVED',
        ruleHit: rozhodnuti.ruleHit ?? null,
        source: rozhodnuti.akce === 'ODPOVED' ? (rozhodnuti.zdrojDat ?? 'znalosti') : null,
      },
    }).catch(() => {});
  };

  if (rozhodnuti.akce === 'ODPOVED') {
    const zprava = await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: chat.PANDA,
        class: 'PROVOZNI',
        body: textOdpovedi(rozhodnuti),
      },
    });
    await prisma.conversation.update({
      where: { id: konverzace.id },
      data: { lastMessageAt: zprava.createdAt },
    });
    await zapisAudit({ messageId: zprava.id });
    return { ...rozhodnuti, zpravaId: zprava.id, dueAt: null };
  }

  // Eskalace. Když už se na něco čeká, termín se **neposouvá** a slib se
  // neopakuje — jinak by se dvěma dotazy dal termín posunout doufinit.
  const jizCeka = Boolean(konverzace.waitingSupervisor && konverzace.dueAt);
  const dueAt = jizCeka ? konverzace.dueAt : chat.konecDalsihoDne();

  await prisma.conversation.update({
    where: { id: konverzace.id },
    data: {
      lastMessageAt: new Date(),
      waitingSupervisor: true,
      dueAt,
      escalCategory: rozhodnuti.kategorie,
      escalReason: rozhodnuti.duvod,
      overdueNotifiedAt: null,
    },
  });

  let slib = null;
  if (!jizCeka) {
    slib = await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: chat.PANDA,
        class: 'PROVOZNI',
        body: textEskalace(dueAt),
      },
    });
    await prisma.conversation.update({
      where: { id: konverzace.id },
      data: { lastMessageAt: slib.createdAt },
    });
  }

  // Supervisoři to musí vidět hned — tohle je jejich fronta.
  const supervisori = await prisma.user.findMany({
    where: { isSupervisor: true }, select: { id: true },
  });
  await createNotifications(supervisori.map(u => ({
    userId: u.id,
    title: 'Nová zpráva pro ligu',
    body: `${jmeno}: ${String(text ?? '').slice(0, 100)}`,
    screen: 'chat',
  })));

  // Historie eskalací. Příznak na konverzaci říká jen „něco čeká" — tohle
  // je to, z čeho se dá po sezóně říct, jak liga odpovídala.
  await prisma.supportEscalation?.create({
    data: {
      conversationId: konverzace.id,
      playerId: hrac.id ?? null,
      messageId: zpravaId,
      category: rozhodnuti.kategorie,
      reason: rozhodnuti.duvod,
      dueAt,
    },
  }).catch(() => {});

  await zapisAudit({ messageId: slib?.id ?? null, dueAt, jizCekalo: jizCeka });
  return { ...rozhodnuti, zpravaId: slib?.id ?? null, dueAt, puvodniZprava: zpravaId };
}

module.exports = { rozhodni, obsluz, vDen, textOdpovedi, textEskalace };
