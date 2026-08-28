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

async function sendMail({ to, subject, text, html }) {
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

module.exports = { sendMail, resetPasswordMail, providerAccountMail };
