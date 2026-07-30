const express = require('express');
const https   = require('https');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const { issueToken, requireAuth } = require('../middleware/auth');

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
        audience:  process.env.APPLE_CLIENT_ID || 'cz.fsl.app',
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

// Odstraní citlivé interní fieldy
function sanitizeUser(user) {
  const { googleId, appleId, ...safe } = user;
  return safe;
}

module.exports = router;
