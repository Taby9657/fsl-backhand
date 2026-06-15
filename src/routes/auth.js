const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { issueToken, requireAuth } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ==================== GOOGLE OAUTH ====================
// Frontend pošle idToken z Google Sign-In SDK
router.post('/google', async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Chybí idToken' });

    // Ověření tokenu u Googlu
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub: googleId, email, name, picture } = ticket.getPayload();

    // Najdi nebo vytvoř uživatele
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
      include: { player: true, referee: true, manager: { include: { team: true } } },
    });

    if (!user) {
      user = await prisma.user.create({
        data: { email, googleId },
        include: { player: true, referee: true, manager: { include: { team: true } } },
      });
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId },
        include: { player: true, referee: true, manager: { include: { team: true } } },
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

    // Dekóduj bez ověření pro získání sub (Apple neposílá email opakovaně)
    const decoded = jwt.decode(identityToken);
    if (!decoded) return res.status(400).json({ error: 'Neplatný Apple token' });

    const appleId = decoded.sub;
    const email = appleEmail || decoded.email;

    let user = await prisma.user.findFirst({
      where: { OR: [{ appleId }, ...(email ? [{ email }] : [])] },
      include: { player: true, referee: true, manager: { include: { team: true } } },
    });

    if (!user) {
      if (!email) return res.status(400).json({ error: 'E-mail je povinný při první registraci přes Apple' });
      user = await prisma.user.create({
        data: { email, appleId },
        include: { player: true, referee: true, manager: { include: { team: true } } },
      });
    } else if (!user.appleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { appleId },
        include: { player: true, referee: true, manager: { include: { team: true } } },
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

// ==================== LOGOUT ====================
// JWT je stateless – stačí smazat token na klientovi
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Odhlášení úspěšné' });
});

// Odstraní citlivé interní fieldy
function sanitizeUser(user) {
  const { googleId, appleId, ...safe } = user;
  return safe;
}

module.exports = router;
