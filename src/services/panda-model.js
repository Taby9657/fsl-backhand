/**
 * Jazykový model pro Pandu — vrstva, která smí jenom přeformulovat.
 *
 * Zadání: `fsl-panda-ai-zadani-2026-09-21.md`, oddíl 8.2 a 8.3.
 *
 * **Model nikdy nerozhoduje o tom, co se eskaluje.** Tvrdý seznam běží před
 * ním a jeho trefa je konečná; model dostane slovo teprve u dotazů, na které
 * deterministická vrstva nenašla odpověď. Tím je jedno, jak se model splete
 * — na peníze, spor ani trest se nedostane.
 *
 * **Model nemá jiný zdroj než znalosti.** Do promptu jde celý obsah
 * `panda-znalosti.js` a instrukce zní: odpověz jen z toho, co je níž, jinak
 * řekni, že to nestačí. Model tu není od vědění, je od formulace.
 *
 * **Když cokoli selže, není to chyba.** Chybějící klíč, timeout, špatný
 * JSON, neprojitá kontrola — všechno vrací `null` a volající eskaluje jako
 * dřív. Panda musí fungovat i bez modelu, protože klíč jednou vyprší.
 *
 * Zapíná se proměnnou `ANTHROPIC_API_KEY` na Railway; `PANDA_MODEL` volí
 * model. Dokud klíč není, tenhle soubor nic nedělá.
 */

const znalosti = require('./panda-znalosti');

const URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.PANDA_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.PANDA_TIMEOUT_MS || 8000);
const STROP_ZNAKU = 700;

/** Hlásí se jednou, ne při každé zprávě — jinak by log utekl. */
let uzHlaseno = false;
function jednouDoLogu(zprava) {
  if (uzHlaseno) return;
  uzHlaseno = true;
  console.error(`Panda: ${zprava} — jedu na šablony.`);
}

function dostupny() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Všechno, co Panda ví, jako text do promptu. */
function kontext() {
  return znalosti.ZNALOSTI
    .map(z => `[${z.klic}] ${z.odpoved()}\n(zdroj: ${z.zdroj})`)
    .join('\n\n');
}

const INSTRUKCE = `Jsi Panda, první linka florbalové ligy FSL. Píšeš česky, krátce a věcně, bez nadšení a bez emodži. Tykáš.

Odpovídáš VÝHRADNĚ z podkladů níž. Nic nedomýšlíš, nic nedopočítáváš, nic nezobecňuješ. Když odpověď v podkladech není — i kdybys ji věděla odjinud — vrátíš staci:false.

Vrať staci:false vždycky, když:
- jde o konkrétní platbu, spor, zranění, trest, výjimku nebo jiného člověka,
- odpověď by potřebovala údaj, který v podkladech není,
- si nejsi jistá.

Odpověz JSON objektem a ničím jiným: {"staci": true, "odpoved": "...", "klic": "..."} nebo {"staci": false}.
"klic" je název podkladu v hranatých závorkách, ze kterého odpověď je.
"odpoved" má nejvýš tři věty a neobsahuje telefonní čísla ani data narození.

PODKLADY:
`;

/**
 * Kontrola před odesláním — bez modelu, protože kontrolovat model modelem
 * nedává smysl.
 *
 * Projde jen text, který **nepřidal žádné číslo**: každá částka v odpovědi
 * musí stát i v podkladech. Tohle je jediná pojistka proti tomu, aby Panda
 * někomu řekla cenu, kterou si vymyslela.
 */
function zkontroluj(odpoved, podklady) {
  const text = String(odpoved ?? '').trim();
  if (!text || text.length > STROP_ZNAKU) return null;

  // Telefon a datum narození do chatu s ligou nepatří (zadání, oddíl 8.2).
  if (/\+?\d[\d  ]{8,}/.test(text)) return null;
  if (/\d{1,2}\.\s?\d{1,2}\.\s?(19|20)\d\d/.test(text)) return null;

  const cislo = s => s.replace(/[\s ]/g, '');
  const vPodkladech = new Set((podklady.match(/\d[\d\s ]*(?=\s?Kč)/g) ?? []).map(cislo));
  const vOdpovedi = (text.match(/\d[\d\s ]*(?=\s?Kč)/g) ?? []).map(cislo);
  if (vOdpovedi.some(c => !vPodkladech.has(c))) return null;

  return text;
}

/**
 * Zeptá se modelu. Vrací `{ odpoved, klic }`, nebo `null` — a `null` je
 * úplně v pořádku, volající pak eskaluje.
 */
async function zeptejSe(dotaz) {
  if (!dostupny()) return null;

  const podklady = kontext();
  const prerus = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  try {
    const odpoved = await fetch(URL, {
      method: 'POST',
      signal: prerus,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,
        system: INSTRUKCE + podklady,
        messages: [{ role: 'user', content: String(dotaz ?? '').slice(0, 1000) }],
      }),
    });

    if (!odpoved.ok) {
      jednouDoLogu(`model odmítl (HTTP ${odpoved.status}, model "${MODEL}")`);
      return null;
    }

    const data = await odpoved.json();
    const text = data?.content?.find(c => c.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const vysledek = JSON.parse(json);

    if (!vysledek?.staci) return null;

    const cisty = zkontroluj(vysledek.odpoved, podklady);
    if (!cisty) return null;

    return { odpoved: cisty, klic: vysledek.klic ?? null };
  } catch (e) {
    jednouDoLogu(`model nedostupný (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
    return null;
  }
}

module.exports = { dostupny, zeptejSe, zkontroluj, kontext, MODEL };
