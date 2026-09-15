/**
 * Zprávy supervisorovi z webu.
 *
 * Jeden formulář na všechno — chyba na webu, platby, soupiska, registrace,
 * dotaz. Zpráva se **uloží do fronty žádostí i pošle e-mailem**: e-mail se
 * dá přehlédnout nebo spadne do spamu, fronta v adminu je záznam, který
 * nezmizí.
 *
 * Funguje i **bez přihlášení**. Kdo se nemůže registrovat nebo přihlásit,
 * má právě tehdy největší důvod se ozvat — a kdyby formulář chtěl účet,
 * nikdy by se o té chybě nikdo nedozvěděl. Cenou za to je spam, proto
 * honeypot a limit na IP níž.
 */

const express = require('express');

const { optionalAuth } = require('../middleware/auth');
const { sendMail, supervisorAddress, zpravaZWebuMail } = require('../services/mailer');

const router = express.Router();
const prisma = require('../lib/prisma');

/** Kategorie, které smí přijít z formuláře, a jak se jmenují v e-mailu. */
const KATEGORIE = {
  WEB_BUG:          'Chyba na webu',
  REGISTRATION:     'Registrace a přihlášení',
  PAYMENT:          'Platby',
  ROSTER:           'Soupiska a sestavy',
  MATCH_TRANSCRIPT: 'Zápis ze zápasu',
  LICENSE_ISSUE:    'Licence',
  PLAYER_DISPUTE:   'Hráčský spor',
  OTHER:            'Něco jiného',
};

const MIN_DELKA = 10;
const MAX_DELKA = 4000;

/**
 * Limit na IP: 5 zpráv za hodinu.
 *
 * Schválně v paměti, ne v databázi — je to ochrana proti robotovi, ne
 * účetní záznam, a restart backendu, který ji vynuluje, nikomu neublíží.
 * **Přestane to platit ve chvíli, kdy poběží víc instancí**: každá si
 * bude počítat svoje. Kdo bude škálovat, musí to přesunout do databáze
 * nebo za rate limit brány.
 */
const OKNO_MS = 60 * 60 * 1000;
const MAX_ZA_OKNO = 5;
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

  // Úklid, ať mapa neroste donekonečna.
  if (historie.size > 5000) {
    for (const [klic, hodnoty] of historie) {
      if (!hodnoty.some((t) => ted - t < OKNO_MS)) historie.delete(klic);
    }
  }
  return false;
}

function platnyEmail(hodnota) {
  return typeof hodnota === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(hodnota.trim());
}

// POST /api/requests — odeslání zprávy supervisorovi
router.post('/', optionalAuth, async (req, res, next) => {
  try {
    const { type, body, email, page, teamId, matchId, web } = req.body ?? {};

    // Honeypot: pole „web" je ve formuláři schované a člověk ho nevyplní.
    // Robot ano — a dostane 201, aby se nedozvěděl, že neprošel.
    if (typeof web === 'string' && web.trim()) {
      return res.status(201).json({ ok: true });
    }

    const kategorie = KATEGORIE[type];
    if (!kategorie) {
      return res.status(400).json({ error: 'Neznámá kategorie zprávy.', code: 'BAD_TYPE' });
    }

    const text = typeof body === 'string' ? body.trim() : '';
    if (text.length < MIN_DELKA) {
      return res.status(400).json({
        error: 'Napiš nám aspoň větu, ať víme, čeho se to týká.',
        code:  'BODY_TOO_SHORT',
      });
    }
    if (text.length > MAX_DELKA) {
      return res.status(400).json({ error: 'Zpráva je moc dlouhá.', code: 'BODY_TOO_LONG' });
    }

    // Přihlášenému bereme adresu z účtu — vyplněná v formuláři by mohla být
    // cizí a odpověď by šla někam jinam.
    const kontakt = req.user?.email ?? (typeof email === 'string' ? email.trim() : '');
    if (!platnyEmail(kontakt)) {
      return res.status(400).json({
        error: 'Vyplň e-mail, ať je ti kam odpovědět.',
        code:  'EMAIL_REQUIRED',
      });
    }

    const ip = req.ip ?? req.headers['x-forwarded-for'] ?? 'neznámá';
    if (prekrocenLimit(String(ip))) {
      return res.status(429).json({
        error: 'Zpráv z tohohle místa přišlo za hodinu moc. Zkus to za chvíli, nebo napiš na info@fslleague.cz.',
        code:  'TOO_MANY',
      });
    }

    const zprava = await prisma.supervisorRequest.create({
      data: {
        type,
        body:    text,
        email:   kontakt,
        page:    typeof page === 'string' ? page.slice(0, 300) : null,
        userId:  req.user?.id ?? null,
        teamId:  teamId || null,
        matchId: matchId || null,
      },
    });

    // E-mail je vedlejší efekt — když Resend selže, zpráva už je ve frontě
    // a odpověď uživateli nesmí spadnout na chybu.
    const { subject, text: telo, html } = zpravaZWebuMail({
      kategorie,
      telo:       text,
      odesilatel: kontakt,
      prihlasen:  Boolean(req.user),
      stranka:    typeof page === 'string' ? page : null,
    });

    const odeslano = await sendMail({
      to: supervisorAddress(),
      subject,
      text: telo,
      html,
      replyTo: kontakt,
    });

    if (!odeslano.ok) {
      console.error(`[Zpráva ${zprava.id}] e-mail se neodeslal: ${odeslano.reason}`);
    }

    res.status(201).json({ ok: true, id: zprava.id });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.KATEGORIE = KATEGORIE;
