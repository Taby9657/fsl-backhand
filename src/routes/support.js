/**
 * Napiš Pandě — první linka.
 *
 * Zadání: `fsl-panda-ai-schopnosti-2026-09-21.md`, oddíl 3.7.
 *
 * **Rozhodování je celé v `services/panda-linka.js`**, protože se do vlákna
 * dá psát dvěma cestami — tudy (první zpráva) a přes `/chat/conversations`
 * (doptávání se). Dvě kopie téhle úvahy by se za měsíc rozešly.
 *
 * Pozor na dvě věci:
 *   · `muzePsat()` se tu NEVOLÁ. Na ligu se dostane i umlčený a zablokovaný
 *     člověk, jinak by se neměl jak bránit.
 *   · Příznak „čeká na ligu" shodí jen odpověď supervisora, žádné tlačítko.
 */

const express = require('express');
const router  = express.Router();

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const chat = require('../services/chat');
const linka = require('../services/panda-linka');

router.post('/message', requireAuth, async (req, res, next) => {
  try {
    const hrac = req.user?.player;
    if (!hrac) {
      return res.status(400).json({ error: 'Napsat Pandě z aplikace může jen hráč. Jinak piš na info@fslleague.cz' });
    }
    const text = (req.body?.body ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Napiš, o co jde' });

    const vlakno = await chat.vlaknoSLigou(hrac.id);

    const zprava = await prisma.message.create({
      data: { conversationId: vlakno.id, authorPlayerId: hrac.id, body: text, class: 'PROVOZNI' },
    });

    const vysledek = await linka.obsluz({
      konverzace: vlakno, hrac, text, zpravaId: zprava.id,
    });

    res.status(201).json({
      conversationId: vlakno.id,
      messageId: zprava.id,
      odpovedId: vysledek.zpravaId,
      akce: vysledek.akce,
      dueAt: vysledek.dueAt,
    });
  } catch (err) { next(err); }
});

module.exports = router;
