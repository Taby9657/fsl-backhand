const express = require('express');

const { requireAuth, requireManager, optionalAuth, isSupervisorUser } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { uploadLogo } = require('../utils/fileUpload');
const { verejnyHrac } = require('../utils/verejneUdaje');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const prisma = require('../lib/prisma');
const licence = require('../services/licence');
const seasonSvc = require('../services/seasonTransition');

// GET /teams – seznam všech týmů
router.get('/', async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      include: { _count: { select: { players: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// GET /teams/divisions – veřejný seznam divizí (MUSÍ být před /:id !)
router.get('/divisions', async (req, res, next) => {
  try {
    const divisions = await prisma.team.groupBy({
      by: ['division', 'conference'],
      _count: { division: true },
      orderBy: { division: 'asc' },
    });
    res.json(divisions);
  } catch (err) { next(err); }
});

/**
 * Veřejná podoba týmu — soupiska bez osobních údajů a bez kontaktů na vedoucí.
 * Vedoucí týmu a supervisor dostanou objekt tak, jak přišel z databáze.
 */
function verejnyTym(team) {
  return {
    ...team,
    players: (team.players ?? []).map(verejnyHrac),
    managers: (team.managers ?? []).map(m => ({ id: m.id, teamId: m.teamId })),
  };
}

/** Vedoucí daného týmu nebo supervisor — jen ti smí vidět plný detail. */
function vidiDetaily(user, teamId) {
  if (!user) return false;
  if (isSupervisorUser(user)) return true;
  return (user.manager ?? []).some(m => m.teamId === teamId);
}

// GET /teams/:id – detail týmu
// Veřejně přístupné, proto `optionalAuth`: anonym dostane jen soupisku,
// vedoucí týmu a supervisor i platby a kontakty.
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        players: { orderBy: { jersey: 'asc' }, include: { payment: true } },
        managers: { include: { user: { select: { id: true, email: true } } } },
      },
    });
    if (!team) return res.status(404).json({ error: 'Tým nenalezen' });
    res.json(vidiDetaily(req.user, team.id) ? team : verejnyTym(team));
  } catch (err) { next(err); }
});

// POST /teams – registrace nového týmu (vedoucí)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, abbr, color, colorSecondary } = req.body;
    if (!name || !abbr) return res.status(400).json({ error: 'Název a zkratka jsou povinné' });

    // Tým se přihlašuje do konkrétní sezóny. Bez ní by skončil v té, kterou
    // zrovna ukazuje liga — a při přepnutí sezóny by z ní zmizel.
    const season = req.body.season || await seasonSvc.currentSeason();
    if (!season || !seasonSvc.SEASON_RE.test(season)) {
      return res.status(400).json({ error: 'Vyber sezónu ve tvaru 2026/27' });
    }

    const team = await prisma.team.create({
      data: {
        name,
        abbr:      abbr.toUpperCase().slice(0, 3),
        color:     color || '#C9A140',
        colorSecondary: colorSecondary || null,
        // Divizi přiděluje supervisor při rozlosování, ne vedoucí při registraci
        division:  null,
        regStatus: 'PENDING', // nový tým čeká na schválení supervisorem
        managers:  { create: { userId: req.user.id } },
        payments:  { create: {} },
      },
      include: { managers: true },
    });

    // Přihláška do sezóny. Ligu přiděluje supervisor až při rozlosování,
    // takže leagueId zůstává prázdné.
    await prisma.teamSeason.create({ data: { teamId: team.id, season } });

    // Vygeneruj pozvánkový kód
    const code = `FSL-${team.abbr}-${uuidv4().slice(0, 4).toUpperCase()}`;
    await prisma.inviteCode.create({ data: { code, teamId: team.id } });

    // Notifikuj vedoucího o přijetí žádosti
    await createNotification(
      req.user.id,
      'Registrace přijata 📋',
      `Tým ${team.name} byl přihlášen do sezóny ${season}. Čeká na schválení supervisorem.`,
      'admin',
    );

    res.status(201).json({ team, inviteCode: code });
  } catch (err) { next(err); }
});

// PUT /teams/:id/appeal – odvolání vedoucího po zamítnutí
router.put('/:id/appeal', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const { appeal } = req.body;
    if (!appeal?.trim()) return res.status(400).json({ error: 'Text odvolání je povinný' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Tým nenalezen' });
    if (team.regStatus !== 'REJECTED') {
      return res.status(400).json({ error: 'Odvolání lze podat pouze u zamítnuté registrace' });
    }

    const updated = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'APPEALING', regAppeal: appeal.trim(), regAppealAt: new Date() },
    });

    // Notifikuj supervisory (hráče s isSupervisor=true)
    const supervisors = await prisma.player.findMany({
      where:   { isSupervisor: true },
      include: { user: { select: { id: true } } },
    });
    for (const sv of supervisors) {
      await createNotification(
        sv.user.id,
        'Odvolání registrace ⚠️',
        `Tým ${team.name} se odvolal proti zamítnutí.`,
        'supervisor/teams',
      );
    }

    res.json(updated);
  } catch (err) { next(err); }
});

// PUT /teams/:id – update týmu (jen vedoucí)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    const { name, color } = req.body;
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(color && { color }) },
    });
    res.json(team);
  } catch (err) { next(err); }
});

// POST /teams/:id/logo – nahrání loga (multer + cloudinary)
router.post('/:id/logo', requireAuth, uploadLogo.single('logo'), async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: { logoUrl: req.file.path },
    });
    res.json({ logoUrl: team.logoUrl });
  } catch (err) { next(err); }
});

// GET /teams/:id/invite – pozvánkový kód týmu
router.get('/:id/invite', requireAuth, async (req, res, next) => {
  try {
    const isManager = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!isManager) return res.status(403).json({ error: 'Nejste vedoucí tohoto týmu' });

    let invite = await prisma.inviteCode.findFirst({ where: { teamId: req.params.id } });
    if (!invite) {
      const team = await prisma.team.findUnique({ where: { id: req.params.id } });
      const code = `FSL-${team.abbr}-${uuidv4().slice(0, 4).toUpperCase()}`;
      invite = await prisma.inviteCode.create({ data: { code, teamId: req.params.id } });
    }
    res.json({ code: invite.code });
  } catch (err) { next(err); }
});

// ==================== SOUPISKA NA SEZÓNU ====================

/**
 * GET /teams/:id/roster?season= – kdo za tým smí nastupovat.
 *
 * Kmenoví hráči i hostující dohromady. Tohle je jediný seznam, ze kterého
 * vedoucí skládá sestavu — do zápasu se nikdo „zvenku" dopsat nedá.
 */
router.get('/:id/roster', async (req, res, next) => {
  try {
    // Bez výslovné sezóny bereme tu, do které je tým přihlášený
    const season = req.query.season
      || await licence.sezonaTymu(req.params.id, await seasonSvc.currentSeason());

    const radky = await prisma.teamRoster.findMany({
      where: { teamId: req.params.id, season },
      include: {
        player: {
          include: {
            payment: true,
            team: { select: { id: true, name: true, abbr: true, color: true } },
          },
        },
      },
    });

    const hraci = radky.map(r => ({
      ...r.player,
      isHome:   r.isHome,
      addedAt:  r.createdAt,
      licensed: licence.maZakladniLicenci(r.player.payment),
      superLic: licence.maSuperlicenci(r.player.payment),
    }));

    hraci.sort((a, b) =>
      Number(b.isHome) - Number(a.isHome) || (a.jersey ?? 999) - (b.jersey ?? 999));

    // Kmenoví hráči, kteří na soupisce téhle sezóny ještě nejsou.
    // Soupiska se s novou sezónou nepřenáší, takže tohle je seznam,
    // který vedoucí na začátku sezóny doplní jedním klepnutím.
    const naSoupisce = new Set(radky.map(r => r.playerId));
    const chybejici = await prisma.player.findMany({
      where:   { teamId: req.params.id, id: { notIn: [...naSoupisce] } },
      include: { payment: true },
      orderBy: { jersey: 'asc' },
    });

    res.json({
      season,
      players: hraci,
      missingHome: chybejici.map(p => ({
        ...p,
        licensed: licence.maZakladniLicenci(p.payment),
      })),
    });
  } catch (err) { next(err); }
});

/**
 * POST /teams/:id/roster/home – doplnění kmenových hráčů na soupisku sezóny.
 *
 * Soupiska se s novou sezónou nepřenáší (schválně — každá sezóna se skládá
 * znovu). Tohle je zkratka, aby vedoucí nemusel přidávat každého zvlášť.
 * Hostující hráče doplnit nelze, ti se přidávají jednotlivě a se superlicencí.
 */
router.post('/:id/roster/home', requireAuth, async (req, res, next) => {
  try {
    const season = req.body.season
      || await licence.sezonaTymu(req.params.id, await seasonSvc.currentSeason());

    const jeVedouci = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!jeVedouci) return res.status(403).json({ error: 'Nejsi vedoucí tohoto týmu' });

    const radky = await prisma.teamRoster.findMany({
      where:  { teamId: req.params.id, season },
      select: { playerId: true },
    });
    const naSoupisce = new Set(radky.map(r => r.playerId));

    const kmenovi = await prisma.player.findMany({
      where:  { teamId: req.params.id, id: { notIn: [...naSoupisce] } },
      select: { id: true },
    });

    // Jen vybraní, když je klient pošle; jinak všichni chybějící
    const vyber = Array.isArray(req.body.playerIds) && req.body.playerIds.length > 0
      ? kmenovi.filter(p => req.body.playerIds.includes(p.id))
      : kmenovi;

    let pridano = 0;
    for (const p of vyber) {
      const r = await licence.pridatDoSoupisky(p.id, req.params.id, season, { isHome: true });
      if (r.ok) pridano += 1;
    }

    res.json({ ok: true, added: pridano, season });
  } catch (err) { next(err); }
});

// POST /teams/:id/roster – vedoucí přidá hostujícího hráče
router.post('/:id/roster', requireAuth, async (req, res, next) => {
  try {
    const { playerId } = req.body;
    const season = req.body.season
      || await licence.sezonaTymu(req.params.id, await seasonSvc.currentSeason());

    const jeVedouci = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!jeVedouci) return res.status(403).json({ error: 'Nejsi vedoucí tohoto týmu' });
    if (!playerId)  return res.status(400).json({ error: 'Chybí playerId' });

    const vysledek = await licence.pridatDoSoupisky(playerId, req.params.id, season);
    if (!vysledek.ok) {
      return res.status(vysledek.code === 'NO_PLAYER' ? 404 : 422)
        .json({ error: vysledek.error, code: vysledek.code });
    }

    const player = await prisma.player.findUnique({
      where:   { id: playerId },
      include: { payment: true, team: { select: { id: true, name: true, abbr: true } } },
    });

    res.status(201).json({
      ...player,
      isHome:   vysledek.radek.isHome,
      licensed: licence.maZakladniLicenci(player.payment),
      superLic: licence.maSuperlicenci(player.payment),
    });
  } catch (err) { next(err); }
});

// DELETE /teams/:id/roster/:playerId – odebrání hostujícího hráče
router.delete('/:id/roster/:playerId', requireAuth, async (req, res, next) => {
  try {
    const season = req.query.season
      || await licence.sezonaTymu(req.params.id, await seasonSvc.currentSeason());

    const jeVedouci = req.user.manager?.some(m => m.teamId === req.params.id);
    if (!jeVedouci) return res.status(403).json({ error: 'Nejsi vedoucí tohoto týmu' });

    const radek = await licence.jeNaSoupisce(req.params.playerId, req.params.id, season);
    if (!radek) return res.status(404).json({ error: 'Hráč na soupisce není' });
    if (radek.isHome) {
      return res.status(400).json({
        error: 'Kmenového hráče takhle odebrat nejde — použij odebrání z týmu',
        code:  'IS_HOME_PLAYER',
      });
    }

    // Hostující hráč se odebírá jen tehdy, když za tým ještě nenastoupil.
    // Jinak by zmizel podklad pro nárok na playoff a pro statistiky.
    const starty = await licence.startyPodleTymu(req.params.playerId, season);
    if ((starty.get(req.params.id) ?? 0) > 0) {
      return res.status(409).json({
        error: 'Hráč už za tým odehrál zápas, ze soupisky ho odebrat nelze',
        code:  'HAS_STARTS',
      });
    }

    await licence.odebratZeSoupisky(req.params.playerId, req.params.id, season);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /teams/join/:code – hráč se připojí k týmu pomocí kódu
router.post('/join/:code', requireAuth, async (req, res, next) => {
  try {
    const invite = await prisma.inviteCode.findUnique({
      where: { code: req.params.code.toUpperCase() },
      include: { team: true },
    });
    if (!invite) return res.status(404).json({ error: 'Neplatný pozvánkový kód' });
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Pozvánkový kód vypršel' });
    }

    // POZOR: tohle je jen ověření kódu, ne skutečné připojení k týmu.
    // Počítadlo použití se zvyšuje až ve chvíli, kdy hráč opravdu vznikne
    // (POST /players) — jinak by ho nafoukl každý, kdo si kód jen ověří
    // a pak registraci nedokončí.
    res.json({ team: invite.team });
  } catch (err) { next(err); }
});

module.exports = router;
