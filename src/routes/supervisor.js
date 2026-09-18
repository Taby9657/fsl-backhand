const express = require('express');

const { requireSupervisor } = require('../middleware/auth');
const { createNotification, createNotifications } = require('./notifications');
const seasonSvc = require('../services/seasonTransition');
const standings = require('../services/standings');
const { stavParovani } = require('../services/bankSync');
const { KATEGORIE } = require('./requests');
const {
  sendMail,
  posliBezpecne,
  supervisorAddress,
  odpovedNaZpravuMail,
  nabidkaTymuMail,
} = require('../services/mailer');

const router = express.Router();
const prisma = require('../lib/prisma');
const licence = require('../services/licence');
const draftPool = require('../services/draftPool');
const { slotZPostu, jeBrankar } = require('../utils/posty');
const { uploadLogo } = require('../utils/fileUpload');

// Všechny endpointy v tomto souboru vyžadují supervisor roli
router.use(requireSupervisor);

// ==================== PŘEHLED ====================

router.get('/dashboard', async (req, res, next) => {
  try {
    const [
      pendingReferees,
      pendingRequests,
      upcomingMatches,
      totalTeams,
      totalPlayers,
      unpaidLicenses,
      pendingTeams,
      appealingTeams,
    ] = await Promise.all([
      prisma.referee.count({ where: { status: 'PENDING' } }),
      prisma.supervisorRequest.count({ where: { status: 'PENDING' } }),
      prisma.match.count({ where: { status: 'UPCOMING', date: { gte: new Date() } } }),
      prisma.team.count(),
      prisma.player.count(),
      prisma.playerPayment.count({ where: { licStatus: { not: 'PAID' } } }),
      prisma.team.count({ where: { regStatus: 'PENDING' } }),
      prisma.team.count({ where: { regStatus: 'APPEALING' } }),
    ]);

    // Zdraví párování převodů. Musí být vidět na nástěnce, ne jen v logu:
    // když FIO_API_TOKEN chyběl, převody se od 28. 8. do 10. 9. 2026
    // nepárovaly jedenáct dní a nikdo se to nedozvěděl.
    const bankSync = await stavParovani();

    res.json({
      pendingReferees, pendingRequests, upcomingMatches, totalTeams, totalPlayers,
      unpaidLicenses, pendingTeams, appealingTeams, bankSync,
    });
  } catch (err) { next(err); }
});

// ==================== FRONTA ŽÁDOSTÍ ====================

router.get('/requests', async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const requests = await prisma.supervisorRequest.findMany({
      where: { ...(status && { status }), ...(type && { type }) },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true } } },
    });
    res.json(requests);
  } catch (err) { next(err); }
});

// POST /supervisor/requests – přímé vytvoření žádosti supervisorem
router.post('/requests', async (req, res, next) => {
  try {
    const { type, userId, teamId, matchId, body, note } = req.body;
    if (!type || !body) return res.status(400).json({ error: 'Chybí type nebo body' });
    const request = await prisma.supervisorRequest.create({
      data: { type, userId: userId || null, teamId: teamId || null, matchId: matchId || null, body, note: note || null },
      include: { user: { select: { id: true, email: true } } },
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

const STAV_SLOVY = {
  IN_PROGRESS: 'řešíme to',
  APPROVED:    'vyřízeno',
  REJECTED:    'zamítnuto',
};

/**
 * Změna stavu žádosti — a jediná cesta, jak se člověk dozví odpověď.
 *
 * Poznámka je od začátku „poznámka pro žadatele", jenže se nikam
 * neodesílala: zůstala v adminu a ten, kdo psal, o ní nevěděl. Teď se
 * posílá e-mailem — i nepřihlášenému, který žádné oznámení v účtu dostat
 * nemůže — a přihlášenému navíc jako oznámení v účtu.
 *
 * **Bez poznámky se nic neposílá.** Úklid fronty nemá nikoho budit
 * e-mailem, který neříká víc než „stav změněn".
 */
router.put('/requests/:id', async (req, res, next) => {
  try {
    const { status, note } = req.body;
    const validStatuses = ['IN_PROGRESS', 'APPROVED', 'REJECTED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Neplatný stav žádosti' });
    }
    const request = await prisma.supervisorRequest.update({
      where: { id: req.params.id },
      data: { status, ...(note && { note }) },
      include: { user: { select: { id: true, email: true } } },
    });

    const odpoved = typeof note === 'string' ? note.trim() : '';
    const kontakt = request.email ?? request.user?.email ?? null;

    if (odpoved && kontakt) {
      const { subject, text, html } = odpovedNaZpravuMail({
        kategorie: KATEGORIE[request.type] ?? 'Zpráva',
        stav:      STAV_SLOVY[status] ?? status,
        odpoved,
        puvodni:   request.body,
      });

      // Odeslání e-mailu nesmí shodit změnu stavu — ta už proběhla.
      const poslano = await sendMail({
        to: kontakt,
        subject,
        text,
        html,
        replyTo: supervisorAddress(),
      });
      if (!poslano.ok) {
        console.error(`[Žádost ${request.id}] odpověď se neodeslala: ${poslano.reason}`);
      }
    }

    if (odpoved && request.userId) {
      try {
        await createNotification(
          request.userId,
          'Odpověď na tvoji zprávu',
          odpoved.length > 140 ? `${odpoved.slice(0, 137)}…` : odpoved,
          '/muj-ucet',
        );
      } catch (notifErr) {
        console.error('Oznámení o odpovědi selhalo (non-fatal):', notifErr.message);
      }
    }

    res.json(request);
  } catch (err) { next(err); }
});

// ==================== ROZHODČÍ ====================

router.get('/referees', async (req, res, next) => {
  try {
    const { status = 'PENDING' } = req.query;
    const refs = await prisma.referee.findMany({
      where: { status },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(refs);
  } catch (err) { next(err); }
});

// ==================== ZÁPASY ====================

router.get('/matches', async (req, res, next) => {
  try {
    const { status, division, round, season, phase } = req.query;
    const matches = await prisma.match.findMany({
      where: {
        ...(status   && { status }),
        ...(division && { division }),
        ...(round    && { round: parseInt(round) }),
        ...(season   && { season }),
        ...(phase && ['REGULAR', 'PLAYOFF'].includes(phase) && { phase }),
      },
      include: {
        homeTeam: { select: { id: true, name: true, abbr: true, color: true } },
        awayTeam: { select: { id: true, name: true, abbr: true, color: true } },
        referee:  { select: { id: true, firstName: true, lastName: true, level: true } },
      },
      orderBy: [{ round: 'asc' }, { date: 'asc' }],
    });
    res.json(matches);
  } catch (err) { next(err); }
});

router.post('/matches/:id/assign-referee', async (req, res, next) => {
  try {
    const { refereeId } = req.body;
    if (!refereeId) return res.status(400).json({ error: 'Chybí refereeId' });

    const ref = await prisma.referee.findUnique({ where: { id: refereeId } });
    if (!ref || ref.status !== 'APPROVED') {
      return res.status(400).json({ error: 'Rozhodčí není schválen' });
    }

    const match = await prisma.match.update({
      where: { id: req.params.id },
      data:  { refereeId },
      include: {
        homeTeam: true,
        awayTeam: true,
        referee:  { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await createNotification(ref.userId, 'Nové nasazení',
      `Byl(a) jste nasazen(a) na zápas ${match.homeTeam.abbr} vs ${match.awayTeam.abbr}`, 'ref-detail');

    res.json(match);
  } catch (err) { next(err); }
});

// DELETE /supervisor/matches/:id – smazání zápasu (jen UPCOMING)
router.delete('/matches/:id', async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Zápas nenalezen' });
    if (match.status !== 'UPCOMING') {
      return res.status(400).json({ error: 'Lze smazat pouze naplánované zápasy' });
    }
    await prisma.match.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SPRÁVA TÝMŮ ====================

// GET /supervisor/teams – všechny týmy s počtem hráčů + filtry
router.get('/teams', async (req, res, next) => {
  try {
    const { division, regStatus, payStatus } = req.query;
    const where = {};
    if (division)  where.division  = division;
    if (regStatus) where.regStatus = regStatus;
    if (payStatus) where.payments  = { status: payStatus };
    const teams = await prisma.team.findMany({
      where,
      include: {
        _count:   { select: { players: true } },
        payments: { select: { status: true, season: true, paidAt: true } },
      },
      orderBy: [{ regStatus: 'asc' }, { division: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id/approve – schválení registrace
router.put('/teams/:id/approve', async (req, res, next) => {
  try {
    const { note } = req.body; // volitelná poznámka
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'APPROVED', regNote: note || null, regAppeal: null, regAppealAt: null },
    });
    // Notifikuj vedoucí týmu
    const managers = await prisma.manager.findMany({
      where:   { teamId: team.id },
      include: { user: { select: { id: true } } },
    });
    for (const m of managers) {
      await createNotification(
        m.user.id,
        'Registrace schválena ✅',
        `Tým ${team.name} byl schválen do ligy.${note ? ` Poznámka: ${note}` : ''}`,
        'admin',
      );
    }
    res.json(team);
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id/reject – zamítnutí registrace (povinný důvod)
router.put('/teams/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Důvod zamítnutí je povinný' });
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { regStatus: 'REJECTED', regNote: reason.trim() },
    });
    const managers = await prisma.manager.findMany({
      where:   { teamId: team.id },
      include: { user: { select: { id: true } } },
    });
    for (const m of managers) {
      await createNotification(
        m.user.id,
        'Registrace zamítnuta ❌',
        `Tým ${team.name} byl zamítnut. Důvod: ${reason.trim()}`,
        'admin',
      );
    }
    res.json(team);
  } catch (err) { next(err); }
});

/**
 * POST /supervisor/teams – vytvoření týmu supervisorem.
 *
 * **Tohle není registrace týmu.** `POST /teams` zakládá tým i s vedoucím,
 * pozvánkovým kódem a předpisem registrace 3 000 Kč; tady vzniká tým, který
 * žádného živého vedoucího nemá — typicky **otevřený tým**, do kterého
 * supervisor zařazuje jednotlivce ručně ve Správě hráčů. Registraci proto
 * neplatí (otevřený tým ji podle pravidel neplatí vůbec) a `regStatus`
 * zůstává na výchozím `APPROVED`.
 *
 * **Přihláška do sezóny (`TeamSeason`) se zakládá tady.** Do 17. 9. 2026 se
 * nezakládala a tým z adminu tím pádem v běžící sezóně vůbec nebyl —
 * rozlosování ho nevidělo. Opravit se to nedalo ani jinudy: `POST
 * /seasons/teams` sice existuje, ale web ho nikde nevolá.
 */
router.post('/teams', async (req, res, next) => {
  try {
    const { name, abbr, division, color, colorSecondary, venue, conference, isOpen } = req.body;
    if (!name || !abbr) {
      return res.status(400).json({ error: 'Chybí název nebo zkratka týmu' });
    }
    if (abbr.length > 3) {
      return res.status(400).json({ error: 'Zkratka max 3 znaky' });
    }

    // Divize je volitelná — přiděluje se až při rozlosování. Kolizi zkratky
    // proto hlídáme jen v rámci divize, do které tým rovnou patří.
    const existing = await prisma.team.findFirst({
      where: { abbr: abbr.toUpperCase(), division: division || null },
    });
    if (existing) {
      return res.status(409).json({
        error: division
          ? `Tým se zkratkou ${abbr} už v divizi ${division} existuje`
          : `Nezařazený tým se zkratkou ${abbr} už existuje`,
      });
    }

    // Bez přihlášky do sezóny tým v soutěži není. Když liga sezónu nastavenou
    // nemá, tým vznikne bez ní — přihlásit se dá později, jen o tom musí
    // supervisor vědět, proto se to vrací v odpovědi jako `season`.
    const season = await seasonSvc.currentSeason();
    const doSezony = seasonSvc.SEASON_RE.test(season ?? '');

    const team = await prisma.team.create({
      data: {
        name,
        abbr:       abbr.toUpperCase(),
        division:   division || null,
        color:      color ?? '#C9A140',
        colorSecondary:  colorSecondary || null,
        venue:      venue || null,
        conference: conference || null,
        // Otevřený tým — skládá se z jednotlivců a nemá živého vedoucího.
        // Dnes to nemění žádný limit (`SOUPISKA_OTEVRENY` je kopie běžné
        // soupisky), je to příznak pro skládání otevřených týmů, až bude.
        isOpen:     !!isOpen,
        ...(doSezony ? { seasons: { create: { season } } } : {}),
      },
      include: { _count: { select: { players: true } } },
    });
    res.status(201).json({ ...team, season: doSezony ? season : null });
  } catch (err) { next(err); }
});

// PUT /supervisor/teams/:id – úprava týmu
router.put('/teams/:id', async (req, res, next) => {
  try {
    const { name, abbr, division, color, colorSecondary, venue, conference, isOpen } = req.body;
    const data = {};
    if (name)                data.name       = name;
    if (isOpen !== undefined) data.isOpen    = !!isOpen;
    if (abbr)                data.abbr       = abbr.toUpperCase();
    // Prázdný řetězec znamená "vyřadit z divize", proto !== undefined
    if (division !== undefined) data.division = division || null;
    if (color)               data.color      = color;
    if (colorSecondary !== undefined) data.colorSecondary = colorSecondary || null;
    if (venue !== undefined) data.venue      = venue || null;
    if (conference !== undefined) data.conference = conference || null;

    const team = await prisma.team.update({
      where: { id: req.params.id },
      data,
      include: { _count: { select: { players: true } } },
    });
    res.json(team);
  } catch (err) { next(err); }
});

/**
 * POST /supervisor/teams/:id/logo – nahrání loga supervisorem.
 *
 * `POST /teams/:id/logo` umí nahrát logo jen vedoucímu toho týmu, takže
 * **tým bez vedoucího logo nikdy nedostal** — a to je přesně otevřený tým,
 * který zakládá supervisor. Supervisor navíc logo nemohl nahrát ani žádnému
 * jinému týmu, i když ho vedoucí poslal e-mailem.
 */
router.post('/teams/:id/logo', uploadLogo.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { logoUrl: req.file.path },
    });
    res.json({ logoUrl: team.logoUrl });
  } catch (err) { next(err); }
});

// DELETE /supervisor/teams/:id/logo – odebrání loga
// Ruší jen odkaz v databázi; soubor v Cloudinary zůstává. Mazat cizí soubor
// kvůli překliku by bylo nevratné a tým se stejně vrátí k písmenné značce.
router.delete('/teams/:id/logo', async (req, res, next) => {
  try {
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data:  { logoUrl: null },
    });
    res.json({ logoUrl: team.logoUrl });
  } catch (err) { next(err); }
});

// DELETE /supervisor/teams/:id – smazání týmu (jen pokud nemá hráče/zápasy)
router.delete('/teams/:id', async (req, res, next) => {
  try {
    const [playerCount, matchCount] = await Promise.all([
      prisma.player.count({ where: { teamId: req.params.id } }),
      prisma.match.count({
        where: { OR: [{ homeTeamId: req.params.id }, { awayTeamId: req.params.id }] },
      }),
    ]);

    if (playerCount > 0) {
      return res.status(400).json({ error: `Tým má ${playerCount} hráčů – nejdříve je přesuň nebo odstraň` });
    }
    if (matchCount > 0) {
      return res.status(400).json({ error: `Tým má ${matchCount} zápasů – nejdříve je smaž` });
    }

    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ==================== SPRÁVA HRÁČŮ ====================

/**
 * Ruční páka ligy na to, kdo kde hraje.
 *
 * Do 15. 9. 2026 žádná nebyla. Hráč se do týmu dostal jen pozvánkovým kódem
 * od vedoucího, nebo draftem, a `POST /teams/:id/roster` je `jeVedouci`-only,
 * takže supervisor dostal 403 i na API. Kdo se registroval bez týmu a nikoho
 * nezaujal, zůstal viset a organizátor s tím nemohl udělat nic.
 *
 * **Zařazení do týmu není `player.update({ teamId })`.** Sestava se skládá
 * z `TeamRoster`, ne z `Player.teamId` — kdo zapíše jen jedno, vyrobí hráče,
 * který je vidět na soupisce a v sestavě chybí. Přesně to dělal draft.
 */

/**
 * Co Správa u hráče potřebuje vidět. **Osobní údaje sem patří** — supervisor
 * na ně má právo a bez kontaktu nemá jak s člověkem mluvit.
 *
 * E-mail je na `User`, ne na `Player`, takže se musí dotáhnout vztahem.
 * Hráč založený vedoucím přes pozvánku účet mít nemusí — pak je `user` null
 * a jediný kontakt je telefon.
 *
 * **Tenhle select platí jen pro supervisorské routy.** Veřejná data se řeší
 * whitelistem ve `utils/verejneUdaje.js` a datum narození ani kontakty do
 * nich nepatří.
 */
const HRAC_PRO_SPRAVU = {
  id: true, firstName: true, lastName: true, jersey: true, position: true,
  photoUrl: true, phone: true, birthdate: true, teamId: true, createdAt: true,
  user:         { select: { email: true } },
  team:         { select: { id: true, name: true, abbr: true, isOpen: true, regStatus: true } },
  payment:      { select: { season: true, licStatus: true, superStatus: true, superLic: true } },
  draftProfile: { select: { isActive: true, position: true } },
};

/**
 * GET /supervisor/players – seznam hráčů.
 *
 * `bezTymu=1` je ten filtr, kvůli kterému obrazovka vznikla: ukáže lidi,
 * kteří zaplatili nebo se aspoň zaregistrovali a čekají, až je někdo někam
 * dá. `q` hledá ve jméně, `teamId` omezí na jeden tým.
 */
router.get('/players', async (req, res, next) => {
  try {
    const { q, bezTymu, teamId, vPoolu } = req.query;
    const season = req.query.season || await seasonSvc.currentSeason();

    const where = {};
    if (bezTymu === '1') where.teamId = null;
    else if (teamId)     where.teamId = teamId;
    if (vPoolu === '1')  where.draftProfile = { isActive: true };
    if (q?.trim()) {
      const hledej = q.trim();
      where.OR = [
        { firstName: { contains: hledej, mode: 'insensitive' } },
        { lastName:  { contains: hledej, mode: 'insensitive' } },
      ];
    }

    const hraci = await prisma.player.findMany({
      where,
      select:  HRAC_PRO_SPRAVU,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take:    500,
    });

    // Soupisky sezóny jedním dotazem — u pěti set hráčů by dotaz na hlavu
    // znamenal pět set dotazů.
    const radky = await prisma.teamRoster.findMany({
      where:  { season, playerId: { in: hraci.map(h => h.id) } },
      select: { playerId: true, teamId: true, slot: true, isHome: true },
    });
    const podleHrace = new Map();
    for (const r of radky) {
      if (!podleHrace.has(r.playerId)) podleHrace.set(r.playerId, []);
      podleHrace.get(r.playerId).push(r);
    }

    res.json({
      season,
      players: hraci.map(h => ({ ...h, rosters: podleHrace.get(h.id) ?? [] })),
    });
  } catch (err) { next(err); }
});

/**
 * PUT /supervisor/players/:id – dres a post.
 *
 * Dres po draftu nikdo nepřepisoval: hráč z poolu vzniká s nulou a žádná
 * obrazovka se ho na číslo nezeptala, přestože onboarding slibuje „dres si
 * vybereš, až budeš v týmu". Tady se to dá spravit.
 */
router.put('/players/:id', async (req, res, next) => {
  try {
    const { jersey, position, phone } = req.body;
    const hrac = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!hrac) return res.status(404).json({ error: 'Hráč nenalezen' });

    const data = {};
    if (jersey !== undefined) {
      const cislo = parseInt(jersey, 10);
      if (isNaN(cislo) || cislo < 0 || cislo > 99) {
        return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
      }
      // Nula je platné číslo dresu, takže kolizi hlídáme i u ní.
      if (hrac.teamId) {
        const obsazeny = await prisma.player.findFirst({
          where: { teamId: hrac.teamId, jersey: cislo, id: { not: hrac.id } },
        });
        if (obsazeny) {
          return res.status(409).json({
            error: `Číslo dresu ${cislo} má v týmu ${obsazeny.firstName} ${obsazeny.lastName}`,
            code:  'JERSEY_TAKEN',
          });
        }
      }
      data.jersey = cislo;
    }
    if (position !== undefined) data.position = position;
    if (phone    !== undefined) data.phone    = phone || null;

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'Není co měnit' });
    }

    const upraveny = await prisma.player.update({
      where:  { id: hrac.id },
      data,
      select: HRAC_PRO_SPRAVU,
    });
    res.json(upraveny);
  } catch (err) { next(err); }
});

/**
 * PUT /supervisor/players/:id/team – zařazení do týmu, nebo odchod z něj.
 *
 * `teamId: null` hráče z týmu vyvede. Zařazení dělá tři věci naráz, protože
 * kterákoli z nich sama o sobě vyrobí rozbitý stav:
 *   1. `Player.teamId` — kmenový tým, podle něj se hráč zobrazuje,
 *   2. `TeamRoster` — jediný seznam, ze kterého se skládá sestava,
 *   3. odchod z draft poolu — jinak ho jiný tým přebije nabídkou.
 */
router.put('/players/:id/team', async (req, res, next) => {
  try {
    const { teamId, jersey, slot, doPoolu } = req.body;
    const hrac = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!hrac) return res.status(404).json({ error: 'Hráč nenalezen' });

    const puvodniTym = hrac.teamId;
    const season = req.body.season || await seasonSvc.currentSeason();

    // ── odchod z týmu ──────────────────────────────────────────────────
    if (!teamId) {
      if (!puvodniTym) return res.status(400).json({ error: 'Hráč v žádném týmu není' });

      // Odehrané zápasy jsou podklad pro statistiky i nárok na playoff.
      // Řádek na soupisce se proto ruší jen tam, kde hráč nenastoupil.
      const starty = await licence.startyPodleTymu(hrac.id, season);
      const odehral = (starty.get(puvodniTym) ?? 0) > 0;
      if (!odehral) await licence.odebratZeSoupisky(hrac.id, puvodniTym, season);

      await prisma.player.update({ where: { id: hrac.id }, data: { teamId: null } });

      // Do poolu se vrací jen na výslovné přání — ne každý odchod znamená,
      // že hráč shání nový tým.
      if (doPoolu === true) {
        try { await draftPool.zapisDoPoolu(hrac); }
        catch (err) { console.error('[správa hráčů] Návrat do poolu selhal:', err.message); }
      }

      const vysledek = await prisma.player.findUnique({
        where: { id: hrac.id }, select: HRAC_PRO_SPRAVU,
      });
      return res.json({ ...vysledek, odebranZeSoupisky: !odehral, ponechanoKvuliStartum: odehral });
    }

    // ── zařazení do týmu ───────────────────────────────────────────────
    const tym = await prisma.team.findUnique({
      where:  { id: teamId },
      select: { id: true, name: true, isOpen: true, regStatus: true },
    });
    if (!tym) return res.status(404).json({ error: 'Tým nenalezen' });
    if (tym.regStatus === 'REJECTED') {
      return res.status(409).json({
        error: 'Registrace tohohle týmu byla zamítnutá, hráče do něj zařadit nelze',
        code:  'TEAM_REJECTED',
      });
    }

    // Dres: buď přijde v požadavku, nebo se zkusí ten stávající. Nula
    // z draftu koliduje s každým brankářem, který si ji vybral, takže se
    // musí dát zadat.
    const cislo = jersey === undefined || jersey === null || jersey === ''
      ? hrac.jersey
      : parseInt(jersey, 10);
    if (isNaN(cislo) || cislo < 0 || cislo > 99) {
      return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
    }
    const obsazeny = await prisma.player.findFirst({
      where: { teamId, jersey: cislo, id: { not: hrac.id } },
    });
    if (obsazeny) {
      return res.status(409).json({
        error: `Číslo dresu ${cislo} má v týmu ${obsazeny.firstName} ${obsazeny.lastName}, vyber jiné`,
        code:  'JERSEY_TAKEN',
      });
    }

    if (slot !== undefined && slot !== null && !licence.jeSlot(slot)) {
      return res.status(400).json({
        error: `slot musí být jedno z: ${licence.SLOTY.join(', ')}`,
        code:  'BAD_SLOT',
      });
    }

    // Sezóna se bere z přihlášky týmu, ne z té, kterou zrovna ukazuje liga.
    const sezonaTymu = await licence.sezonaTymu(teamId, season);

    // Ze starého týmu odejít dřív, než se zapíše nový — jinak by hráč zůstal
    // na dvou soupiskách a limity by se počítaly ze špatných čísel.
    if (puvodniTym && puvodniTym !== teamId) {
      const starty = await licence.startyPodleTymu(hrac.id, sezonaTymu);
      if ((starty.get(puvodniTym) ?? 0) === 0) {
        await licence.odebratZeSoupisky(hrac.id, puvodniTym, sezonaTymu);
      }
    }

    const zapis = await licence.pridatDoSoupisky(hrac.id, teamId, sezonaTymu, {
      isHome: true,
      slot:   slot ?? slotZPostu(hrac.position),
    });
    if (!zapis.ok && zapis.code !== 'ALREADY_ON_ROSTER') {
      return res.status(zapis.code === 'NO_PLAYER' ? 404 : 422)
        .json({ error: zapis.error, code: zapis.code });
    }

    await prisma.player.update({
      where: { id: hrac.id },
      data:  { teamId, jersey: cislo },
    });

    // Hráč má tým, takže v nabídce volných hráčů nemá co dělat.
    try { await draftPool.odeberZPoolu(hrac.id); }
    catch (err) { console.error('[správa hráčů] Odebrání z poolu selhalo:', err.message); }

    // Hráč se to musí dozvědět — zařadil ho někdo jiný než on sám.
    if (hrac.userId) {
      await createNotification(
        hrac.userId,
        'Jsi v týmu',
        `Liga tě zařadila do týmu ${tym.name}.`,
        'admin',
      );
    }
    const vedouci = await prisma.manager.findMany({ where: { teamId }, select: { userId: true } });
    if (vedouci.length) {
      await createNotifications(vedouci.map(m => ({
        userId: m.userId,
        title:  'Nový hráč na soupisce',
        body:   `${hrac.firstName} ${hrac.lastName} byl(a) zařazen(a) do vašeho týmu ligou.`,
        screen: 'admin',
      })));
    }

    const vysledek = await prisma.player.findUnique({
      where: { id: hrac.id }, select: HRAC_PRO_SPRAVU,
    });
    res.json({ ...vysledek, season: sezonaTymu });
  } catch (err) { next(err); }
});

/**
 * DELETE /supervisor/players/:id – smazání hráče.
 *
 * Do dneška šlo z webu smazat tým, ale ne člověka: testovací registrace
 * zůstávaly viset ve Správě hráčů a mezi volnými hráči je viděl každý.
 *
 * **Maže se jen hráč bez historie.** Sestava, zúčtovaný start, gól i hlas
 * pro MVP jsou podklad pro statistiky a nárok na play-off, a `scorerId`
 * v `MatchEvent` je nullovatelný — smazání hráče by z gólu tiše udělalo gól
 * bez střelce. Kdo nastoupil, se proto neodstraňuje, jen odvádí z týmu.
 *
 * **Zaplacené peníze drží taky.** Licence nebo balíček, na které dorazila
 * koruna, mají protistranu na bankovním výpisu; ta smazáním řádku nezmizí.
 *
 * `?ucet=1` smaže i uživatelský účet — bez toho zůstane e-mail obsazený
 * a znovu se s ním zaregistrovat nejde. **Účet vedoucího týmu, rozhodčího
 * ani supervisora se nemaže nikdy**, hráč se smaže a účet zůstane.
 */
router.delete('/players/:id', async (req, res, next) => {
  try {
    const hrac = await prisma.player.findUnique({
      where:   { id: req.params.id },
      include: {
        payment: true,
        user:    { select: { id: true, email: true, isSupervisor: true } },
      },
    });
    if (!hrac) return res.status(404).json({ error: 'Hráč nenalezen' });
    if (hrac.isSupervisor || hrac.user?.isSupervisor) {
      return res.status(409).json({
        error: 'Supervisora smazat nelze',
        code:  'PLAYER_IS_SUPERVISOR',
      });
    }

    // ── Historie v zápasech ────────────────────────────────────────────
    const [udalosti, sestavy, starty, mvp] = await Promise.all([
      prisma.matchEvent.count({
        where: { OR: [{ scorerId: hrac.id }, { assistId: hrac.id }, { penaltyId: hrac.id }] },
      }),
      prisma.lineupPlayer.count({ where: { playerId: hrac.id } }),
      prisma.matchEntry.count({ where: { playerId: hrac.id } }),
      prisma.postmatchData.count({ where: { opponentMvpId: hrac.id } }),
    ]);
    const historie = udalosti + sestavy + starty + mvp;
    if (historie > 0) {
      return res.status(409).json({
        error:  `Hráč má ${historie} záznamů ze zápasů – smazat ho nejde, stojí na nich statistiky. Odveď ho z týmu.`,
        code:   'PLAYER_HAS_HISTORY',
        detail: { udalosti, sestavy, starty, mvp },
      });
    }

    // ── Zaplacené peníze ───────────────────────────────────────────────
    const balicky = await prisma.matchPack.count({
      where: { playerId: hrac.id, OR: [{ status: 'PAID' }, { paidAmount: { gt: 0 } }] },
    });
    const zaplaceno = (hrac.payment?.licPaidAmount ?? 0) + (hrac.payment?.superPaidAmount ?? 0);
    if (balicky > 0 || zaplaceno > 0) {
      return res.status(409).json({
        error:  'Hráč má zaplacené položky – smazat ho nejde. Nejdřív vyřeš platby.',
        code:   'PLAYER_HAS_PAYMENTS',
        detail: { zaplaceno, balicky },
      });
    }

    // ── Účet ───────────────────────────────────────────────────────────
    const smazatUcet = req.query.ucet === '1' || req.body?.ucet === true;
    let ucet = null;
    if (smazatUcet && hrac.user) {
      const [vedouci, rozhodci] = await Promise.all([
        prisma.manager.count({ where: { userId: hrac.user.id } }),
        prisma.referee.count({ where: { userId: hrac.user.id } }),
      ]);
      if (vedouci > 0) {
        ucet = { smazan: false, email: hrac.user.email, duvod: 'Účet je vedoucí týmu', code: 'USER_IS_MANAGER' };
      } else if (rozhodci > 0) {
        ucet = { smazan: false, email: hrac.user.email, duvod: 'Účet je rozhodčí', code: 'USER_IS_REFEREE' };
      }
    }

    // Soupiska, draft profil i s nabídkami, předpis licence, balíčky,
    // položky v košíku a doporučovací kód visí na hráči kaskádou.
    await prisma.player.delete({ where: { id: hrac.id } });

    if (smazatUcet && hrac.user && !ucet) {
      await prisma.user.delete({ where: { id: hrac.user.id } });
      ucet = { smazan: true, email: hrac.user.email };
    }

    console.log(
      `[správa hráčů] Smazán hráč ${hrac.firstName} ${hrac.lastName} (${hrac.id})` +
      (ucet?.smazan ? `, účet ${ucet.email}` : ''),
    );
    res.json({ ok: true, ucet });
  } catch (err) { next(err); }
});

// ==================== SOUTĚŽE A DIVIZE ====================

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

// GET /supervisor/conferences – strom Konference → Divize → Týmy
router.get('/conferences', async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      select: { id: true, name: true, abbr: true, color: true, division: true, conference: true, venue: true },
      orderBy: [{ conference: 'asc' }, { division: 'asc' }, { name: 'asc' }],
    });
    res.json(teams);
  } catch (err) { next(err); }
});

// ==================== ROZLOSOVÁNÍ ====================

/**
 * Round-robin algoritmus
 * Vrací pole { homeTeamId, awayTeamId, round }
 * doubleRoundRobin = true → každý s každým doma i venku
 */
function generateRoundRobin(teamIds, doubleRoundRobin = false) {
  const teams = [...teamIds];
  if (teams.length % 2 !== 0) teams.push(null); // BYE
  const n = teams.length;
  const firstLeg = [];
  const rotation = [...teams];

  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) {
      const home = rotation[i];
      const away = rotation[n - 1 - i];
      if (home !== null && away !== null) {
        firstLeg.push({ homeTeamId: home, awayTeamId: away, round: r + 1 });
      }
    }
    // Rotace: rotation[0] fixní, zbytek rotuje
    const last = rotation.pop();
    rotation.splice(1, 0, last);
  }

  if (!doubleRoundRobin) return firstLeg;

  const totalRounds = n - 1;
  const secondLeg = firstLeg.map(m => ({
    homeTeamId: m.awayTeamId,
    awayTeamId: m.homeTeamId,
    round:      m.round + totalRounds,
  }));

  return [...firstLeg, ...secondLeg];
}

// ==================== PLAYOFF ====================

/**
 * Sestavení jednoho kola playoff z tabulky.
 *
 * Nasazuje se 1–N, 2–(N-1) atd., lepší tým je domácí. Generuje se vždy jen
 * jedno kolo — kdo postoupí z prvního, se dozvíme až po zápasech, takže
 * další kolo si supervisor vygeneruje znovu z výsledků.
 */
async function pripravPlayoff({ leagueId, conferenceId, divisionId, division, season, teamCount = 4 }) {
  const sezona = season ?? await seasonSvc.currentSeason();
  const rozsah = { leagueId, conferenceId, divisionId, division, season: sezona };

  const tabulka = await standings.tabulka(rozsah);
  if (tabulka.length < 2) {
    return { error: 'V tabulce nejsou aspoň dva týmy — nejdřív se musí odehrát základní část' };
  }

  // Sudý počet, nikdy víc, než kolik je týmů
  let pocet = Math.min(parseInt(teamCount, 10) || 4, tabulka.length);
  if (pocet % 2 === 1) pocet -= 1;
  if (pocet < 2) return { error: 'Na playoff je potřeba aspoň dva týmy' };

  const postupujici = tabulka.slice(0, pocet);
  return { sezona, rozsah, tabulka, pary: standings.nasazeni(postupujici) };
}

// POST /supervisor/playoff/preview – kdo by se s kým utkal
router.post('/playoff/preview', async (req, res, next) => {
  try {
    const vysledek = await pripravPlayoff(req.body);
    if (vysledek.error) return res.status(400).json({ error: vysledek.error });

    res.json({
      season: vysledek.sezona,
      teams:  vysledek.pary.length * 2,
      pairs:  vysledek.pary.map(p => ({
        seedHome: p.seedHome,
        seedAway: p.seedAway,
        homeTeam: p.home.team,
        awayTeam: p.away.team,
        homePts:  p.home.pts,
        awayPts:  p.away.pts,
      })),
    });
  } catch (err) { next(err); }
});

// POST /supervisor/playoff/generate – vytvoření zápasů kola
router.post('/playoff/generate', async (req, res, next) => {
  try {
    const {
      startDate, defaultTime = '18:00', defaultVenue = null,
      round = 1, bestOf = 1, intervalDays = 7, deleteExisting = false,
    } = req.body;

    if (!startDate) return res.status(400).json({ error: 'Chybí datum prvního zápasu' });

    const vysledek = await pripravPlayoff(req.body);
    if (vysledek.error) return res.status(400).json({ error: vysledek.error });

    const { sezona, rozsah, pary } = vysledek;
    const [hodina, minuta] = String(defaultTime).split(':').map(Number);
    const zaklad = new Date(startDate);
    if (isNaN(zaklad.getTime())) return res.status(400).json({ error: 'Neplatné datum' });

    const poctZapasu = Math.max(1, Math.min(parseInt(bestOf, 10) || 1, 7));
    const koloCislo  = Math.max(1, parseInt(round, 10) || 1);

    // Struktura se bere z rozsahu, aby zápasy padly do správné soutěže
    const struktura = {
      leagueId:     rozsah.leagueId     ?? null,
      conferenceId: rozsah.conferenceId ?? null,
      divisionId:   rozsah.divisionId   ?? null,
    };

    const data = [];
    for (const par of pary) {
      for (let i = 0; i < poctZapasu; i += 1) {
        const d = new Date(zaklad);
        d.setDate(d.getDate() + i * intervalDays);
        d.setHours(hodina || 18, minuta || 0, 0, 0);

        // V liché sérii se hřiště střídá, lepší nasazený začíná doma
        const doma = i % 2 === 0;
        data.push({
          homeTeamId:  doma ? par.home.teamId : par.away.teamId,
          awayTeamId:  doma ? par.away.teamId : par.home.teamId,
          round:       koloCislo,
          phase:       'PLAYOFF',
          division:    rozsah.division ?? 'Playoff',
          ...struktura,
          competition: 'FSL Playoff',
          date:        d,
          venue:       defaultVenue,
          status:      'UPCOMING',
          season:      sezona,
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      if (deleteExisting) {
        await tx.match.deleteMany({
          where: {
            season: sezona, phase: 'PLAYOFF', round: koloCislo, status: 'UPCOMING',
            ...(struktura.divisionId   ? { divisionId: struktura.divisionId }     : {}),
            ...(struktura.conferenceId ? { conferenceId: struktura.conferenceId } : {}),
            ...(struktura.leagueId     ? { leagueId: struktura.leagueId }         : {}),
          },
        });
      }
      await tx.match.createMany({ data });
    });

    res.status(201).json({ created: data.length, round: koloCislo, pairs: pary.length, season: sezona });
  } catch (err) { next(err); }
});

// POST /supervisor/fixtures/preview – náhled (bez uložení)
// Podporuje: leagueId | conferenceId | divisionId (nová struktura)
//            division | conference | teamIds[]   (staré textové pole)
router.post('/fixtures/preview', async (req, res, next) => {
  try {
    const {
      division, conference, teamIds,
      leagueId, conferenceId, divisionId, season = null,
      doubleRoundRobin = false,
    } = req.body;

    let teams;
    if (leagueId || conferenceId || divisionId) {
      const sezona = season ?? await seasonSvc.currentSeason();
      const zarazeni = await prisma.teamSeason.findMany({
        where: {
          season: sezona,
          ...(divisionId   ? { divisionId }   : {}),
          ...(conferenceId ? { conferenceId } : {}),
          ...(leagueId     ? { leagueId }     : {}),
        },
        include: { team: true },
      });
      teams = zarazeni.map(z => z.team);
    } else if (Array.isArray(teamIds) && teamIds.length >= 2) {
      teams = await prisma.team.findMany({ where: { id: { in: teamIds } } });
    } else if (conference) {
      teams = await prisma.team.findMany({ where: { conference } });
    } else if (division) {
      teams = await prisma.team.findMany({ where: { division } });
    } else {
      return res.status(400).json({ error: 'Zadej ligu, konferenci, divizi nebo seznam týmů' });
    }

    if (teams.length < 2) return res.status(400).json({ error: 'Potřeba alespoň 2 týmy' });

    const fixtures = generateRoundRobin(teams.map(t => t.id), doubleRoundRobin);
    const rounds = Math.max(...fixtures.map(f => f.round));

    res.json({
      teams:    teams.length,
      matches:  fixtures.length,
      rounds,
      fixtures: fixtures.map(f => ({
        round:    f.round,
        homeTeam: teams.find(t => t.id === f.homeTeamId),
        awayTeam: teams.find(t => t.id === f.awayTeamId),
      })),
    });
  } catch (err) { next(err); }
});

// POST /supervisor/fixtures/generate – vytvoření zápasů v DB
// Podporuje: division | conference | teamIds[]
router.post('/fixtures/generate', async (req, res, next) => {
  try {
    const {
      division, conference, teamIds,
      leagueId, conferenceId, divisionId,
      competition      = 'FSL Liga',
      startDate,
      season           = null,
      roundIntervalDays = 7,
      defaultTime      = '18:00',
      defaultVenue     = null,
      doubleRoundRobin = false,
      deleteExisting   = false,
    } = req.body;

    if (!startDate) return res.status(400).json({ error: 'Chybí startDate' });

    let teams;
    let matchDivision = division ?? 'Mix';
    let matchConference = conference ?? null;
    // Vazba nových zápasů na soutěžní strukturu
    let struktura = null;

    // Nová cesta: výběr podle ligy, konference nebo divize ze struktury
    if (leagueId || conferenceId || divisionId) {
      const sezona = season ?? await seasonSvc.currentSeason();
      const zarazeni = await prisma.teamSeason.findMany({
        where: {
          season: sezona,
          ...(divisionId   ? { divisionId }   : {}),
          ...(conferenceId ? { conferenceId } : {}),
          ...(leagueId     ? { leagueId }     : {}),
        },
        include: {
          team:       true,
          league:     { select: { id: true, name: true } },
          conference: { select: { id: true, name: true } },
          division:   { select: { id: true, name: true } },
        },
      });
      teams = zarazeni.map(z => z.team);
      const prvni = zarazeni[0];

      // Zápasy označíme rozsahem, který supervisor zvolil — ne zařazením prvního
      // týmu. Losování celé ligy se dvěma konferencemi jinak spadne pod jednu.
      struktura = {
        leagueId:     leagueId     ?? prvni?.leagueId     ?? null,
        conferenceId: conferenceId ?? (divisionId ? prvni?.conferenceId ?? null : null),
        divisionId:   divisionId   ?? null,
      };

      // Textová divize zůstává kvůli starším obrazovkám a exportům
      matchDivision   = prvni?.division?.name ?? prvni?.conference?.name ?? prvni?.league?.name ?? 'Mix';
      matchConference = prvni?.conference?.name ?? null;
    } else if (Array.isArray(teamIds) && teamIds.length >= 2) {
      teams = await prisma.team.findMany({ where: { id: { in: teamIds } } });
      matchDivision = division || 'Mix';
    } else if (conference) {
      teams = await prisma.team.findMany({ where: { conference } });
      matchConference = conference;
      matchDivision = division || conference;
    } else if (division) {
      teams = await prisma.team.findMany({ where: { division } });
    } else {
      return res.status(400).json({ error: 'Zadej ligu, konferenci, divizi nebo seznam týmů' });
    }

    if (teams.length < 2) return res.status(400).json({ error: 'Potřeba alespoň 2 týmy' });

    const fixtures = generateRoundRobin(teams.map(t => t.id), doubleRoundRobin);
    const [hour, minute] = defaultTime.split(':').map(Number);
    const base = new Date(startDate);

    const matchData = fixtures.map(f => {
      const d = new Date(base);
      d.setDate(d.getDate() + (f.round - 1) * roundIntervalDays);
      d.setHours(hour, minute, 0, 0);
      return {
        homeTeamId:  f.homeTeamId,
        awayTeamId:  f.awayTeamId,
        round:       f.round,
        division:    matchDivision,
        // Nové zápasy se vážou na strukturu; bereme ji ze zařazení domácího týmu
        leagueId:     struktura?.leagueId     ?? null,
        conferenceId: struktura?.conferenceId ?? null,
        divisionId:   struktura?.divisionId   ?? null,
        competition,
        date:        d,
        venue:       defaultVenue,
        status:      'UPCOMING',
        season:      season || null,
      };
    });

    // BUG-06 OPRAVA: Zabal mazání starých a vytváření nových zápasů do DB transakce
    // Zabraňuje nekonzistentnímu stavu při selhání (např. smazáno, ale nevytvořeno)
    await prisma.$transaction(async (tx) => {
      if (deleteExisting) {
        if (leagueId || conferenceId || divisionId) {
          // Mažeme přesně ten rozsah, který se právě losuje
          await tx.match.deleteMany({
            where: {
              status: 'UPCOMING',
              ...(divisionId   ? { divisionId }   : {}),
              ...(conferenceId ? { conferenceId } : {}),
              ...(leagueId     ? { leagueId }     : {}),
            },
          });
        } else if (Array.isArray(teamIds) && teamIds.length >= 2) {
          await tx.match.deleteMany({
            where: { status: 'UPCOMING', OR: [{ homeTeamId: { in: teamIds } }, { awayTeamId: { in: teamIds } }] },
          });
        } else {
          await tx.match.deleteMany({ where: { division: matchDivision, status: 'UPCOMING' } });
        }
      }
      await tx.match.createMany({ data: matchData });
    });

    res.json({
      created:  matchData.length,
      rounds:   Math.max(...fixtures.map(f => f.round)),
      division: matchDivision,
      conference: matchConference,
    });
  } catch (err) { next(err); }
});

// ==================== PLATBY ====================

router.get('/payments', async (req, res, next) => {
  try {
    const { status } = req.query;
    const [players, teams] = await Promise.all([
      prisma.playerPayment.findMany({
        where: status ? { licStatus: status } : undefined,
        include: {
          player: {
            select: { id: true, firstName: true, lastName: true, jersey: true,
              team: { select: { id: true, name: true, abbr: true } } },
          },
        },
        orderBy: { player: { lastName: 'asc' } },
      }),
      prisma.teamPayment.findMany({
        where: status ? { status } : undefined,
        include: { team: { select: { id: true, name: true, abbr: true } } },
        orderBy: { team: { name: 'asc' } },
      }),
    ]);
    res.json({ players, teams });
  } catch (err) { next(err); }
});

// ==================== SEZÓNA ====================

// POST /supervisor/new-season – uzavře starou sezónu, spustí novou
// ==================== PŘECHOD SEZÓNY ====================
//
// Dvoukrokový, naplánovaný na datum. Provede ho sám server, ale jen když
// ve staré sezóně nezbývají neodehrané zápasy.

// GET /supervisor/season – aktuální sezóna, naplánovaný přechod a překážky
router.get('/season', async (req, res, next) => {
  try {
    const current = await seasonSvc.currentSeason();
    const [planned, blocking] = await Promise.all([
      prisma.seasonTransition.findFirst({
        where:   { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
        orderBy: { createdAt: 'desc' },
      }),
      seasonSvc.blockingMatches(current),
    ]);
    const last = await prisma.seasonTransition.findFirst({
      where:   { status: { in: ['EXECUTED', 'FAILED'] } },
      orderBy: { executedAt: 'desc' },
    });
    const supervisors = await seasonSvc.supervisorIds();
    res.json({
      currentSeason:   current,
      planned,
      lastTransition:  last,
      blockingMatches: blocking.count,
      blockingSample:  blocking.matches,
      supervisorCount: supervisors.length,
      // Pravidlo čtyř očí: potvrzuje někdo jiný než ten, kdo plánoval.
      // Při jediném supervisorovi v lize potvrzuje sám.
      canConfirm:      await seasonSvc.canConfirm(planned, req.user.id),
      plannedByMe:     planned ? planned.createdById === req.user.id : false,
    });
  } catch (err) { next(err); }
});

// POST /supervisor/season – krok 1: naplánování (ještě neplatí, čeká na potvrzení)
router.post('/season', async (req, res, next) => {
  try {
    const { newSeason, scheduledAt } = req.body;

    if (!newSeason || !seasonSvc.SEASON_RE.test(newSeason)) {
      return res.status(400).json({ error: 'Neplatný formát sezóny – použij tvar "2026/27"' });
    }
    const kdy = new Date(scheduledAt);
    if (!scheduledAt || Number.isNaN(kdy.getTime())) {
      return res.status(400).json({ error: 'Neplatné datum přechodu' });
    }
    if (kdy.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Datum přechodu musí být v budoucnosti' });
    }

    const current = await seasonSvc.currentSeason();
    if (current === newSeason) {
      return res.status(409).json({ error: 'Tato sezóna je již aktivní' });
    }

    const existing = await prisma.seasonTransition.findFirst({
      where: { status: { in: ['PENDING_CONFIRM', 'CONFIRMED'] } },
    });
    if (existing) {
      return res.status(409).json({ error: 'Jeden přechod už je naplánovaný. Nejdřív ho zruš.' });
    }

    const transition = await prisma.seasonTransition.create({
      data: { newSeason, scheduledAt: kdy, createdById: req.user.id },
    });

    await seasonSvc.notifySupervisors(
      'Naplánován přechod sezóny',
      `Sezóna ${newSeason} je naplánovaná na ${kdy.toLocaleDateString('cs-CZ')}. Čeká na potvrzení.`,
    );

    res.status(201).json(transition);
  } catch (err) { next(err); }
});

// PUT /supervisor/season/:id/confirm – krok 2: potvrzení opsáním názvu sezóny
router.put('/season/:id/confirm', async (req, res, next) => {
  try {
    const { confirmSeason } = req.body;

    const transition = await prisma.seasonTransition.findUnique({ where: { id: req.params.id } });
    if (!transition) return res.status(404).json({ error: 'Přechod nenalezen' });
    if (transition.status !== 'PENDING_CONFIRM') {
      return res.status(409).json({ error: 'Tenhle přechod už potvrzení nečeká' });
    }
    if (!(await seasonSvc.canConfirm(transition, req.user.id))) {
      return res.status(403).json({
        error: 'Přechod musí potvrdit jiný supervisor, než ten, který ho naplánoval.',
      });
    }
    if ((confirmSeason ?? '').trim() !== transition.newSeason) {
      return res.status(400).json({
        error: `Pro potvrzení opiš přesně název sezóny: ${transition.newSeason}`,
      });
    }

    const updated = await prisma.seasonTransition.update({
      where: { id: transition.id },
      data:  { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    await seasonSvc.notifySupervisors(
      'Přechod sezóny potvrzen',
      `Sezóna ${transition.newSeason} se spustí ${transition.scheduledAt.toLocaleDateString('cs-CZ')} automaticky.`,
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /supervisor/season/:id – zrušení naplánovaného přechodu
router.delete('/season/:id', async (req, res, next) => {
  try {
    const transition = await prisma.seasonTransition.findUnique({ where: { id: req.params.id } });
    if (!transition) return res.status(404).json({ error: 'Přechod nenalezen' });
    if (!['PENDING_CONFIRM', 'CONFIRMED'].includes(transition.status)) {
      return res.status(409).json({ error: 'Tenhle přechod už zrušit nelze' });
    }

    const updated = await prisma.seasonTransition.update({
      where: { id: transition.id },
      data:  { status: 'CANCELLED' },
    });

    await seasonSvc.notifySupervisors(
      'Přechod sezóny zrušen',
      `Naplánovaný přechod na sezónu ${transition.newSeason} byl zrušen.`,
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// ==================== SPRÁVA SUPERVISORŮ ====================

// GET /supervisor/users?q= – seznam uživatelů pro přidělení role
router.get('/users', async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    const users = await prisma.user.findMany({
      where: q ? {
        OR: [
          { email:  { contains: q, mode: 'insensitive' } },
          { player: { firstName: { contains: q, mode: 'insensitive' } } },
          { player: { lastName:  { contains: q, mode: 'insensitive' } } },
        ],
      } : undefined,
      select: {
        id: true, email: true, isSupervisor: true, createdAt: true,
        player:  { select: { firstName: true, lastName: true, isSupervisor: true } },
        referee: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ isSupervisor: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });
    res.json(users);
  } catch (err) { next(err); }
});

// PUT /supervisor/users/:id/supervisor – přidělení nebo odebrání role
router.put('/users/:id/supervisor', async (req, res, next) => {
  try {
    const { isSupervisor } = req.body;
    if (typeof isSupervisor !== 'boolean') {
      return res.status(400).json({ error: 'isSupervisor musí být true nebo false' });
    }

    const target = await prisma.user.findUnique({
      where:  { id: req.params.id },
      select: { id: true, email: true, isSupervisor: true },
    });
    if (!target) return res.status(404).json({ error: 'Uživatel nenalezen' });

    // Nikdo si nesmí odebrat vlastní roli — zavřel by si dveře zevnitř.
    if (!isSupervisor && target.id === req.user.id) {
      return res.status(400).json({ error: 'Vlastní roli supervisora si odebrat nemůžeš. Požádej o to jiného supervisora.' });
    }

    // A liga nesmí zůstat bez jediného supervisora.
    if (!isSupervisor) {
      const zbyva = await prisma.user.count({ where: { isSupervisor: true, id: { not: target.id } } });
      if (zbyva === 0) {
        return res.status(400).json({ error: 'Tohle je poslední supervisor, roli mu odebrat nelze.' });
      }
    }

    const user = await prisma.user.update({
      where:  { id: target.id },
      data:   { isSupervisor },
      select: { id: true, email: true, isSupervisor: true },
    });

    await createNotification(
      user.id,
      isSupervisor ? 'Máš roli supervisora' : 'Role supervisora odebrána',
      isSupervisor
        ? 'Byla ti přidělena role supervisora FSL. Ve Správě najdeš organizaci ligy.'
        : 'Tvoje role supervisora FSL byla odebrána.',
      'admin',
    );

    res.json(user);
  } catch (err) { next(err); }
});

// ==================== NOTIFIKACE ====================

router.post('/notify', async (req, res, next) => {
  try {
    const { userIds, title, body, screen } = req.body;
    if (!userIds?.length || !title || !body) {
      return res.status(400).json({ error: 'Chybí userIds, title nebo body' });
    }
    const items = userIds.map(userId => ({ userId, title, body, screen: screen || null }));
    await createNotifications(items);
    res.json({ sent: items.length });
  } catch (err) { next(err); }
});

// ==================== NABÍDKA TÝMU HRÁČŮM BEZ TÝMU ====================

/**
 * Rozešle informativní e-mail "liga ti složila tým" hráčům bez týmu.
 *
 * **Výchozí chování je náhled, ne odeslání.** Bez `poslat: true` endpoint
 * jen vrátí, komu by zpráva šla — rozeslání na desítky lidí se nedá vzít
 * zpět a seznam si musí člověk napřed přečíst.
 *
 * Komu už odešla, poznáme podle `Player.teamOfferMailAt`, takže druhé
 * spuštění doplní jen nové lidi. Brankáři dostanou jinou verzi textu;
 * post se bere z draftu, teprve pak z profilu — v draftu ho člověk vyplňoval
 * vědomě, `Player.position` má výchozí hodnotu "Útočník".
 */
router.post('/nabidka-tymu', async (req, res, next) => {
  try {
    const {
      poslat = false, castka = 500, standardni = 800,
      denHovoru = 'v pondělí 21. 9.', limit = 200, playerIds,
    } = req.body ?? {};

    const hraci = await prisma.player.findMany({
      where: {
        teamId:          null,
        teamOfferMailAt: null,
        userId:          { not: null },
        ...(playerIds?.length ? { id: { in: playerIds } } : {}),
      },
      select: {
        id: true, firstName: true, lastName: true, position: true,
        user:         { select: { email: true } },
        draftProfile: { select: { position: true } },
      },
      orderBy: { createdAt: 'asc' },
      take:    Math.min(Number(limit) || 200, 500),
    });

    const prijemci = hraci
      .filter((h) => h.user?.email)
      .map((h) => ({
        id:      h.id,
        jmeno:   h.firstName,
        email:   h.user.email,
        brankar: jeBrankar(h.draftProfile?.position ?? h.position),
      }));

    const bezMailu = hraci.length - prijemci.length;

    if (!poslat) {
      return res.json({
        nahled:    true,
        celkem:    prijemci.length,
        brankaru:  prijemci.filter((p) => p.brankar).length,
        doPole:    prijemci.filter((p) => !p.brankar).length,
        bezMailu,
        prijemci,
      });
    }

    let odeslano = 0;
    const selhalo = [];

    for (const p of prijemci) {
      const zprava = nabidkaTymuMail({
        jmeno: p.jmeno, brankar: p.brankar, castka, standardni, denHovoru,
      });
      const vysledek = await posliBezpecne(
        p.email,
        { ...zprava, replyTo: supervisorAddress() },
        'nabidka-tymu',
      );

      // Zapisujeme jen po úspěchu — komu se e-mail neodeslal, ten musí zůstat
      // ve frontě pro další běh, jinak o něj tiše přijdeme.
      if (vysledek.ok) {
        await prisma.player.update({
          where: { id: p.id },
          data:  { teamOfferMailAt: new Date() },
        });
        odeslano += 1;
      } else {
        selhalo.push({ email: p.email, duvod: vysledek.reason });
      }
    }

    res.json({ nahled: false, odeslano, selhalo, bezMailu });
  } catch (err) { next(err); }
});

module.exports = router;
