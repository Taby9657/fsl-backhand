/**
 * Conversions API Mety — serverová kopie konverzních událostí.
 *
 * Proč to existuje: `CompleteRegistration` odeslaný z prohlížeče se ztrácí.
 * Blokátory reklam skript pixelu zabijí úplně a odchozí požadavek se navíc
 * může přerušit ve chvíli, kdy se stránka po dokončení přihlášky překresluje.
 * Registrací je málo (jednotky denně) a Meta potřebuje kolem padesáti konverzí
 * týdně, aby se na ně uměla učit — každá ztracená se pozná.
 *
 * Událost se posílá **dvakrát**: jednou z prohlížeče pixelem, jednou odsud.
 * Obě nesou stejné `event_id`, takže si je Meta spáruje a započítá jednou.
 * Bez toho id by se registrace počítaly dvojmo.
 *
 * ## Souhlas
 *
 * Tohle běží **jen když web řekne, že člověk souhlasil** — backend sám
 * o souhlasu nic neví a nesmí si ho domýšlet. Volající endpoint to musí
 * ohlídat; kdo sem přidá další volání, ať to ohlídá taky.
 *
 * ## Co se posílá
 *
 * IP adresa, user agent a cookies `_fbp` / `_fbc`. **Žádné jméno, e-mail ani
 * telefon** — Meta je sice umí přijmout jako otisk, ale k párování stačí to,
 * co už o návštěvě ví z pixelu, a míň osobních údajů znamená míň slibů
 * v zásadách ochrany osobních údajů.
 *
 * ## Nastavení
 *
 * `META_PIXEL_ID` a `META_CAPI_TOKEN` v prostředí. **Bez tokenu modul tiše
 * nedělá nic** — je to volitelné vylepšení měření, ne součást registrace,
 * a chybějící token nesmí nikoho zastavit.
 */

const PIXEL_ID = process.env.META_PIXEL_ID || '';
const TOKEN = process.env.META_CAPI_TOKEN || '';
/** Testovací kód ze Správce událostí. Nechat prázdné, jakmile je ověřeno. */
const TEST_KOD = process.env.META_CAPI_TEST_KOD || '';

const VERZE_API = 'v21.0';

function nastaveno() {
  return Boolean(PIXEL_ID && TOKEN);
}

/**
 * Pošle konverzní událost. Nikdy nevyhazuje a na nic se nečeká —
 * volající pokračuje bez ohledu na výsledek.
 *
 * @param {object} p
 * @param {string} p.nazev      název události, např. `CompleteRegistration`
 * @param {string} p.eventId    stejné id, jaké poslal pixel z prohlížeče
 * @param {string} [p.url]      adresa stránky, na které se to stalo
 * @param {string} [p.ip]
 * @param {string} [p.ua]
 * @param {string} [p.fbp]      cookie `_fbp`
 * @param {string} [p.fbc]      cookie `_fbc`
 * @param {object} [p.vlastni]  doplňkové parametry události
 */
async function posli({ nazev, eventId, url, ip, ua, fbp, fbc, vlastni }) {
  if (!nastaveno()) return { preskoceno: 'chybi-nastaveni' };

  const user_data = {};
  if (ip) user_data.client_ip_address = ip;
  if (ua) user_data.client_user_agent = ua;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  // Bez jediného identifikátoru Meta událost stejně zahodí — ušetříme si
  // volání i zbytečný záznam v logu.
  if (Object.keys(user_data).length === 0) return { preskoceno: 'bez-identifikatoru' };

  const telo = {
    data: [{
      event_name: nazev,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      ...(url ? { event_source_url: url } : {}),
      user_data,
      ...(vlastni ? { custom_data: vlastni } : {}),
    }],
    ...(TEST_KOD ? { test_event_code: TEST_KOD } : {}),
  };

  try {
    const odpoved = await fetch(
      `https://graph.facebook.com/${VERZE_API}/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telo),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!odpoved.ok) {
      // Tělo chyby se loguje schválně: Meta v něm říká, co přesně jí vadí,
      // a bez toho se špatný token od špatného tvaru události nepozná.
      const text = await odpoved.text().catch(() => '');
      console.warn('[meta-capi] odmítnuto', odpoved.status, text.slice(0, 500));
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[meta-capi] nepodařilo se odeslat:', err.message);
    return { ok: false };
  }
}

module.exports = { posli, nastaveno };
