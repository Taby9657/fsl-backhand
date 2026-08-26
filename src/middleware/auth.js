const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

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

/**
 * Jediné místo, kde se rozhoduje, kdo je supervisor.
 *
 * Zdroje v pořadí důležitosti:
 *   1. User.isSupervisor — hlavní zdroj pravdy, spravuje se z aplikace
 *   2. Player.isSupervisor — historický příznak, držíme kvůli zpětné kompatibilitě
 *   3. env SUPERVISOR_USER_IDS — záchranná brzda, kdyby se v DB odebrali všichni
 */
function isSupervisorUser(user) {
  if (!user) return false;
  if (user.isSupervisor === true) return true;
  if (user.player?.isSupervisor === true) return true;
  const ids = (process.env.SUPERVISOR_USER_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return ids.includes(user.id);
}

async function requireSupervisor(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!isSupervisorUser(req.user)) {
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

module.exports = { requireAuth, requireSupervisor, requireManager, issueToken, isSupervisorUser };
