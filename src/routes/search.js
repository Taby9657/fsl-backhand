const express = require('express');


const router = express.Router();
const prisma = require('../lib/prisma');

// GET /search?q=xxx – globální vyhledávání hráčů, týmů, rozhodčích
router.get('/', async (req, res, next) => {
  try {
    const { q = '' } = req.query;
    const term = q.trim();

    if (term.length < 2) return res.json({ players: [], teams: [], referees: [] });

    const words = term.trim().split(/\s+/);

    // Prisma WHERE pro split-word hledání: každé slovo musí odpovídat aspoň jednomu poli
    // "Jan Novák" → firstName contains "Jan" AND lastName contains "Novák" (nebo obráceně)
    function playerWhere(words) {
      if (words.length === 1) {
        return { OR: [
          { firstName: { contains: words[0], mode: 'insensitive' } },
          { lastName:  { contains: words[0], mode: 'insensitive' } },
        ]};
      }
      // Víc slov: zkusíme [firstName=word1 AND lastName=word2] NEBO [firstName=word2 AND lastName=word1]
      // + fallback pro každé slovo zvlášť
      return { OR: [
        { AND: words.map(w => ({ OR: [
          { firstName: { contains: w, mode: 'insensitive' } },
          { lastName:  { contains: w, mode: 'insensitive' } },
        ]}))},
      ]};
    }

    const [players, teams, referees] = await Promise.all([
      prisma.player.findMany({
        where: playerWhere(words),
        select: {
          id: true, firstName: true, lastName: true,
          jersey: true, position: true, photoUrl: true,
          team: { select: { id: true, name: true, abbr: true, color: true } },
        },
        take: 10,
        orderBy: [{ lastName: 'asc' }],
      }),

      prisma.team.findMany({
        where: {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { abbr: { contains: term, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, abbr: true, color: true, division: true },
        take: 8,
        orderBy: { name: 'asc' },
      }),

      prisma.referee.findMany({
        where: {
          status: 'APPROVED',
          ...playerWhere(words),
        },
        select: { id: true, firstName: true, lastName: true, level: true, photoUrl: true },
        take: 8,
        orderBy: [{ lastName: 'asc' }],
      }),
    ]);

    res.json({ players, teams, referees });
  } catch (err) { next(err); }
});

module.exports = router;
