const express  = require('express');
const multer   = require('multer');
const { PrismaClient } = require('@prisma/client');
const { requireAuth, requireSupervisor } = require('../middleware/auth');
const { cloudinary } = require('../utils/fileUpload'); // sdílená nakonfigurovaná instance

const router = express.Router();
const prisma = new PrismaClient();

// Memory storage – přijme soubor do bufferu, pak SDK upload stream do Cloudinary
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// GET /highlights – veřejný endpoint, posledních 10 highlights
router.get('/', async (req, res, next) => {
  try {
    const highlights = await prisma.roundHighlight.findMany({
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    res.json(highlights);
  } catch (err) { next(err); }
});

// POST /highlights – supervisor vytvoří highlight
router.post('/', requireAuth, requireSupervisor, async (req, res, next) => {
  try {
    const { round, title, body, imageUrl, pinned } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Chybí title nebo body' });

    const highlight = await prisma.roundHighlight.create({
      data: {
        round:    round ? parseInt(round) : null,
        title,
        body,
        imageUrl: imageUrl || null,
        pinned:   pinned ?? false,
      },
    });
    res.status(201).json(highlight);
  } catch (err) { next(err); }
});

// PUT /highlights/:id – supervisor upraví highlight
router.put('/:id', requireAuth, requireSupervisor, async (req, res, next) => {
  try {
    const { round, title, body, imageUrl, pinned } = req.body;
    const data = {};
    if (title !== undefined)    data.title    = title;
    if (body !== undefined)     data.body     = body;
    if (imageUrl !== undefined) data.imageUrl = imageUrl || null;
    if (pinned !== undefined)   data.pinned   = pinned;
    if (round !== undefined)    data.round    = round ? parseInt(round) : null;

    const highlight = await prisma.roundHighlight.update({
      where: { id: req.params.id },
      data,
    });
    res.json(highlight);
  } catch (err) { next(err); }
});

// POST /highlights/:id/video – přímý upload videa přes Cloudinary SDK
router.post('/:id/video', requireAuth, requireSupervisor, memUpload.single('video'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'fsl/highlights', resource_type: 'auto' },
        (err, r) => { if (err) reject(err); else resolve(r); }
      );
      stream.end(req.file.buffer);
    });

    const highlight = await prisma.roundHighlight.update({
      where: { id: req.params.id },
      data:  { videoUrl: result.secure_url },
    });
    res.json(highlight);
  } catch (err) { next(err); }
});

// DELETE /highlights/:id – supervisor smaže highlight
router.delete('/:id', requireAuth, requireSupervisor, async (req, res, next) => {
  try {
    await prisma.roundHighlight.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
