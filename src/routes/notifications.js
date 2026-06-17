const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { sendPush } = require('../services/push');

const router = express.Router();
const prisma = new PrismaClient();

// GET /notifications – moje notifikace
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const notifs = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(notifs);
  } catch (err) { next(err); }
});

// PUT /notifications/read-all – označit vše jako přečtené (musí být PŘED /:id/read)
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data:  { read: true },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /notifications/:id/read – označit jako přečtenou
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notif || notif.userId !== req.user.id) {
      return res.status(404).json({ error: 'Notifikace nenalezena' });
    }
    const updated = await prisma.notification.update({
      where: { id: req.params.id },
      data:  { read: true },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /notifications – vytvoření notifikace se zasláním push (interní helper volán z jiných routes)
// Aby bylo snadné importovat a použít, exportujeme i helper funkci
async function createNotification(userId, title, body, screen = null) {
  const notif = await prisma.notification.create({
    data: { userId, title, body, screen },
  });
  // Pošli Expo push pokud má uživatel token
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true } });
  if (user?.pushToken) {
    await sendPush(user.pushToken, title, body, { screen });
  }
  return notif;
}

async function createNotifications(items) {
  // items: [{ userId, title, body, screen? }]
  if (!items?.length) return;
  await prisma.notification.createMany({ data: items });
  // Hromadný push
  const userIds = [...new Set(items.map(i => i.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, pushToken: { not: null } },
    select: { id: true, pushToken: true },
  });
  const tokenMap = Object.fromEntries(users.map(u => [u.id, u.pushToken]));
  for (const item of items) {
    const token = tokenMap[item.userId];
    if (token) await sendPush(token, item.title, item.body, { screen: item.screen });
  }
}

module.exports = router;
module.exports.createNotification  = createNotification;
module.exports.createNotifications = createNotifications;
