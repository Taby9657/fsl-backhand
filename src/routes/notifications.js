const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');

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

// PUT /notifications/read-all – označit vše jako přečtené
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data:  { read: true },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
