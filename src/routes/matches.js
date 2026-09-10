const express = require('express');

const { requireAuth, requireSupervisor, isSupervisorUser } = require('../middleware/auth');
const { createNotifications } = require('./notifications');
const { sendPush } = require('../services/push');
const { VEREJNY_HRAC, VEREJNA_PLATBA } = require('../utils/verejneUdaje');
const pocty  = require('../services/pocty');
const kredit = require('../services/kredit');
const pokuty = require('../services/pokuty');

const router = express.Router();
const prisma = require('../lib/prisma');
const licence = require('../services/licence');

// GET /matches/bracket?division=X&season=Y – play-off pavouk
router.get('/bracket', async (req, res, next) => {
  try {
    const { division, season, leagueId, conferenceId, divisionId } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        phase: 'PLAYOFF',
        round: { not: null },
        // Nová struktura má přednost; textová divize zůstává pro staré zápasy
        ...(divisionId   ? { divisionId }   : {}),
        ...(conferenceId ? { conferenceId } : {}),
        ...(leagueId     ? { leagueId }     : {}),
        ...(division && !leagueId && !conferenceId && !divisionId ? { division } : {}),
        ...(season   && { season }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
      },
      orderBy: [{ round: 'asc' }, { date: 'asc' }],
    });

    // Seskup kola
    const rounds = {};
    for (const m of matches) {
      if (m.round == null) continue;
      if (!rounds[m.round]) rounds[m.round] = [];
      rounds[m.round].push(m);
    }
    res.json(rounds);
  } catch (err) { next(err); }
});

// GET /matches – seznam zápasů
router.get('/', async (req, res, next) => {
  try {
    const { status, teamId, homeTeamId, refereeId, division, season, limit = '50', offset = '0' } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status     && { status }),
        ...(division   && { division }),
        ...(season     && { season }),
        ...(refereeId  && { refereeId }),
        ...(homeTeamId && { homeTeamId }),
        ...(teamId     && { OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true, logoUrl: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
        _count:   { select: { events: true } },
      },
      orderBy: { date: status === 'UPCOMING' ? 'asc' : 'desc' },
      take:  parseInt(limit),
      skip:  parseInt(offset),
    });
    res.json(matches);
  } catch (err) { next(err); }
});

// GET /matches/:id – detail zápasu
router.get('/:id', async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        homeTeam: true,
        awayTeam: true,
        // Rozhodčí má v tabulce i rodné číslo, adresu a číslo účtu — ven jde
        // jen to, co ukazuje detail zápasu
        referee:  { select: { id: true, firstName: true, lastName: true, level: true, status: true, photoUrl: true } },
        events: {
          include: {
            scorer:  { select: VEREJNY_HRAC },
            assist:  { select: VEREJNY_HRAC },
            penalty: { select: VEREJNY_HRAC },
          },
          orderBy: [{ period: 'asc' }, { minute: 'asc' }],
        },
        lineups: {
          include: {
            players: {
              // Soupiska je veřejná — z platby jde ven jen stav licence pro odznak
              include: { player: { select: { ...VEREJNY_HRAC, payment: { select: VEREJNA_PLATBA } } } },
            },
          },
        },
        postmatches: { include: { opponentMvp: { select: VEREJNY_HRAC } } },
      },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    res.json(match);
  } catch (err) { next(err); }
});

// POST /matches – vytvoření zápasu (pouze supervisor)
router.post('/', requireSupervisor, async (req, res, next) => {
  try {
    const { homeTeamId, awayTeamId, refereeId, date, venue, competition, division, season, round, phase } = req.body;
    if (!homeTeamId || !awayTeamId || !date) {
      return res.status(400).json({ error: 'Chybí povinné údaje (domácí, hosté, datum)' });
    }
    const match = await prisma.match.create({
      data: {
        homeTeamId,
        awayTeamId,
        refereeId:   refereeId || null,
        date:        new Date(date),
        venue:       venue || null,
        competition: competition || 'FSL Liga',
        division:    division   || 'Divize A',
        season:      season     || null,
        round:       round      ? parseInt(round) : null,
        phase:       phase === 'PLAYOFF' ? 'PLAYOFF' : 'REGULAR',
      },
      include: { homeTeam: true, awayTeam: true, referee: true },
    });
    res.status(201).json(match);
  } catch (err) { next(err); }
});

// PUT /matches/:id – úprava zápasu (supervisor)
router.put('/:id', requireSupervisor, async (req, res, next) => {
  try {
    const { refereeId, date, venue, status, homeScore, awayScore,
            homeTeamId, awayTeamId, round, division, competition, season, phase } = req.body;
    const match = await prisma.match.update({
      where: { id: req.params.id },
      data: {
        ...(refereeId    !== undefined && { refereeId: refereeId || null }),
        ...(date         && { date: new Date(date) }),
        ...(venue        !== undefined && { venue: venue || null }),
        ...(status       && { status }),
        ...(phase        && ['REGULAR', 'PLAYOFF'].includes(phase) && { phase }),
        ...(homeScore    !== undefined && { homeScore: parseInt(homeScore) }),
        ...(awayScore    !== undefined && { awayScore: parseInt(awayScore) }),
        ...(homeTeamId   && { homeTeamId }),
        ...(awayTeamId   && { awayTeamId }),
        ...(round        !== undefined && { round: round ? parseInt(round) : null }),
        ...(division     && { division }),
        ...(competition  && { competition }),
        ...(season       && { season }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
        referee:  { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Zrušený zápas nikdo neodehrál — rezervované starty se vrací do balíčků.
    if (status === 'CANCELLED') await kredit.vratZapas(match.id);

    res.json(match);
  } catch (err) { next(err); }
});

// POST /matches/:id/start – rozhodčí zahájí zápas (UPCOMING → LIVE)
router.post('/:id/start', requireAuth, async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: { homeTeam: true, awayTeam: true },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'UPCOMING') return res.status(400).json({ error: 'Zápas musí být ve stavu UPCOMING' });
    const referee = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee = referee && match.refereeId === referee.id;
    const isSup = isSupervisorUser(req.user);
    if (!isReferee && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });

    // Kontrola sestav — 8 + 1 minimum, 15 + 2 maximum (limity v pocty.js).
    //
    // Dřív se počítalo devět lidí celkem plus „někdo je brankář", takže
    // sestava 7 do pole a 2 brankáři prošla. Pole a brankáři se proto
    // počítají zvlášť, a kdo je brankář, rozhoduje soupiska (`TeamRoster.slot`),
    // ne volný text `Player.position`.
    const lineups = await prisma.lineupSubmission.findMany({
      where:   { matchId: req.params.id },
      include: { players: { select: { playerId: true } } },
    });
    const sloty = await prisma.teamRoster.findMany({
      where:  { teamId: { in: [match.homeTeamId, match.awayTeamId] }, season: match.season },
      select: { playerId: true, teamId: true, slot: true },
    });
    const slotHrace = new Map(sloty.map(r => [`${r.teamId}:${r.playerId}`, r.slot]));
    const spocitej = (lineup, teamId) => pocty.rozdel(
      (lineup?.players ?? []).map(p => ({ slot: slotHrace.get(`${teamId}:${p.playerId}`) })),
    );

    const errors = [
      ...pocty.zkontrolujSestavu(
        spocitej(lineups.find(l => l.teamId === match.homeTeamId), match.homeTeamId),
        match.homeTeam.abbr),
      ...pocty.zkontrolujSestavu(
        spocitej(lineups.find(l => l.teamId === match.awayTeamId), match.awayTeamId),
        match.awayTeam.abbr),
    ];
    if (errors.length > 0) {
      return res.status(400).json({
        error: `Nelze zahájit zápas – ${errors.join('; ')}.`,
        code:  'LINEUP_INCOMPLETE',
      });
    }

    // Nezaplacená pokuta za kontumaci brání dalšímu zápasu. Bez tohohle
    // by vymáhání zůstalo na organizátorovi — takhle buď tým zaplatí,
    // nebo nehraje. Supervisor to přes `force` pustí (dohoda o splátce).
    const dluzi = [
      ...(await pokuty.nezaplacene(match.homeTeamId)).map(p => ({ ...p, tym: match.homeTeam.abbr })),
      ...(await pokuty.nezaplacene(match.awayTeamId)).map(p => ({ ...p, tym: match.awayTeam.abbr })),
    ];
    if (dluzi.length > 0 && !(isSup && req.body?.force === true)) {
      const celkem = dluzi.reduce((s, p) => s + (p.amount - p.paidAmount), 0);
      return res.status(400).json({
        error: `Nelze zahájit zápas – ${[...new Set(dluzi.map(p => p.tym))].join(' a ')} `
             + `má nezaplacenou pokutu za kontumaci (${celkem} Kč).`,
        code:  'FINE_UNPAID',
        fines: dluzi.map(p => ({ id: p.id, teamId: p.teamId, amount: p.amount, paidAmount: p.paidAmount })),
      });
    }

    // Zápasy platí hráči, ne týmy: podmínkou pro zahájení je, že každý
    // v sestavě má start z balíčku. Dřív se tu hlídalo, jestli domácí tým
    // poslal 2 200 Kč — ta platba od 9. 9. 2026 neexistuje.
    // Supervisor může přes `force` pustit zápas i tak (dohoda, platba na místě).
    const vsichni = lineups.flatMap(l => (l.players ?? []).map(p => p.playerId));
    const bezStartu = await kredit.chybejiciStarty(match.id, vsichni);
    if (bezStartu.length > 0) {
      if (!(isSup && req.body?.force === true)) {
        const jmena = await prisma.player.findMany({
          where:  { id: { in: bezStartu } },
          select: { id: true, firstName: true, lastName: true },
        });
        const vypis = jmena.map(p => `${p.firstName} ${p.lastName}`).join(', ');
        return res.status(400).json({
          error: `Nelze zahájit zápas – bez zaplaceného startu: ${vypis}.`,
          code:  'NO_CREDIT_LINEUP',
          players: jmena,
        });
      }
      console.warn(`[Matches] Zápas ${match.id} zahájen supervizorem, ${bezStartu.length} hráčů bez startu.`);
    }

    const updated = await prisma.match.update({
      where: { id: req.params.id },
      data:  { status: 'LIVE' },
    });

    // Push notifikace hráčům obou týmů
    try {
      const players = await prisma.player.findMany({
        where:  { teamId: { in: [match.homeTeamId, match.awayTeamId] } },
        select: { user: { select: { pushToken: true } } },
      });
      const tokens = players.map(p => p.user?.pushToken).filter(Boolean);
      await sendPush(
        tokens,
        '⚡ Zápas právě začal!',
        `${match.homeTeam.abbr} vs ${match.awayTeam.abbr} · sleduj živé skóre`,
        { screen: `match/${match.id}` }
      );
    } catch { /* push je nepovinný */ }

    res.json(updated);
  } catch (err) { next(err); }
});

// POST /matches/:id/forfeit – kontumace (supervisor)
//
// Zápas zůstane ve stavu DONE se skóre 5:0, jen dostane značku
// `forfeitTeamId`. Tabulka se tak dopočítá sama a nemusí o kontumaci vědět;
// statistiky hráčů si ji naopak odfiltrují, protože se nehrálo.
router.post('/:id/forfeit', requireSupervisor, async (req, res, next) => {
  try {
    const { teamId, reason } = req.body ?? {};
    const match = await prisma.match.findUnique({
      where:   { id: req.params.id },
      include: { homeTeam: true, awayTeam: true },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.forfeitTeamId) {
      return res.status(409).json({ error: 'Zápas už je kontumovaný', code: 'ALREADY_FORFEITED' });
    }
    if (match.status === 'DONE') {
      return res.status(400).json({
        error: 'Odehraný zápas nejde kontumovat. Nejdřív ho vrať do UPCOMING.',
        code:  'ALREADY_PLAYED',
      });
    }
    if (![match.homeTeamId, match.awayTeamId].includes(teamId)) {
      return res.status(400).json({ error: 'teamId musí být jeden z týmů zápasu' });
    }

    const domaciVinen = teamId === match.homeTeamId;
    const vinik  = domaciVinen ? match.homeTeam : match.awayTeam;
    const souper = domaciVinen ? match.awayTeam : match.homeTeam;

    // Skóre, starty i pokuta patří k sobě — buď projde všechno, nebo nic.
    const { updated, kontumace, pokuta } = await prisma.$transaction(async (tx) => {
      const updated = await tx.match.update({
        where: { id: match.id },
        data:  {
          status:        'DONE',
          homeScore:     domaciVinen ? 0 : 5,
          awayScore:     domaciVinen ? 5 : 0,
          forfeitTeamId: teamId,
        },
        include: { homeTeam: true, awayTeam: true },
      });
      const kontumace = await kredit.vyresKontumaci(match.id, teamId, tx);
      const { pokuta } = await pokuty.predepis(match, teamId, tx);
      return { updated, kontumace, pokuta };
    });

    // Hráčům viníka propadl start, soupeři se vrátil — obojí je potřeba říct.
    const [hraciVinika, hraciSoupere] = await Promise.all([
      prisma.matchEntry.findMany({
        where:  { matchId: match.id, teamId },
        select: { player: { select: { userId: true } } },
      }),
      prisma.matchEntry.findMany({
        where:  { matchId: match.id, teamId: { not: teamId } },
        select: { player: { select: { userId: true } } },
      }),
    ]);
    const datum = new Date(match.date).toLocaleDateString('cs-CZ');
    await createNotifications([
      ...hraciVinika.filter(e => e.player?.userId).map(e => ({
        userId: e.player.userId,
        title:  'Kontumace — start propadl',
        body:   `Zápas ${datum} proti ${souper.abbr} skončil kontumací 5:0. Start z balíčku propadl.`,
        screen: `match/${match.id}`,
      })),
      ...hraciSoupere.filter(e => e.player?.userId).map(e => ({
        userId: e.player.userId,
        title:  'Kontumace — start se vrátil',
        body:   `${vinik.abbr} se ${datum} nedostavil. Zápas končí 5:0 pro vás a start máte zpátky v balíčku.`,
        screen: `match/${match.id}`,
      })),
    ]);

    // Vedoucí viníka musí vědět o pokutě — bez zaplacení další zápas nerozehraje.
    const vedouciVinika = await prisma.manager.findMany({
      where:  { teamId },
      select: { userId: true },
    });
    await createNotifications(vedouciVinika.map(m => ({
      userId: m.userId,
      title:  `Pokuta za kontumaci ${pokuta.amount} Kč`,
      body:   `${reason?.trim() || pokuta.reason} Dokud není zaplacená, další zápas rozhodčí nespustí.`,
      screen: 'payments',
    })));

    // Po třetí kontumaci tým ze soutěže končí — ale vyloučení je rozhodnutí
    // s dopadem na rozlosování i na peníze ostatních, takže ho nedělá systém.
    const kontumaciCelkem = await pokuty.pocetKontumaci(teamId, match.season);
    if (kontumaciCelkem >= 3) {
      const { ohlasSupervisorum } = require('../services/bankSync');
      await ohlasSupervisorum(
        `${vinik.name}: třetí kontumace`,
        `Tým má v sezóně ${match.season} už ${kontumaciCelkem} kontumace. Podle pravidel `
        + 'v tuhle chvíli ze soutěže končí — rozhodnutí je na tobě.',
      );
    }

    res.json({ match: updated, kontumace, pokuta, kontumaciCelkem });
  } catch (err) { next(err); }
});

// POST /matches/:id/end – rozhodčí ukončí zápas (LIVE → DONE)
router.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'LIVE') return res.status(400).json({ error: 'Zápas musí být ve stavu LIVE' });
    const referee = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee = referee && match.refereeId === referee.id;
    const isSup = isSupervisorUser(req.user);
    if (!isReferee && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const updated = await prisma.match.update({
      where: { id: req.params.id },
      data:  { status: 'DONE' },
      include: { homeTeam: true, awayTeam: true },
    });

    // Odehraný zápas mění rezervace na skutečné odpočty z balíčků.
    await kredit.zuctujZapas(req.params.id);

    // Notifikace oběma vedoucím
    const managerIds = await prisma.manager.findMany({
      where: { teamId: { in: [match.homeTeamId, match.awayTeamId] } },
      select: { userId: true },
    });
    await createNotifications(managerIds.map(m => ({
      userId: m.userId,
      title:  'Zápas ukončen',
      body:   `${updated.homeTeam.abbr} ${updated.homeScore}:${updated.awayScore} ${updated.awayTeam.abbr} – vyplňte prosím postmatch formulář`,
      screen: 'postmatch',
    })));

    res.json(updated);
  } catch (err) { next(err); }
});

// ==================== UDÁLOSTI (GÓLY, TRESTY) ====================

// POST /matches/:id/events – přidání události (gól/trest – vedoucí nebo supervisor)
router.post('/:id/events', requireAuth, async (req, res, next) => {
  try {
    const { type, minute, period, teamId, scorerId, assistId, penaltyId, penaltyType } = req.body;
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });

    // BUG-08: Lze přidávat události pouze do LIVE zápasů
    if (match.status !== 'LIVE') {
      return res.status(400).json({ error: 'Události lze přidávat pouze do probíhajícího (LIVE) zápasu' });
    }

    const isManager    = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = isSupervisorUser(req.user);
    const referee      = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee    = referee && match.refereeId === referee.id;
    if (!isManager && !isSupervisor && !isReferee) return res.status(403).json({ error: 'Nemáte oprávnění' });

    // BUG-03 OPRAVA: Ověř že teamId patří do tohoto zápasu
    if (teamId && teamId !== match.homeTeamId && teamId !== match.awayTeamId) {
      return res.status(400).json({ error: 'Zadaný tým nepatří do tohoto zápasu' });
    }

    // Validace event type
    const VALID_TYPES = ['GOAL', 'PENALTY', 'SHOOTOUT_GOAL', 'SHOOTOUT_MISS', 'PERIOD_END', 'MATCH_END'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `Neplatný typ události. Povolené: ${VALID_TYPES.join(', ')}` });
    }
    // teamId povinné pro gól
    if ((type === 'GOAL' || type === 'SHOOTOUT_GOAL') && !teamId) {
      return res.status(400).json({ error: 'teamId je povinné pro gól' });
    }
    // Validace minuty
    const minuteParsed = parseInt(minute);
    if (isNaN(minuteParsed) || minuteParsed < 0 || minuteParsed > 200) {
      return res.status(400).json({ error: 'Neplatná minuta zápasu' });
    }

    // ── Hráči v události musí být na soupisce svého týmu ──
    // Bez téhle kontroly šlo za běhu zápasu zapsat gól komukoli z ligy,
    // a tím fakticky obejít soupisku i pravidla licencí.
    const dotceni = [scorerId, assistId, penaltyId].filter(Boolean);
    if (dotceni.length > 0) {
      if (!teamId) {
        return res.status(400).json({ error: 'teamId je povinné, když událost odkazuje na hráče' });
      }
      const naSoupisce = await prisma.lineupPlayer.findMany({
        where: {
          playerId: { in: dotceni },
          lineup:   { matchId: req.params.id, teamId },
        },
        select: { playerId: true },
      });
      const povoleni = new Set(naSoupisce.map(l => l.playerId));
      const mimo = [...new Set(dotceni)].filter(id => !povoleni.has(id));

      if (mimo.length > 0) {
        const kdo = await prisma.player.findMany({
          where:  { id: { in: mimo } },
          select: { id: true, firstName: true, lastName: true, jersey: true },
        });
        return res.status(422).json({
          error: 'Událost odkazuje na hráče, který není na soupisce tohoto týmu',
          code:  'NOT_IN_LINEUP',
          players: kdo,
        });
      }
    }

    const event = await prisma.matchEvent.create({
      data: {
        matchId: req.params.id,
        type,
        minute:      minuteParsed,
        period:      parseInt(period) || 1,
        teamId:      teamId    || null,
        scorerId:    scorerId  || null,
        assistId:    assistId  || null,
        penaltyId:   penaltyId || null,
        penaltyType: penaltyType || null,
      },
      include: { scorer: true, assist: true, penalty: true },
    });

    // Aktualizuj skóre při gólu
    if (type === 'GOAL' || type === 'SHOOTOUT_GOAL') {
      const isHome = teamId === match.homeTeamId;
      await prisma.match.update({
        where: { id: req.params.id },
        data: isHome
          ? { homeScore: { increment: 1 } }
          : { awayScore: { increment: 1 } },
      });
    }

    res.status(201).json(event);
  } catch (err) { next(err); }
});

// DELETE /matches/:id/events/:eventId – smazání události
router.delete('/:id/events/:eventId', requireAuth, async (req, res, next) => {
  try {
    const event = await prisma.matchEvent.findUnique({ where: { id: req.params.eventId } });
    if (!event || event.matchId !== req.params.id) return res.status(404).json({ error: 'Událost nenalezena' });

    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'LIVE') return res.status(400).json({ error: 'Události lze mazat pouze v probíhajícím zápasu' });
    const isManager    = req.user.manager?.some(m => m.teamId === match.homeTeamId || m.teamId === match.awayTeamId);
    const isSupervisor = isSupervisorUser(req.user);
    const referee2     = await prisma.referee.findUnique({ where: { userId: req.user.id } });
    const isReferee2   = referee2 && match.refereeId === referee2.id;
    if (!isManager && !isSupervisor && !isReferee2) return res.status(403).json({ error: 'Nemáte oprávnění' });

    await prisma.matchEvent.delete({ where: { id: req.params.eventId } });

    // Reverzní update skóre — BUG-07: chráníme před záporným skóre
    if (event.type === 'GOAL' || event.type === 'SHOOTOUT_GOAL') {
      const isHome = event.teamId === match.homeTeamId;
      const currentScore = isHome ? match.homeScore : match.awayScore;
      if (currentScore > 0) {
        await prisma.match.update({
          where: { id: req.params.id },
          data: isHome
            ? { homeScore: { decrement: 1 } }
            : { awayScore: { decrement: 1 } },
        });
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SOUPISKY ====================

// PUT /matches/:id/lineup/:teamId – odeslání soupisk
router.put('/:id/lineup/:teamId', requireAuth, async (req, res, next) => {
  try {
    const { players, force } = req.body; // force=true přeskočí kontrolu licencí
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    const isSup     = isSupervisorUser(req.user);
    // Supervisor sem musí, jinak by otevřenému týmu (bez živého vedoucího)
    // sestavu nikdo neodeslal.
    if (!isManager && !isSup) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    // BUG-02 OPRAVA: Validace pole players před dalším zpracováním
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'Pole players musí být neprázdné pole hráčů' });
    }

    // ── Kontrola stavu zápasu ──
    const matchCheck = await prisma.match.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, homeTeamId: true, awayTeamId: true, season: true, phase: true },
    });
    if (!matchCheck) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (['LIVE', 'DONE'].includes(matchCheck.status)) {
      return res.status(400).json({ error: 'Zápas již probíhá nebo skončil – soupisku nelze měnit' });
    }

    // BUG-13 OPRAVA: Ověř že teamId patří do tohoto zápasu
    if (req.params.teamId !== matchCheck.homeTeamId && req.params.teamId !== matchCheck.awayTeamId) {
      return res.status(400).json({ error: 'Zadaný tým nepatří do tohoto zápasu' });
    }

    // ── Kontrola licencí a nároku na start ──
    // `force` je úleva jen pro chybějící základní licenci (vedoucí ji odešle
    // a poplatek se doplatí). Pravidla superlicence se obejít nedají — to jsou
    // soutěžní pravidla, ne administrativa.
    {
      const playerIds = players.map(p => p.playerId);
      const problemy  = [];

      for (const playerId of playerIds) {
        const vysledek = await licence.overNastup(playerId, req.params.teamId, matchCheck);
        if (!vysledek.ok) problemy.push({ playerId, ...vysledek });
      }

      const zbyva = force ? problemy.filter(p => p.code !== 'NO_LICENCE') : problemy;

      if (zbyva.length > 0) {
        const details = await prisma.player.findMany({
          where:  { id: { in: zbyva.map(p => p.playerId) } },
          select: { id: true, firstName: true, lastName: true, jersey: true },
        });
        const blocked = zbyva.map(p => ({
          ...(details.find(d => d.id === p.playerId) ?? { id: p.playerId }),
          code:   p.code,
          reason: p.error,
        }));

        // Když jde jen o chybějící základní licenci, držíme původní kód —
        // aplikace na něj má navázanou nabídku „odeslat i tak".
        const jenLicence = blocked.every(b => b.code === 'NO_LICENCE');
        return res.status(422).json({
          error: jenLicence
            ? 'Soupiska obsahuje hráče bez platné licence'
            : 'Soupiska obsahuje hráče, kteří za tenhle tým nastoupit nemohou',
          code:  jenLicence ? 'UNLICENSED_PLAYERS' : 'INELIGIBLE_PLAYERS',
          unlicensed: blocked,
          blocked,
        });
      }
    }

    // ── Počty v sestavě ──
    // Maximum se hlídá tady, minimum až u začátku zápasu — vedoucí si sestavu skládá
    // postupně a nemá smysl mu bránit v uložení rozdělané práce.
    const sloty = await prisma.teamRoster.findMany({
      where:  { teamId: req.params.teamId, season: matchCheck.season },
      select: { playerId: true, slot: true },
    });
    const slotHrace = new Map(sloty.map(r => [r.playerId, r.slot]));
    const stav = pocty.rozdel(players.map(p => ({ slot: slotHrace.get(p.playerId) })));

    if (stav.pole > pocty.SESTAVA.maxPole || stav.brankaru > pocty.SESTAVA.maxBrankaru) {
      return res.status(422).json({
        error: `Sestava smí mít nejvýš ${pocty.SESTAVA.maxPole} hráčů do pole `
             + `a ${pocty.SESTAVA.maxBrankaru} brankáře (má ${stav.pole} + ${stav.brankaru})`,
        code:  'LINEUP_TOO_BIG',
        counts: stav,
      });
    }

    // ── Balíčky zápasů a zápis sestavy ──
    // Rezervace i sestava vznikají v jedné transakci: kdyby zápis sestavy
    // spadl, nesmí hráčům zůstat stržené starty.
    const vysledek = await prisma.$transaction(async (tx) => {
      const bezKreditu = await kredit.srovnejRezervace(
        matchCheck, req.params.teamId, players.map(p => p.playerId), tx);

      if (bezKreditu.length > 0) return { bezKreditu };

      const lineup = await tx.lineupSubmission.upsert({
        where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
        create: {
          matchId: req.params.id,
          teamId:  req.params.teamId,
          players: { create: players },
        },
        update: {
          confirmed: false,
          players: {
            deleteMany: {},
            create: players,
          },
        },
        include: { players: { include: { player: true } } },
      });
      return { lineup };
    });

    if (vysledek.bezKreditu) {
      const details = await prisma.player.findMany({
        where:  { id: { in: vysledek.bezKreditu.map(p => p.playerId) } },
        select: { id: true, firstName: true, lastName: true, jersey: true },
      });
      return res.status(422).json({
        error: 'Někteří hráči nemají volný zápas v balíčku',
        code:  'NO_CREDIT',
        blocked: vysledek.bezKreditu.map(p => ({
          ...(details.find(d => d.id === p.playerId) ?? { id: p.playerId }),
          code:   p.code,
          reason: p.error,
        })),
      });
    }

    res.json(vysledek.lineup);
  } catch (err) { next(err); }
});

/**
 * POST /matches/:id/lineup/:teamId/add – doplnění hráče za běhu zápasu.
 *
 * Pro pozdní příchody. Záměrně mnohem přísnější než skládání soupisky před
 * zápasem: jen kmenový hráč vlastního týmu s platnou licencí. Hosta už
 * po zahájení přidat nejde, aby nešlo přivolat posilu podle vývoje zápasu.
 * Doplnění zůstane v zápise označené.
 */
router.post('/:id/lineup/:teamId/add', requireAuth, async (req, res, next) => {
  try {
    const { playerId, isGoalkeeper = false } = req.body;
    const { id: matchId, teamId } = req.params;

    if (!playerId) return res.status(400).json({ error: 'Chybí playerId' });

    const jeVedouci    = req.user.manager?.some(m => m.teamId === teamId);
    const jeSupervisor = isSupervisorUser(req.user);
    if (!jeVedouci && !jeSupervisor) {
      return res.status(403).json({ error: 'Nejsi vedoucí tohoto týmu' });
    }

    const match = await prisma.match.findUnique({
      where:  { id: matchId },
      select: { id: true, status: true, homeTeamId: true, awayTeamId: true, season: true, phase: true },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (teamId !== match.homeTeamId && teamId !== match.awayTeamId) {
      return res.status(400).json({ error: 'Zadaný tým nepatří do tohoto zápasu' });
    }
    if (match.status !== 'LIVE') {
      return res.status(400).json({
        error: 'Takhle se doplňuje jen do probíhajícího zápasu. Před zápasem uprav rovnou soupisku.',
      });
    }

    const player = await prisma.player.findUnique({
      where:  { id: playerId },
      select: { id: true, teamId: true, firstName: true, lastName: true, jersey: true, payment: true },
    });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });

    // Jen vlastní kmenový hráč — hosté se za běhu zápasu nepřidávají
    if (player.teamId !== teamId) {
      return res.status(422).json({
        error: 'Za běhu zápasu lze doplnit jen hráče z vlastní soupisky, ne hostujícího',
        code:  'GUEST_NOT_ALLOWED_LIVE',
      });
    }
    if (!licence.maZakladniLicenci(player.payment)) {
      return res.status(422).json({
        error: 'Hráč nemá platnou licenci',
        code:  'NO_LICENCE',
      });
    }

    const lineup = await prisma.lineupSubmission.findUnique({
      where: { matchId_teamId: { matchId, teamId } },
    });
    if (!lineup) return res.status(404).json({ error: 'Tým nemá pro tenhle zápas soupisku' });

    const uz = await prisma.lineupPlayer.findUnique({
      where: { lineupId_playerId: { lineupId: lineup.id, playerId } },
    });
    if (uz) return res.status(409).json({ error: 'Hráč už na soupisce je' });

    // Doplněním se nesmí přeskočit ani strop sestavy, ani balíček —
    // jinak by se tudy obešlo obojí.
    const naSoupisceSloty = await prisma.teamRoster.findMany({
      where:  { teamId, season: match.season },
      select: { playerId: true, slot: true },
    });
    const slotHrace = new Map(naSoupisceSloty.map(r => [r.playerId, r.slot]));
    const vSestave = await prisma.lineupPlayer.findMany({
      where:  { lineupId: lineup.id },
      select: { playerId: true },
    });
    const stav = pocty.rozdel(vSestave.map(p => ({ slot: slotHrace.get(p.playerId) })));
    const vejdeSe = pocty.vejdeSeNaSoupisku(
      stav, slotHrace.get(playerId) ?? 'FIELD',
      { maxPole: pocty.SESTAVA.maxPole, maxBrankaru: pocty.SESTAVA.maxBrankaru });
    if (!vejdeSe.ok) {
      return res.status(422).json({ error: vejdeSe.error, code: 'LINEUP_TOO_BIG' });
    }

    const rezervace = await kredit.rezervuj(playerId, match, teamId);
    if (!rezervace.ok) {
      return res.status(422).json({ error: rezervace.error, code: rezervace.code });
    }

    const slot = await prisma.lineupPlayer.create({
      data: {
        lineupId: lineup.id,
        playerId,
        isGoalkeeper: !!isGoalkeeper,
        addedLate: true,
        addedAt:   new Date(),
      },
      include: { player: { select: { id: true, firstName: true, lastName: true, jersey: true } } },
    });

    res.status(201).json(slot);
  } catch (err) { next(err); }
});

/**
 * POST /matches/:id/withdraw – hráč se odhlásí ze zápasu.
 *
 * Do 12 h před začátkem zápasu se mu start vrátí do balíčku. Potom už ne: zůstane
 * zúčtovaný a vrátí se jen tehdy, když tým sestavu i tak sežene (a zápas
 * se odehraje) — sankce má trefit toho, kdo zápas položil.
 */
router.post('/:id/withdraw', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const match = await prisma.match.findUnique({
      where:  { id: req.params.id },
      select: { id: true, date: true, status: true, season: true },
    });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Z rozehraného ani odehraného zápasu se odhlásit nedá' });
    }

    const entry = await prisma.matchEntry.findUnique({
      where: { playerId_matchId: { playerId: player.id, matchId: match.id } },
    });
    if (!entry || entry.status === 'RELEASED') {
      return res.status(404).json({ error: 'Na tenhle zápas nejsi přihlášený' });
    }

    // Ze sestavy pryč vždycky — jinak by tým počítal s někým, kdo nepřijde.
    const lineup = await prisma.lineupSubmission.findUnique({
      where: { matchId_teamId: { matchId: match.id, teamId: entry.teamId } },
    });
    if (lineup) {
      await prisma.lineupPlayer.deleteMany({
        where: { lineupId: lineup.id, playerId: player.id },
      });
    }

    const vysledek = await kredit.odhlas(player.id, match);
    res.json({
      ok: true,
      refunded:  vysledek.vraceno,
      hoursLeft: Math.round(kredit.hodinDoVykopu(match) * 10) / 10,
      remaining: await kredit.zustatek(player.id, match.season),
      ...(vysledek.error ? { note: vysledek.error, code: vysledek.code } : {}),
    });
  } catch (err) { next(err); }
});

// POST /matches/:id/lineup/:teamId/confirm – potvrzení soupisky
router.post('/:id/lineup/:teamId/confirm', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const lineup = await prisma.lineupSubmission.update({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      data:  { confirmed: true },
    });
    res.json(lineup);
  } catch (err) { next(err); }
});

// ==================== POSTMATCH ====================

// PUT /matches/:id/postmatch/:teamId – odevzdání po-zápasového formuláře
router.put('/:id/postmatch/:teamId', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    // BUG-14 OPRAVA: Ověř že teamId patří do tohoto zápasu
    const matchForTeamCheck = await prisma.match.findUnique({
      where: { id: req.params.id },
      select: { homeTeamId: true, awayTeamId: true },
    });
    if (!matchForTeamCheck) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (req.params.teamId !== matchForTeamCheck.homeTeamId && req.params.teamId !== matchForTeamCheck.awayTeamId) {
      return res.status(400).json({ error: 'Zadaný tým nepatří do tohoto zápasu' });
    }

    const { refRating, refNote, opponentMvpId, actionVideoUrl, actionDesc } = req.body;
    const postmatch = await prisma.postmatchData.upsert({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      create: {
        matchId: req.params.id,
        teamId:  req.params.teamId,
        refRating:      refRating      ? parseInt(refRating) : null,
        refNote:        refNote        || null,
        opponentMvpId:  opponentMvpId  || null,
        actionVideoUrl: actionVideoUrl || null,
        actionDesc:     actionDesc     || null,
      },
      update: {
        ...(refRating      !== undefined && { refRating: parseInt(refRating) }),
        ...(refNote        !== undefined && { refNote }),
        ...(opponentMvpId  !== undefined && { opponentMvpId }),
        ...(actionVideoUrl !== undefined && { actionVideoUrl }),
        ...(actionDesc     !== undefined && { actionDesc }),
      },
      include: { opponentMvp: true },
    });
    res.json(postmatch);
  } catch (err) { next(err); }
});

// POST /matches/:id/postmatch/:teamId/submit – finální odeslání (uzamkne)
router.post('/:id/postmatch/:teamId/submit', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const matchForSubmit = await prisma.match.findUnique({ where: { id: req.params.id }, select: { status: true } });
    if (!matchForSubmit) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (matchForSubmit.status !== 'DONE') {
      return res.status(400).json({ error: 'Postmatch formulář lze uzamknout pouze po skončení zápasu' });
    }

    const postmatch = await prisma.postmatchData.update({
      where: { matchId_teamId: { matchId: req.params.id, teamId: req.params.teamId } },
      data:  { submitted: true, submittedAt: new Date() },
    });
    res.json(postmatch);
  } catch (err) { next(err); }
});

module.exports = router;
