/**
 * Odesílání transakčních e-mailů přes Resend.
 *
 * Volá se přes HTTPS, takže není potřeba žádná další knihovna.
 * Bez nastaveného RESEND_API_KEY se e-mail nepošle — ve vývoji se vypíše
 * do konzole, v produkci se zaloguje chyba. Nikdy to neshodí request:
 * odeslání e-mailu je vedlejší efekt, ne jádro operace.
 */

const sezona = require('../utils/sezona');
// Jméno leží v databázi tak, jak ho člověk napsal — „jan". Velké písmeno
// i pátý pád řeší tenhle modul, ne šablony.
const jmena = require('../utils/jmena');

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  return process.env.MAIL_FROM ?? 'FSL <noreply@fslleague.cz>';
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n[Mail:DEV] → ${to}\n[Mail:DEV] ${subject}\n${text}\n`);
      return { ok: true, dev: true };
    }
    console.error('[Mail] RESEND_API_KEY není nastavený — e-mail se neodeslal.');
    return { ok: false, reason: 'no-api-key' };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to:   [to],
        subject,
        text,
        ...(html ? { html } : {}),
        // Reply-To míří na člověka, který zprávu poslal. Bez toho by odpověď
        // z info@ odešla zase na info@ a nikdo by se to nedozvěděl.
        ...(replyTo ? { reply_to: [replyTo] } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[Mail] Resend vrátil ${res.status}: ${detail.slice(0, 300)}`);
      return { ok: false, reason: `http-${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Mail] Odeslání selhalo:', err.message);
    return { ok: false, reason: err.message };
  }
}

/** E-mail s kódem pro obnovu hesla. */
function resetPasswordMail(code, minut) {
  const text =
`Kód pro obnovu hesla do aplikace FSL: ${code}

Zadej ho v aplikaci na obrazovce obnovy hesla. Platí ${minut} minut.

Pokud jsi o obnovu hesla nežádal, tenhle e-mail ignoruj — k účtu se nikdo nedostal
a heslo zůstává beze změny.`;

  const html =
`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px">
  <h2 style="margin:0 0 16px">Obnova hesla FSL</h2>
  <p style="margin:0 0 20px;color:#444">Zadej tenhle kód v aplikaci:</p>
  <div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:16px 0">${code}</div>
  <p style="margin:20px 0 0;color:#666;font-size:14px">Kód platí ${minut} minut.</p>
  <p style="margin:16px 0 0;color:#666;font-size:14px">
    Pokud jsi o obnovu hesla nežádal, e-mail ignoruj — heslo zůstává beze změny.
  </p>
</div>`;

  return { subject: `Kód pro obnovu hesla: ${code}`, text, html };
}

/** E-mail pro účet, který se přihlašuje přes Google nebo Apple. */
function providerAccountMail(provider) {
  const text =
`Žádal jsi o obnovu hesla k účtu FSL, ale tenhle účet heslo nemá —
přihlašuješ se přes ${provider}.

Otevři aplikaci a použij tlačítko „Přihlásit se přes ${provider}".`;

  return { subject: 'Obnova hesla FSL', text };
}

/**
 * Adresa, na kterou chodí zprávy z webu.
 *
 * Schválně **ne** osobní adresa provozovatele: veřejný formulář posílá
 * komukoli, kdo ho najde, a jakmile jednou odejde na soukromou schránku,
 * nejde to vzít zpět. Když proměnná chybí, padá to na info@fslleague.cz,
 * ne na nic — zpráva od uživatele se nesmí ztratit kvůli nenastavenému env.
 */
function supervisorAddress() {
  return process.env.SUPERVISOR_EMAIL ?? 'info@fslleague.cz';
}

/** Zpráva supervisorovi z formuláře na webu. */
function zpravaZWebuMail({ kategorie, telo, odesilatel, prihlasen, stranka }) {
  const radky = [
    `Kategorie: ${kategorie}`,
    `Od: ${odesilatel}${prihlasen ? ' (přihlášený účet)' : ' (nepřihlášený)'}`,
    stranka ? `Stránka: ${stranka}` : null,
    '',
    telo,
    '',
    '— Odesláno z formuláře na fslleague.cz. Odpověď půjde rovnou odesílateli.',
  ].filter((r) => r !== null); // pozor: ne filter(Boolean), ten by smazal i prázdné řádky

  const esc = (t) =>
    String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html =
`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
  <h2 style="margin:0 0 4px">${esc(kategorie)}</h2>
  <p style="margin:0 0 16px;color:#666;font-size:14px">
    Od: ${esc(odesilatel)}${prihlasen ? ' · přihlášený účet' : ' · nepřihlášený'}
    ${stranka ? `<br>Stránka: ${esc(stranka)}` : ''}
  </p>
  <div style="white-space:pre-wrap;padding:16px;background:#f6f6f8;border-radius:8px;color:#222">${esc(telo)}</div>
  <p style="margin:16px 0 0;color:#888;font-size:13px">
    Odesláno z formuláře na fslleague.cz. Odpověď půjde rovnou odesílateli.
  </p>
</div>`;

  return { subject: `FSL — ${kategorie}`, text: radky.join('\n'), html };
}

/**
 * Odpověď supervisora na zprávu z webu.
 *
 * Posílá se tomu, kdo psal — včetně nepřihlášených, kteří žádné oznámení
 * v účtu dostat nemůžou. Do e-mailu se přikládá i původní zpráva: mezi
 * odesláním a odpovědí můžou být dny a člověk si nemusí pamatovat, čeho
 * se to týkalo.
 */
function odpovedNaZpravuMail({ kategorie, stav, odpoved, puvodni }) {
  const esc = (t) =>
    String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text =
`Odpověď na tvoji zprávu (${kategorie}) — ${stav}.

${odpoved}

---
Tvoje původní zpráva:
${puvodni}

Odpovědět můžeš přímo na tenhle e-mail.`;

  const html =
`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
  <h2 style="margin:0 0 4px">Odpověď na tvoji zprávu</h2>
  <p style="margin:0 0 16px;color:#666;font-size:14px">${esc(kategorie)} · ${esc(stav)}</p>
  <div style="white-space:pre-wrap;padding:16px;background:#f6f6f8;border-radius:8px;color:#222">${esc(odpoved)}</div>
  <p style="margin:20px 0 6px;color:#888;font-size:13px">Tvoje původní zpráva:</p>
  <div style="white-space:pre-wrap;padding:12px 16px;border-left:3px solid #ddd;color:#666;font-size:13px">${esc(puvodni)}</div>
  <p style="margin:16px 0 0;color:#888;font-size:13px">Odpovědět můžeš přímo na tenhle e-mail.</p>
</div>`;

  return { subject: `FSL — odpověď na tvoji zprávu (${kategorie})`, text, html };
}


// ==================== E-MAILY PO REGISTRACI A K PLATBÁM ====================
//
// Tyhle zprávy jsou často **první** písemná stopa, kterou po nás člověk má.
// Platí pro ně, co pro celý web: **nesmí slibovat aplikaci**, kterou si
// nemůže stáhnout, nesmí jmenovat provozovatele jinak než Ninety Three
// Group s.r.o., nesmí uvádět DPH (liga není plátce) a nepoužívá se v nich
// slovo „výkop".
//
// Odpovědi chodí na info@fslleague.cz, což je zároveň odesílatel, takže
// `reply_to` se nenastavuje.

const WEB = 'https://fslleague.cz';

/** Společná obálka, ať všechny zprávy vypadají stejně a drží se na šířku mobilu. */
function obalka(nadpis, telo) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;color:#222">
  <h2 style="margin:0 0 16px;font-size:20px">${nadpis}</h2>
  ${telo}
  <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e5e8;color:#888;font-size:13px">
    Floorball Stars Liga · <a href="${WEB}/cenik" style="color:#8a6d2f">ceník</a><br>
    Odpovědět můžeš přímo na tenhle e-mail.
  </p>
</div>`;
}

const odstavec = (t) => `<p style="margin:0 0 14px;line-height:1.6">${t}</p>`;

/** Zvýrazněný blok s částkou nebo kódem. */
function ramecek(obsah) {
  return `<div style="margin:0 0 16px;padding:14px 16px;background:#f6f6f8;border-radius:10px;line-height:1.6">${obsah}</div>`;
}

const tlacitko = (text, cesta) =>
  `<p style="margin:0 0 16px"><a href="${WEB}${cesta}" style="display:inline-block;padding:11px 20px;background:#C9A140;color:#1a1005;border-radius:10px;text-decoration:none;font-weight:600">${text}</a></p>`;

/**
 * Hráč se zaregistroval.
 *
 * Dvě situace, které se nesmí slít do jedné: kdo přišel s pozvánkovým kódem,
 * je rovnou na soupisce a řeší jen licenci. Kdo se přihlásil bez týmu, tým
 * ještě nemá — a musí se dozvědět obojí, co ho čeká: že se nabízí v draftu
 * **a** že si může vzít Virtuálního vedoucího a nechat tým složit lize.
 */
function registraceHracMail({ jmeno, tym, licFee = 300, balikCastka = 800 }) {
  const oslov = jmena.osloveni(jmeno);
  // Do otevření poolu hráče nevidí ani vedoucí. Kdo to neví, čeká na nabídku,
  // která z principu nemůže přijít, a bere to jako že o něj nikdo nestojí.
  const otevreni = sezona.den(sezona.OTEVRENI_DRAFTU);

  const text = tym
    ? `${oslov}

jsi zaregistrovaný ve Floorball Stars Lize a rovnou na soupisce týmu ${tym}.

Zbývá ti zaplatit hráčskou licenci ${licFee} Kč na sezónu. Bez ní tě vedoucí
nemůže postavit do sestavy. Zápasy se pak platí zvlášť balíčkem startů — od
200 Kč za jeden po 3 000 Kč za dvacet, což vychází na 150 Kč za zápas.

Zaplatit jde kartou i převodem: ${WEB}/platby

Jak se hraje: pět hráčů do pole a brankář, 3 × 15 minut čistého času ve
všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně,
základní část má 15 až 20 kol od listopadu do března, po ní jde play-off, do
kterého postupuje každý tým. Hraje se v Praze, halu upřesníme podle počtu
přihlášených týmů.`
    : `${oslov}

jsi zaregistrovaný ve Floorball Stars Lize. Přihlásil ses bez týmu, takže
jsi v draftu volných hráčů — mezi lidmi, ze kterých si vedoucí doplňují
soupisky.

Vedoucím se ten seznam otevře ${otevreni}, hned po uzávěrce přihlášek. Do té
doby ho schválně neukazujeme, aby si nikdo nerozebral hráče dřív, než je
jasné, kdo do soutěže nastoupí. Takže když se do té doby nic neděje, není to
tím, že by o tebe nikdo nestál — zatím tě prostě nikdo nevidí.

Do té doby tě nic nestojí. Hráčskou licenci ${licFee} Kč na sezónu platíš,
teprve až tě někdo vezme do týmu.

Když nechceš čekat, můžeš si vzít balík Virtuální vedoucí za ${balikCastka} Kč na
sezónu: tým ti složí liga z ostatních jednotlivců a sestavu si pak hráči
skládají sami — hraje ten, kdo se na zápas přihlásí. V ceně je startovné
500 Kč a hráčská licence ${licFee} Kč. Otevřený tým se skládá kolem čtrnácti lidí,
takže než se první sejde, nějaký čas to potrvá; když si to rozmyslíš dřív,
než tě do týmu zařadíme, startovné se vrací.

Obojí najdeš tady: ${WEB}/platby

Zápasy se platí zvlášť balíčkem startů — od 200 Kč za jeden po 3 000 Kč za
dvacet, což vychází na 150 Kč za zápas. Kupuješ ho, až budeš vědět, že hraješ.

Jak se hraje: pět hráčů do pole a brankář, 3 × 15 minut čistého času ve
všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně,
základní část má 15 až 20 kol od listopadu do března, po ní jde play-off, do
kterého postupuje každý tým. Hraje se v Praze, halu upřesníme podle počtu
přihlášených týmů.`;

  const html = obalka(
    tym ? 'Jsi v lize' : 'Jsi v draftu volných hráčů',
    tym
      ? odstavec(`${oslov} jsi zaregistrovaný ve Floorball Stars Lize a rovnou na soupisce týmu <strong>${tym}</strong>.`)
        + ramecek(`<strong>Hráčská licence ${licFee} Kč</strong> na sezónu. Bez ní tě vedoucí nemůže postavit do sestavy.`)
        + tlacitko('Zaplatit licenci', '/platby')
        + odstavec('Zápasy se platí zvlášť balíčkem startů — od 200 Kč za jeden po 3 000 Kč za dvacet, tedy 150 Kč za zápas.')
        + odstavec('Hraje se pět do pole a brankář, 3 × 15 minut čistého času ve všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně, základní část má 15 až 20 kol od listopadu do března, po ní play-off, do kterého postupuje každý tým. V Praze, halu upřesníme podle počtu přihlášených týmů.')
      : odstavec(`${oslov} jsi zaregistrovaný ve Floorball Stars Lize. Přihlásil ses bez týmu, takže jsi v <strong>draftu volných hráčů</strong> — mezi lidmi, ze kterých si vedoucí doplňují soupisky.`)
        + odstavec(`Vedoucím se seznam otevře <strong>${otevreni}</strong>, hned po uzávěrce přihlášek. Do té doby ho schválně neukazujeme, aby si nikdo nerozebral hráče dřív, než je jasné, kdo do soutěže nastoupí — takže když se do té doby nic neděje, zatím tě prostě nikdo nevidí.`)
        + odstavec(`Do té doby tě nic nestojí. <strong>Hráčskou licenci ${licFee} Kč</strong> na sezónu platíš, teprve až tě někdo vezme do týmu.`)
        + ramecek(`<strong>Nechceš čekat? Virtuální vedoucí, ${balikCastka} Kč na sezónu.</strong><br>Tým ti složí liga z ostatních jednotlivců, sestavu si skládají hráči sami — hraje ten, kdo se na zápas přihlásí. V ceně startovné 500 Kč a licence ${licFee} Kč.`)
        + odstavec('Otevřený tým se skládá kolem čtrnácti lidí, takže než se první sejde, nějaký čas to potrvá. Když si to rozmyslíš dřív, než tě do týmu zařadíme, startovné se vrací.')
        + tlacitko('Podívat se na platby', '/platby')
        + odstavec('Zápasy se platí zvlášť balíčkem startů — od 200 Kč za jeden po 3 000 Kč za dvacet, tedy 150 Kč za zápas. Kupuješ ho, až budeš vědět, že hraješ.')
        + odstavec('Hraje se pět do pole a brankář, 3 × 15 minut čistého času ve všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně, základní část má 15 až 20 kol od listopadu do března, po ní play-off, do kterého postupuje každý tým. V Praze, halu upřesníme podle počtu přihlášených týmů.'),
  );

  return { subject: tym ? `Jsi v lize — ${tym}` : 'Jsi v draftu volných hráčů', text, html };
}

/**
 * Tým se přihlásil.
 *
 * **Schválení supervisorem je provozní povinnost, ne formalita** — tým po
 * registraci visí v `PENDING` a nikdo se to jinak nedozví. Zároveň je to
 * jediné místo, kde vedoucí dostane pozvánkový kód písemně.
 */
function registraceVedouciMail({ jmeno, tym, kod, castka = 3000, licFee = 300 }) {
  const oslov = jmena.osloveni(jmeno);

  const text =
`${oslov}

tým ${tym} je přihlášený do Floorball Stars Ligy. Teď ho projdeme a ozveme se
ti, jakmile bude schválený.

Mezitím dvě věci:

1) Pozvánkový kód pro spoluhráče: ${kod}
   Kdo ho zadá při registraci, přistane rovnou na vaší soupisce. Na soupisce
   musí být nejmíň devět hráčů do pole a jeden brankář, horní hranice není.

2) Registrace týmu ${castka} Kč na sezónu. Je to jediné, co platí tým jako
   celek — zápasy si pak platí každý hráč sám balíčkem startů, po nikom
   nic nevybíráš. Jako vedoucí máš i hráčský profil, takže pro tebe platí
   i licence ${licFee} Kč.

Zaplatit jde kartou i převodem, a klidně všechno najednou: ${WEB}/platby

Jak se hraje: pět hráčů do pole a brankář, 3 × 15 minut čistého času ve
všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně,
základní část má 15 až 20 kol od listopadu do března, po ní jde play-off, do
kterého postupuje každý tým. Hraje se v Praze, halu upřesníme podle počtu
přihlášených týmů.`;

  const html = obalka(
    'Přihláška týmu přijata',
    odstavec(`${oslov} tým <strong>${tym}</strong> je přihlášený do Floorball Stars Ligy. Projdeme ho a ozveme se, jakmile bude schválený.`)
    + ramecek(`<strong>Pozvánkový kód pro spoluhráče</strong><br><span style="font-size:22px;font-weight:700;letter-spacing:2px">${kod}</span><br>Kdo ho zadá při registraci, přistane rovnou na vaší soupisce. Minimum je 9 hráčů do pole a 1 brankář, horní hranice není.`)
    + ramecek(`<strong>Registrace týmu ${castka} Kč</strong> na sezónu — jediné, co platí tým jako celek. Zápasy si platí každý hráč sám, po nikom nic nevybíráš. Jako vedoucí máš i hráčský profil, takže pro tebe platí i licence ${licFee} Kč.`)
    + tlacitko('Zaplatit', '/platby')
    + odstavec('Hraje se pět do pole a brankář, 3 × 15 minut čistého času ve všech zápasech — hodiny se při každém přerušení zastavují. Jeden zápas týdně, základní část má 15 až 20 kol od listopadu do března, po ní play-off, do kterého postupuje každý tým. V Praze, halu upřesníme podle počtu přihlášených týmů.'),
  );

  return { subject: `Přihláška týmu ${tym} přijata`, text, html };
}

/**
 * Rozhodčí se přihlásil.
 *
 * **Nic neplatí**, takže v téhle zprávě nesmí být ani slovo o platbě.
 * Rodné číslo, adresa a bankovní spojení se vyplňují až na smlouvě po
 * schválení — a e-mail je to místo, kde se to má říct dopředu.
 */
function registraceRozhodciMail({ jmeno }) {
  const oslov = jmena.osloveni(jmeno);

  const text =
`${oslov}

díky za přihlášku mezi rozhodčí Floorball Stars Ligy. Přihlášku projdeme
a ozveme se ti.

Nic neplatíš — poplatky se rozhodčích netýkají. Zbytek údajů (bankovní
spojení a co patří na smlouvu) budeme řešit až po schválení, ne teď.

Hraje se v Praze, pět hráčů do pole a brankář, 3 × 15 minut. Základní část
jde od listopadu do března, po ní play-off. Hraje se na čistý čas ve všech
zápasech — hodiny se při každém přerušení zastavují, na to pozor při měření.`;

  const html = obalka(
    'Přihláška rozhodčího přijata',
    odstavec(`${oslov} díky za přihlášku mezi rozhodčí Floorball Stars Ligy. Projdeme ji a ozveme se ti.`)
    + odstavec('<strong>Nic neplatíš</strong> — poplatky se rozhodčích netýkají. Bankovní spojení a údaje na smlouvu budeme řešit až po schválení.')
    + odstavec('Hraje se v Praze, pět hráčů do pole a brankář, 3 × 15 minut. Základní část jde od listopadu do března, po ní play-off. Hraje se na čistý čas ve všech zápasech — hodiny se při každém přerušení zastavují, na to pozor při měření.'),
  );

  return { subject: 'Přihláška rozhodčího přijata', text, html };
}

/** Řádky položek do textu i do HTML. */
function polozkyRadky(polozky) {
  return (polozky ?? []).map((p) => `${p.nazev} — ${p.castka} Kč`);
}

/**
 * Platba dorazila.
 *
 * Posílá se z košíku, tedy z jediné cesty, kterou dnes lidé platí. Doklad
 * tenhle e-mail **není** — ten posílá platební brána, u převodu systém při
 * spárování. Proto se tu neuvádí nic o DPH: liga není plátce.
 */
function platbaPrijataMail({ jmeno, polozky, castka, prevodem }) {
  const oslov = jmena.osloveni(jmeno);
  const radky = polozkyRadky(polozky);

  const text =
`${oslov}

platba ${castka} Kč dorazila${prevodem ? ' (převodem)' : ''}. Máš zaplaceno:

${radky.map((r) => `· ${r}`).join('\n')}

Nic dalšího od tebe nepotřebujeme. Stav svých plateb vidíš kdykoli tady:
${WEB}/platby`;

  const html = obalka(
    'Platba dorazila',
    odstavec(`${oslov} platba <strong>${castka} Kč</strong> dorazila${prevodem ? ' převodem' : ''}. Máš zaplaceno:`)
    + ramecek(radky.map((r) => `· ${r}`).join('<br>'))
    + odstavec('Nic dalšího od tebe nepotřebujeme.')
    + tlacitko('Moje platby', '/platby'),
  );

  return { subject: `Platba ${castka} Kč dorazila`, text, html };
}

/**
 * Připomínka nezaplaceného poplatku.
 *
 * **Nevyhrožuje se smazáním.** Skutečná páka je v pravidlech a je věcná:
 * bez zaplacené licence hráč nenastoupí a tým bez zaplacené registrace
 * supervisor do soutěže nezařadí. Hrozba mazáním by navíc byla lež —
 * převodem platba dorazí za den dva a párování běží v denním cyklu, takže
 * by se mazali lidé, kteří zaplatili.
 */
function upominkaPlatbaMail({ jmeno, polozky, castka, faze = 1 }) {
  const oslov = jmena.osloveni(jmeno);
  const radky = polozkyRadky(polozky);

  // Tón se stupňuje jen v tom, jak naléhavě zní — nikdy v tom, čím hrozí.
  //
  // Texty schválně **neříkají, kolik dní uplynulo**. Plán se od zavedení
  // posunul už dvakrát a pokaždé by se musely přepisovat i tady; „včera ti
  // prošla registrace" byla po změně plánu rovnou lež.
  const uvod = {
    1: 'registrace ti prošla, ale platba zatím ne. Visí na tobě:',
    2: 'platba na tvoji přihlášku pořád nedorazila:',
    3: 'pořád se ti tu drží nezaplacená položka:',
  }[faze] ?? 'platba zatím nedorazila:';

  const zaver = {
    1: 'Spěchat nemusíš, jen ať to nezapadne: bez zaplacené licence tě nejde postavit '
     + 'do sestavy a tým bez zaplacené registrace se nezařadí do soutěže.',
    2: 'Kdyby se platba někde zasekla nebo ti něco nebylo jasné, napiš — vyřešíme to. '
     + 'A kdybys to mezitím poslal převodem, počkej den dva, než se spáruje.',
    3: 'Tohle je od nás poslední připomínka, dál už psát nebudeme. Přihláška ti nikam '
     + 'nezmizí a zaplatit jde kdykoli; dokud to neuděláš, jen se s tebou nepočítá '
     + 'do soutěže.',
  }[faze] ?? '';

  const predmet = {
    1: 'Ještě zbývá zaplatit',
    2: 'Připomínka: platba zatím nedorazila',
    3: 'Poslední připomínka platby',
  }[faze] ?? 'Ještě zbývá zaplatit';

  const text =
`${oslov}

${uvod}

${radky.map((r) => `· ${r}`).join('\n')}
Celkem ${castka} Kč

Zaplatit jde kartou i převodem — a klidně všechno najednou v jednom košíku:
${WEB}/platby

${zaver}

Kdyby něco nešlo nebo sis to rozmyslel, stačí odpovědět na tenhle e-mail.`;

  const html = obalka(
    predmet,
    odstavec(`${oslov} ${uvod}`)
    + ramecek(radky.map((r) => `· ${r}`).join('<br>') + `<br><strong>Celkem ${castka} Kč</strong>`)
    + tlacitko('Zaplatit', '/platby')
    + odstavec(zaver)
    + odstavec('Kdyby něco nešlo nebo sis to rozmyslel, stačí odpovědět na tenhle e-mail.'),
  );

  return { subject: predmet, text, html };
}

/**
 * Hráč bez týmu, který zatím nic nezaplatil.
 *
 * **Není to upomínka a nesmí tak znít** — v draftu člověk nic nedluží.
 * Je to nabídka druhé cesty pro toho, komu zatím nikdo nenapsal: vzít si
 * Virtuálního vedoucího a nechat tým složit lize. Proto se taky neposílá
 * hodinu po registraci jako platební připomínka, ale až druhý den.
 */
function nabidkaVstupuMail({
  jmeno, castka = 800, licFee = 300, faze = 1,
  poolOtevren = sezona.draftOtevren(),
}) {
  const oslov = jmena.osloveni(jmeno);
  const otevreni = sezona.den(sezona.OTEVRENI_DRAFTU);

  // Dokud je pool zamčený, nesmí zpráva znít jako „nikdo o tebe nestojí".
  // Vedoucí hráče ještě nevidí, takže mu místo nabídnout ani nemůžou —
  // a věta o tom, že se nikdo neozval, by z toho udělala jeho neúspěch.
  const uvod = poolOtevren
    ? (faze >= 2
      ? 'pořád jsi u nás v draftu volných hráčů a zatím ti nikdo nenabídl místo.'
      : 'jsi v draftu volných hráčů a zatím ti nikdo nenabídl místo. Nic se neděje, '
        + 'týmy se teprve skládají.')
    : (faze >= 2
      ? `pořád jsi u nás v draftu volných hráčů. Vedoucím se seznam otevře ${otevreni}, `
        + 'takže se do té doby nic dít nebude — zatím tě nikdo nevidí.'
      : `jsi v draftu volných hráčů. Vedoucím se seznam otevře ${otevreni}, hned po `
        + 'uzávěrce přihlášek, takže se do té doby nic dít nebude — není to tím, '
        + 'že by o tebe nikdo nestál.');
  const zaver = faze >= 2
    ? 'Tohle je od nás poslední připomínka — v draftu zůstáváš dál a nic tím neztrácíš.'
    : 'V draftu zůstáváš tak jako tak a nic tě to nestojí.';

  const text =
`${oslov}

${uvod}

Když nechceš čekat, můžeš do soutěže vstoupit sám: balík Virtuální vedoucí
za ${castka} Kč na sezónu. Tým ti složí liga z ostatních jednotlivců a sestavu si
pak hráči skládají sami — hraje ten, kdo se na zápas přihlásí. V ceně je
startovné 500 Kč a hráčská licence ${licFee} Kč.

Otevřený tým se skládá kolem čtrnácti lidí, takže než se první sejde, nějaký
čas to potrvá. Když si to rozmyslíš dřív, než tě do týmu zařadíme, startovné
se ti vrátí.

${WEB}/platby

${zaver}`;

  const html = obalka(
    'Pořád jsi v draftu',
    odstavec(`${oslov} ${uvod}`)
    + ramecek(`<strong>Virtuální vedoucí, ${castka} Kč na sezónu.</strong><br>Tým ti složí liga z ostatních jednotlivců, sestavu si skládají hráči sami. V ceně startovné 500 Kč a licence ${licFee} Kč.`)
    + odstavec('Otevřený tým se skládá kolem čtrnácti lidí, takže než se první sejde, nějaký čas to potrvá. Když si to rozmyslíš dřív, než tě do týmu zařadíme, startovné se ti vrátí.')
    + tlacitko('Podívat se na platby', '/platby')
    + odstavec(zaver),
  );

  return { subject: 'Pořád jsi v draftu volných hráčů', text, html };
}

/**
 * Liga hráči složila tým — informativní zpráva před telefonátem.
 *
 * **Nic nechce a na nic neodkazuje.** Celá domluva proběhne telefonem, e-mail
 * jen připraví půdu, aby hovor nepřišel z čistého nebe. Proto tu není tlačítko
 * do plateb ani odkaz na košík: kdo by zaplatil hned, připraví se o hovor,
 * ve kterém se řeší i to, jestli mu termíny sedí.
 *
 * Dvě verze podle postu. Věta o nedostatku brankářů se čte opačně podle toho,
 * kdo ji dostane — hráč do pole v ní slyší „liga nemá gólmany", brankář
 * „jsem žádaný". Proto ji verze pro pole neobsahuje vůbec.
 *
 * **Nikde se nesmí objevit, že je tým poskládaný z jednotlivců** — do losu
 * 2. 11. 2026 to je obchodní informace, viz `fsl-otevreny-tym-zalozeni`.
 * Formulace je „tým vedený přímo ligou (virtuální vedoucí)".
 */
function nabidkaTymuMail({
  jmeno, brankar = false, castka = 500, standardni = 800,
  denHovoru = 'v pondělí 21. 9.',
}) {
  const oslov = jmena.osloveni(jmeno);

  const uvod = 'do FSL ses přihlásil sám, bez týmu. Máme pro tebe dobrou zprávu: '
    + 'tým jsme ti našli.';
  const jakToChodi = 'Je to tým vedený přímo ligou (virtuální vedoucí) — sestavu '
    + 'na zápasy skládáme my, ty se jen přihlásíš na termíny, které ti sedí. Halu, '
    + 'rozhodčí, pořadatelskou službu i zdravotnický dozor zajišťuje liga, nic '
    + 'z toho neřešíš.';

  // Hráč do pole dostane čísla kádru, brankář místo nich důvod, proč je vzácný.
  const post = brankar
    ? 'Brankář je pozice, o kterou je v amatérském florbale největší nouze — '
      + 'na každý tým jsou potřeba dva a shánějí se hůř než kdokoli jiný. '
      + 'Tvoje místo v týmu je tím pádem jisté.'
    : 'Tým bude mít kádr 18 hráčů do pole a 2 brankáře. Podle docházky se na '
      + 'zápas reálně sejde zhruba 13 + 1, takže o hraní nouze nebude.';

  const cena = `Protože jde o první tým tohoto typu v sezóně, máš vstup za ${castka} Kč `
    + `místo standardních ${standardni} Kč.`;
  const hovor = `Teď od tebe nic nepotřebujeme. Zavoláme ti ${denHovoru} a všechno `
    + 'si v klidu projdeme — jaký tým to je, jak to bude vypadat a co bude dál. '
    + 'Zabere to pár minut.';
  const nahradni = 'Kdyby ti termín nevyšel nebo ti víc sedí jiný čas, stačí '
    + 'odepsat na tenhle e-mail a zavoláme, kdy ti to vyhovuje.';
  const patka = 'Sezóna 2026/27 startuje 9. 11., hraje se pondělí až čtvrtek '
    + 'večer v Praze.';

  const predmet = brankar
    ? 'Máme pro tebe tým — a brankáře sháníme nejvíc'
    : 'Máme pro tebe tým — ozveme se ti telefonem';

  const text =
`${oslov}

${uvod}

${jakToChodi}

${post}

${cena}

${hovor}

${nahradni}

${patka}

Jakub z FSL
${supervisorAddress()}`;

  const html = obalka(
    'Máme pro tebe tým',
    odstavec(`${oslov} ${uvod}`)
    + odstavec(jakToChodi)
    + odstavec(post)
    + ramecek(`<strong>Vstup za ${castka} Kč</strong> místo standardních ${standardni} Kč — `
      + 'protože jde o první tým tohoto typu v sezóně.')
    + odstavec(hovor)
    + odstavec(nahradni)
    + odstavec(patka)
    + odstavec(`Jakub z FSL<br>${supervisorAddress()}`),
  );

  return { subject: predmet, text, html };
}

/**
 * Hráče zařadil do týmu někdo jiný než on sám.
 *
 * Chodí při každém zařazení, i při přesunu mezi týmy — je to jediné místo,
 * kde se člověk dozví, co pro něj zařazení znamená za peníze. U otevřeného
 * týmu je to vstupní balík, který mu zařazení rovnou vloží do košíku;
 * u klubového týmu jen hráčská licence.
 *
 * `castka` je vždycky to, co se platí teď. Nula znamená, že je zaplaceno —
 * a to se musí napsat, ne mlčet, jinak člověk hledá, kde má platit.
 */
function zarazeniDoTymuMail({
  jmeno,
  tym,
  otevreny   = false,
  castka     = 0,
  licFee     = 300,
  licVBaliku = true,
  entryFee   = 500,
}) {
  const oslov = jmena.osloveni(jmeno);
  const starty = 'Zápasy se platí zvlášť balíčkem startů — od 200 Kč za jeden '
    + 'po 3 000 Kč za dvacet, tedy 150 Kč za zápas. Kupuješ ho, až budeš vědět, '
    + 'že hraješ.';

  // Otevřený tým je tým vedený přímo ligou. Že je poskládaný z jednotlivců,
  // se ven nepíše — e-mail se dá přeposlat dál.
  const coJeOtevreny = 'Je to tým vedený přímo ligou — takzvaný virtuální '
    + 'vedoucí. Nikdo nesvolává ani neshání halu, to dělá liga; sestavu na '
    + 'zápas si skládají hráči sami, hraje ten, kdo se přihlásí.';

  let jadroText;
  let jadroHtml;

  if (otevreny && castka > 0) {
    const rozpis = licVBaliku
      ? `V ceně je startovné ${entryFee} Kč a hráčská licence ${licFee} Kč.`
      : `Hráčskou licenci máš zaplacenou, takže platíš jen startovné ${entryFee} Kč.`;
    jadroText =
`${coJeOtevreny}

Do košíku jsme ti vložili vstupní balík Virtuální vedoucí za ${castka} Kč na
sezónu. ${rozpis} Bez něj tě do sestavy postavit nemůžeme.

Zaplatit jde kartou i převodem: ${WEB}/platby`;
    jadroHtml = odstavec(coJeOtevreny)
      + ramecek(`<strong>Virtuální vedoucí — ${castka} Kč</strong> na sezónu, už ti leží v košíku.<br>${rozpis}`)
      + tlacitko('Zaplatit v košíku', '/platby');
  } else if (otevreny) {
    jadroText =
`${coJeOtevreny}

Vstupní balík máš zaplacený, takže teď neplatíš nic dalšího.`;
    jadroHtml = odstavec(coJeOtevreny)
      + ramecek('<strong>Vstupní balík máš zaplacený</strong> — teď neplatíš nic dalšího.');
  } else if (castka > 0) {
    jadroText =
`Zbývá ti zaplatit hráčskou licenci ${castka} Kč na sezónu. Bez ní tě vedoucí
nemůže postavit do sestavy.

Zaplatit jde kartou i převodem: ${WEB}/platby`;
    jadroHtml = ramecek(`<strong>Hráčská licence ${castka} Kč</strong> na sezónu. Bez ní tě vedoucí nemůže postavit do sestavy.`)
      + tlacitko('Zaplatit licenci', '/platby');
  } else {
    jadroText = 'Hráčskou licenci máš zaplacenou, takže teď neplatíš nic dalšího.';
    jadroHtml = ramecek('<strong>Hráčskou licenci máš zaplacenou</strong> — teď neplatíš nic dalšího.');
  }

  const text =
`${oslov}

liga tě zařadila do týmu ${tym} a jsi na jeho soupisce.

${jadroText}

${starty}

Když ti zařazení nesedí, napiš nám na ${supervisorAddress()} — dá se to vrátit.`;

  const html = obalka(
    `Jsi v týmu ${tym}`,
    odstavec(`${oslov} liga tě zařadila do týmu <strong>${tym}</strong> a jsi na jeho soupisce.`)
    + jadroHtml
    + odstavec(starty)
    + odstavec(`Když ti zařazení nesedí, napiš nám na <a href="mailto:${supervisorAddress()}" style="color:#8a6d2f">${supervisorAddress()}</a> — dá se to vrátit.`),
  );

  return { subject: `Jsi v týmu ${tym}`, text, html };
}

/**
 * Odeslání, které nesmí položit to, kvůli čemu se volá.
 *
 * Registrace se nesmí rozbít proto, že Resend zrovna neodpovídá — člověk
 * by dostal chybu u přihlášky, která ve skutečnosti prošla.
 */
async function posliBezpecne(to, zprava, kde) {
  if (!to) return { ok: false, reason: 'no-recipient' };
  try {
    const r = await sendMail({ to, ...zprava });
    if (!r.ok) console.error(`[Mail:${kde}] Neodesláno (${r.reason}) → ${to}`);
    return r;
  } catch (err) {
    console.error(`[Mail:${kde}] Výjimka: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  sendMail,
  posliBezpecne,
  resetPasswordMail,
  providerAccountMail,
  supervisorAddress,
  zpravaZWebuMail,
  odpovedNaZpravuMail,
  registraceHracMail,
  registraceVedouciMail,
  registraceRozhodciMail,
  platbaPrijataMail,
  upominkaPlatbaMail,
  nabidkaVstupuMail,
  nabidkaTymuMail,
  zarazeniDoTymuMail,
};
