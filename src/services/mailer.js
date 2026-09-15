/**
 * Odesílání transakčních e-mailů přes Resend.
 *
 * Volá se přes HTTPS, takže není potřeba žádná další knihovna.
 * Bez nastaveného RESEND_API_KEY se e-mail nepošle — ve vývoji se vypíše
 * do konzole, v produkci se zaloguje chyba. Nikdy to neshodí request:
 * odeslání e-mailu je vedlejší efekt, ne jádro operace.
 */

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

module.exports = {
  sendMail,
  resetPasswordMail,
  providerAccountMail,
  supervisorAddress,
  zpravaZWebuMail,
};
