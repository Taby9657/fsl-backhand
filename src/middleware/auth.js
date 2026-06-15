const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Ověření JWT tokenu z Authorization headeru
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Chybí autorizační token' });
    }

    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        player: { include: { team: true } },
        referee: true,
        manager: { include: { team: true } },
      },
    });

    if (!user) return res.status(401).json({ error: 'Uživatel nenalezen' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Neplatný nebo expirovaný token' });
    }
    next(err);
  }
}

// Pouze supervisor (v prototypu: uživatel s referee.level === 'A' nebo speciální flag)
async function requireSupervisor(req, res, next) {
  await requireAuth(req, res, async () => {
    const isSupervisor = req.user?.player?.isSupervisor ||
      process.env.SUPERVISOR_USER_IDS?.split(',').includes(req.user.id);
    if (!isSupervisor) {
      return res.status(403).json({ error: 'Přístup pouze pro supervisory' });
    }
    next();
  });
}

// Vedoucí týmu
async function requireManager(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.user.manager || req.user.manager.length === 0) {
      return res.status(403).json({ error: 'Přístup pouze pro vedoucí týmu' });
    }
    next();
  });
}

function issueToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

module.exports = { requireAuth, requireSupervisor, requireManager, issueToken };
