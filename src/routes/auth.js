const express = require('express');
const https   = require('https');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const { issueToken, requireAuth, isSupervisorUser } = require('../middleware/auth');

const { sendMail, resetPasswordMail, providerAccountMail } = require('../services/mailer');

const router = express.Router();
const prisma = require('../lib/prisma');
const googleClient = new OAuth2Client();

// ── Apple JWKS cache ──────────────────────────────────────────────────────
let _appleKeys   = null;
let _appleKeysTtl = 0;

async function getApplePublicKeys() {
  const now = Date.now();
  if (_appleKeys && now < _appleKeysTtl) return _appleKeys;
  const keys = await new Promise((resolve, reject) => {
    https.get('https://appleid.apple.com/auth/keys', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).keys); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
  _appleKeys    = keys;
  _appleKeysTtl = now + 60 * 60 * 1000; // cache 1 hodinu
  return keys;
}

function jwkToPem(jwk) {
  // Jednoduchá konverze RSA JWK → PEM hlavička pro jsonwebtoken
  // jsonwebtoken@9 přijímá JWK objekt přímo ve verify({ algorithms, ... })
  return { ...jwk, kty: 'RSA' };
}

async function verifyAppleToken(identityToken) {
  const header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
  const keys   = await getApplePublicKeys();
  const jwk    = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Apple public key nenalezen (kid mismatch)');

  return new Promise((resolve, reject) => {
    // jsonwebtoken v9+ umí ověřit s JWK objektem
    const pemKey = require('crypto').createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    jwt.verify(
      identityToken,
      pemKey,
      {
        algorithms: ['RS256'],
        issuer:    'https://appleid.apple.com',
        // Aplikace se prokazuje App ID (cz.fsl.app), web Services ID (cz.fsl.web).
        // Token vydany pro web ma jine `aud`, takze musime uznat obe hodnoty.
        audience:  [
          process.env.APPLE_CLIENT_ID || 'cz.fsl.app',
          process.env.APPLE_WEB_CLIENT_ID,
        ].filter(Boolean),
      },
      (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      }
    );
  });
}

// ==================== GOOGLE OAUTH ====================
// Frontend pošle idToken z Google Sign-In SDK
router.post('/google', async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Chybí idToken' });

    // Přijmeme token od libovolného ze tří klientů (iOS, Android, Web)
    const validAudiences = [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_IOS_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
    ].filter(Boolean);

    if (validAudiences.length === 0) {
      return res.status(500).json({ error: 'Google OAuth není nakonfigurován' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: validAudiences,
    });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    // Najdi nebo vytvoř uživatele
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
      include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
    });

    if (!user) {
      user = await prisma.user.create({
        data: { email, googleId },
        include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
      });
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId },
        include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
      });
    }

    const token = issueToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ==================== APPLE OAUTH ====================
// Frontend pošle identityToken z Apple Sign In
router.post('/apple', async (req, res, next) => {
  try {
    const { identityToken, firstName, lastName, email: appleEmail } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Chybí identityToken' });

    // Ověř podpis Apple Identity Tokenu přes JWKS endpoint
    let decoded;
    try {
      decoded = await verifyAppleToken(identityToken);
    } catch (verifyErr) {
      return res.status(401).json({ error: 'Neplatný Apple token', detail: verifyErr.message });
    }
    if (!decoded) return res.status(400).json({ error: 'Neplatný Apple token' });

    const appleId = decoded.sub;
    const email = appleEmail || decoded.email;

    let user = await prisma.user.findFirst({
      where: { OR: [{ appleId }, ...(email ? [{ email }] : [])] },
      include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
    });

    if (!user) {
      if (!email) return res.status(400).json({ error: 'E-mail je povinný při první registraci přes Apple' });
      user = await prisma.user.create({
        data: { email, appleId },
        include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
      });
    } else if (!user.appleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { appleId },
        include: { player: { include: { team: true, payment: true } }, referee: true, manager: { include: { team: true } } },
      });
    }

    const token = issueToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ==================== E-MAIL + HESLO ====================
//
// Klasické přihlášení vedle Google a Apple. Účty založené přes poskytovatele
// heslo nemají — u nich se uživateli řekne, kterou cestou se má přihlásit.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_HESLO = 8;

function normalizeEmail(email) {
  return (email ?? '').trim().toLowerCase();
}

// POST /auth/register – založení účtu e-mailem
router.post('/register', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Zadej platnou e-mailovou adresu' });
    }
    if (!password || password.length < MIN_HESLO) {
      return res.status(400).json({ error: `Heslo musí mít alespoň ${MIN_HESLO} znaků` });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.passwordHash) {
        return res.status(409).json({ error: 'Účet s tímto e-mailem už existuje. Přihlas se.' });
      }
      // Účet vznikl přes Google/Apple — heslo mu nedoplňujeme potichu,
      // jinak by šlo cizí účet převzít znalostí e-mailu.
      return res.status(409).json({
        error: 'Tento e-mail už je registrovaný přes Google nebo Apple. Přihlas se stejnou cestou.',
      });
    }

    const user = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
      include: { player: true, referee: true, manager: { include: { team: true } } },
    });

    const token = issueToken(user.id);
    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (err) { next(err); }
});

// POST /auth/login – přihlášení e-mailem
router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Vyplň e-mail i heslo' });
    }

    const user = await prisma.user.findUnique({
      where:   { email },
      include: { player: { include: { team: true } }, referee: true, manager: { include: { team: true } } },
    });

    // Uživatel existuje, ale vznikl přes poskytovatele — pošli ho správnou cestou.
    if (user && !user.passwordHash) {
      const cesta = user.appleId ? 'Apple' : user.googleId ? 'Google' : 'Google nebo Apple';
      return res.status(409).json({ error: `Tento účet používá přihlášení přes ${cesta}.` });
    }

    // Stejná hláška pro neexistující účet i špatné heslo, ať se nedá zjistit,
    // které e-maily jsou registrované.
    const ok = user && await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Nesprávný e-mail nebo heslo' });
    }

    const token = issueToken(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) { next(err); }
});

// PUT /auth/password – změna hesla přihlášeného uživatele
router.put('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < MIN_HESLO) {
      return res.status(400).json({ error: `Nové heslo musí mít alespoň ${MIN_HESLO} znaků` });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (user.passwordHash) {
      const ok = await bcrypt.compare(currentPassword ?? '', user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Současné heslo nesouhlasí' });
    }
    // Účet bez hesla (Google/Apple) si heslo může doplnit — je přihlášený,
    // takže vlastnictví účtu je prokázané.

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { passwordHash: await bcrypt.hash(newPassword, 10) },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== OBNOVA ZAPOMENUTÉHO HESLA ====================
//
// Uživatel si vyžádá šestimístný kód na e-mail a s ním si nastaví nové heslo.
// Kód jsme zvolili místo odkazu, protože nevyžaduje deep linky a zadá se
// rovnou v aplikaci.

const RESET_PLATNOST_MIN = 30;
const RESET_MAX_POKUSU   = 5;

/** Odpověď je vždy stejná, ať účet existuje nebo ne — jinak by šlo zjišťovat, kdo je registrovaný. */
const RESET_ODPOVED = { ok: true, message: 'Pokud účet existuje, poslali jsme na něj kód.' };

// POST /auth/forgot-password – vyžádání kódu
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Zadej platnou e-mailovou adresu' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Účet neexistuje → tváříme se stejně, ale nic neposíláme.
    if (!user) return res.json(RESET_ODPOVED);

    // Účet přes Google/Apple → pošleme vysvětlení, ne kód. E-mail jde majiteli
    // účtu, takže se tím nic neprozrazuje.
    if (!user.passwordHash) {
      const provider = user.appleId ? 'Apple' : user.googleId ? 'Google' : 'Google nebo Apple';
      const mail = providerAccountMail(provider);
      await sendMail({ to: email, ...mail });
      return res.json(RESET_ODPOVED);
    }

    // Starší nepoužité kódy zneplatníme, ať platí vždy jen ten poslední.
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data:  { usedAt: new Date() },
    });

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await prisma.passwordReset.create({
      data: {
        userId:    user.id,
        codeHash:  await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + RESET_PLATNOST_MIN * 60 * 1000),
      },
    });

    const mail = resetPasswordMail(code, RESET_PLATNOST_MIN);
    await sendMail({ to: email, ...mail });

    res.json(RESET_ODPOVED);
  } catch (err) { next(err); }
});

// POST /auth/reset-password – nastavení nového hesla pomocí kódu
router.post('/reset-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { code, newPassword } = req.body;

    if (!EMAIL_RE.test(email) || !code) {
      return res.status(400).json({ error: 'Vyplň e-mail i kód z e-mailu' });
    }
    if (!newPassword || newPassword.length < MIN_HESLO) {
      return res.status(400).json({ error: `Nové heslo musí mít alespoň ${MIN_HESLO} znaků` });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    const neplatny = { error: 'Kód je neplatný nebo vypršel. Vyžádej si nový.' };
    if (!user) return res.status(400).json(neplatny);

    const reset = await prisma.passwordReset.findFirst({
      where:   { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset) return res.status(400).json(neplatny);

    if (reset.attempts >= RESET_MAX_POKUSU) {
      await prisma.passwordReset.update({
        where: { id: reset.id },
        data:  { usedAt: new Date() },
      });
      return res.status(429).json({ error: 'Příliš mnoho pokusů. Vyžádej si nový kód.' });
    }

    const ok = await bcrypt.compare(String(code).trim(), reset.codeHash);
    if (!ok) {
      await prisma.passwordReset.update({
        where: { id: reset.id },
        data:  { attempts: { increment: 1 } },
      });
      return res.status(400).json(neplatny);
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data:  { passwordHash: await bcrypt.hash(newPassword, 10) },
      }),
      prisma.passwordReset.update({
        where: { id: reset.id },
        data:  { usedAt: new Date() },
      }),
    ]);

    const full = await prisma.user.findUnique({
      where:   { id: user.id },
      include: { player: { include: { team: true } }, referee: true, manager: { include: { team: true } } },
    });

    res.json({ token: issueToken(full.id), user: sanitizeUser(full) });
  } catch (err) { next(err); }
});

// ==================== ME ====================
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// ==================== PUSH TOKEN ====================
// PUT /auth/push-token – uloží Expo push token pro přihlášeného uživatele
router.put('/push-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Chybí token' });
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { pushToken: token },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== LOGOUT ====================
// JWT je stateless – stačí smazat token na klientovi
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    // Odstraň push token aby uživatel nedostával notifikace po odhlášení
    await prisma.user.update({
      where: { id: req.user.id },
      data:  { pushToken: null },
    });
    res.json({ message: 'Odhlášení úspěšné' });
  } catch (err) { next(err); }
});

// ==================== DELETE ACCOUNT ====================
router.delete('/account', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Smaž uživatele.
    // Player.userId a Referee.userId mají onDelete: SetNull → hráčská/rozhodčí data
    // (statistiky, zápasy) zůstanou zachována jako historická data.
    // Manager a Notification mají onDelete: Cascade → smažou se spolu s účtem.
    await prisma.user.delete({ where: { id: userId } });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Odstraní citlivé interní fieldy
function sanitizeUser(user) {
  const { googleId, appleId, ...safe } = user;
  // Klient nemá jak zjistit obsah SUPERVISOR_USER_IDS — musíme mu roli poslat.
  return { ...safe, isSupervisor: isSupervisorUser(user) };
}

module.exports = router;
