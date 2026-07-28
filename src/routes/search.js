const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// GET /search?q=xxx – globální vyhledávání hráčů, týmů, rozhodčích
router.get('/', async (req, res, next) => {
  try {
    const { q = '' } = req.query;
    const term = q.trim();

    if (term.length < 2) return res.json({ players: [], teams: [], referees: [] });

    const words = term.toLowerCase().split(/\s+/);

    // Pomocná funkce: odpovídá alespoň jedno slovo?
    function matchesSearch(fields) {
      return words.every(w => fields.some(f => (f ?? '').toLowerCase().includes(w)));
    }

    const [players, teams, referees] = await Promise.all([
      prisma.player.findMany({
        where: {
          OR: [
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName:  { contains: term, mode: 'insensitive' } },
          ],
        },
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
          OR: [
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName:  { contains: term, mode: 'insensitive' } },
          ],
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
