/**
 * Napsat lize — první linka.
 *
 * Zadání: `fsl-panda-ai-schopnosti-2026-09-21.md`, oddíl 3.7.
 *
 * **V E1 tu ještě netřídí žádný model.** Všechno jde rovnou supervisorovi
 * a hráč hned dostane odpověď, dokdy se liga ozve. Až přijde Panda (E2),
 * vlepí se třídění sem — zbytek (termín, připomínky, příznak na konverzaci)
 * zůstane, jak je.
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
const { createNotifications } = require('./notifications');

const DEN = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', weekday: 'long', day: 'numeric', month: 'numeric',
});

/** „ve středu 24. 9." — termín se hráči říká konkrétním dnem, ne „brzy". */
function terminSlovy(d) {
  return DEN.format(d).replace(/ /g, ' ');
}

router.post('/message', requireAuth, async (req, res, next) => {
  try {
    const hrac = req.user?.player;
    if (!hrac) {
      return res.status(400).json({ error: 'Napsat lize z aplikace může jen hráč. Jinak piš na info@fslleague.cz' });
    }
    const text = (req.body?.body ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Napiš, o co jde' });

    const vlakno = await chat.vlaknoSLigou(hrac.id);

    const zprava = await prisma.message.create({
      data: { conversationId: vlakno.id, authorPlayerId: hrac.id, body: text, class: 'PROVOZNI' },
    });

    // Termín: konec následujícího kalendářního dne v Praze. Když už jedna
    // věc čeká, druhý dotaz termín neposouvá — čeká se na tu první odpověď.
    const dueAt = vlakno.waitingSupervisor && vlakno.dueAt
      ? vlakno.dueAt
      : chat.konecDalsihoDne();

    await prisma.conversation.update({
      where: { id: vlakno.id },
      data: {
        lastMessageAt: new Date(),
        waitingSupervisor: true,
        dueAt,
        escalCategory: 'nezatrideno',
        escalReason: 'E1 — třídění zatím neběží, všechno jde na supervizora',
        overdueNotifiedAt: null,
      },
    });

    // Odpověď hráči hned, ať nečeká v tichu.
    const odpoved = await prisma.message.create({
      data: {
        conversationId: vlakno.id,
        authorPlayerId: chat.PANDA,
        class: 'PROVOZNI',
        body: `Předala jsem to lize. Ozve se ti nejpozději ${terminSlovy(dueAt)}.`,
      },
    });

    // Supervisoři to musí vidět hned — tohle je jejich fronta.
    const supervisori = await prisma.user.findMany({
      where: { isSupervisor: true }, select: { id: true },
    });
    await createNotifications(supervisori.map(u => ({
      userId: u.id,
      title: 'Nová zpráva pro ligu',
      body: `${hrac.firstName} ${hrac.lastName}: ${text.slice(0, 100)}`,
      screen: 'chat',
    })));

    res.status(201).json({
      conversationId: vlakno.id,
      messageId: zprava.id,
      odpovedId: odpoved.id,
      dueAt,
    });
  } catch (err) { next(err); }
});

module.exports = router;
