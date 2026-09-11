const express = require('express');

const { requireAuth, optionalAuth, isSupervisorUser } = require('../middleware/auth');
const { uploadPhoto } = require('../utils/fileUpload');
const { verejnyHrac } = require('../utils/verejneUdaje');
const vekSvc = require('../utils/vek');

const router = express.Router();
const prisma = require('../lib/prisma');
const licence = require('../services/licence');
const seasonSvc = require('../services/seasonTransition');
const kredit = require('../services/kredit');
const { v4: uuidv4 } = require('uuid');

/**
 * Ověření pozvánkového kódu na jednom místě — používá ho registrace hráče
 * i připojení hráče, který tým nemá.
 *
 * Vrací `{ invite }`, nebo `{ status, error }` k rovnou odeslání.
 */
async function overPozvanku(inviteCode) {
  const invite = await prisma.inviteCode.findUnique({
    where:   { code: String(inviteCode).toUpperCase() },
    include: { team: true },
  });
  if (!invite) return { status: 404, error: 'Neplatný pozvánkový kód' };
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    return { status: 400, error: 'Pozvánkový kód vypršel' };
  }
  // Do zamítnutého týmu nemá smysl pouštět nikoho — ten už hrát nebude.
  // Tým ve stavu PENDING je naopak běžný: nový tým čeká na schválení
  // a hráči se do něj musí umět zapsat, jinak se nemá jak přihlásit.
  if (invite.team?.regStatus === 'REJECTED') {
    return { status: 409, error: 'Registrace tohohle týmu byla zamítnutá, do soupisky se přidat nedá' };
  }
  return { invite };
}

/** Číslo dresu obsazené v týmu? Vrací `true`, když ano. */
async function dresObsazeny(teamId, jerseyNum, krome = null) {
  const kolize = await prisma.player.findFirst({
    where: {
      teamId,
      jersey: jerseyNum,
      ...(krome ? { id: { not: krome } } : {}),
    },
  });
  return !!kolize;
}

/**
 * Zapíše hráče na soupisku sezóny a spotřebuje pozvánku.
 *
 * Běží až po vytvoření/úpravě hráče a **nesmí shodit celý požadavek** — profil
 * už existuje a chyba tady by uživatele poslala do opakování, které skončí 409.
 * Když se zápis nepovede, vedoucí hráče doplní přes soupisku.
 */
async function dokonciVstupDoTymu(player, teamId, invite) {
  try {
    const sezona = await licence.sezonaTymu(teamId, await seasonSvc.currentSeason());
    if (sezona) {
      await licence.pridatDoSoupisky(player.id, teamId, sezona, { isHome: true });
    } else {
      console.warn(`[onboarding] Tým ${teamId} nemá přihlášku do žádné sezóny — hráč ${player.id} není na soupisce`);
    }
  } catch (err) {
    console.error('[onboarding] Zápis na soupisku selhal:', err.message);
  }

  if (invite) {
    try {
      await prisma.inviteCode.update({
        where: { id: invite.id },
        data:  { usedCount: { increment: 1 } },
      });
    } catch (err) {
      console.error('[onboarding] Počítadlo pozvánky se nezvýšilo:', err.message);
    }
  }
}

/** Supervisor, hráč sám, nebo vedoucí jeho týmu. */
function vidiOsobniUdaje(user, player) {
  if (!user) return false;
  if (isSupervisorUser(user)) return true;
  if (user.player?.id === player.id) return true;
  return player.teamId ? (user.manager ?? []).some(m => m.teamId === player.teamId) : false;
}

// GET /players – seznam všech hráčů (veřejné)
router.get('/', async (req, res, next) => {
  try {
    const { teamId, licensed } = req.query;
    const players = await prisma.player.findMany({
      where: {
        ...(teamId && { teamId }),
        ...(licensed !== undefined && { licensed: licensed === 'true' }),
      },
      include: { team: { select: { id: true, name: true, abbr: true, color: true } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    res.json(players.map(verejnyHrac));
  } catch (err) { next(err); }
});

// GET /players/my/stats – osobní statistiky (MUSÍ být před /:id !)
router.get('/my/stats', requireAuth, async (req, res, next) => {
  try {
    const { season } = req.query;
    const matchWhere = season ? { match: { season } } : undefined;

    const player = await prisma.player.findUnique({
      where: { userId: req.user.id },
      include: {
        goals:    { where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        assists:  { where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        penalties:{ where: matchWhere, include: { match: { select: { id: true, date: true, season: true, homeTeam: { select: { abbr: true } }, awayTeam: { select: { abbr: true } } } } } },
        mvpVotes: { where: season ? { match: { season } } : undefined },
      },
    });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    res.json({
      goals:     player.goals.length,
      assists:   player.assists.length,
      points:    player.goals.length + player.assists.length,
      penalties: player.penalties.length,
      mvpVotes:  player.mvpVotes.length,
      recentGoals:    player.goals.slice(-5).reverse(),
      recentAssists:  player.assists.slice(-5).reverse(),
    });
  } catch (err) { next(err); }
});

// GET /players/:id – detail hráče
// Veřejné, proto `optionalAuth`: telefon, datum narození a platby vidí jen
// hráč sám, vedoucí jeho týmu a supervisor.
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({
      where: { id: req.params.id },
      include: {
        team: true,
        goals:   { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        assists: { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        mvpVotes: { include: { match: { include: { homeTeam: true, awayTeam: true } } } },
        payment: true,
      },
    });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    res.json(vidiOsobniUdaje(req.user, player) ? player : verejnyHrac(player));
  } catch (err) { next(err); }
});

// POST /players – registrace hráče do týmu
// Vyžaduje: jméno, příjmení, číslo dresu, pozici, teamId
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const {
      firstName, lastName, jersey, position, birthdate, phone, teamId, inviteCode,
      // Hráč bez týmu: chce do draft poolu, kód od vedoucího nemá a mít
      // nemůže. Je to výslovný příznak, ne mlčky povolený stav — klient,
      // kterému se jen ztratil kód, nemá nechtěně skončit bez týmu.
      bezTymu,
    } = req.body;

    const doDraftu = bezTymu === true && !inviteCode && !teamId;

    // Dres 0 je platné číslo, proto se ptáme na prázdnou hodnotu, ne na falsy.
    // Hráč bez týmu dres nepotřebuje — čísla se hlídají v rámci týmu a on
    // v žádném není. Vybere si ho, až ho někdo draftuje.
    const dresChybi = jersey === undefined || jersey === null || jersey === '';
    if (!firstName || !lastName || (dresChybi && !doDraftu)) {
      return res.status(400).json({ error: 'Chybí povinné údaje (jméno, příjmení, číslo dresu)' });
    }

    // Do ligy smí jen dospělí. Datum narození proto není volitelný doplněk,
    // ale podmínka registrace — a hlídá se tady, protože formulář na webu
    // i v aplikaci se dá obejít.
    if (!birthdate) {
      return res.status(400).json({
        error: 'Datum narození je povinné.',
        code:  'BIRTHDATE_REQUIRED',
      });
    }
    const vekOk = vekSvc.zkontrolujDatumNarozeni(birthdate);
    if (!vekOk.ok) {
      return res.status(400).json({ error: vekOk.chyba, code: vekOk.kod });
    }

    // Tým se odvozuje z pozvánkového kódu. Holé teamId zůstává jako fallback
    // pro starší verze aplikace, které kód ještě neposílají.
    let invite = null;
    let cilovyTeamId = teamId;

    if (inviteCode) {
      const overeni = await overPozvanku(inviteCode);
      if (overeni.error) return res.status(overeni.status).json({ error: overeni.error });
      invite = overeni.invite;
      cilovyTeamId = invite.teamId;
    }

    if (!cilovyTeamId && !doDraftu) {
      return res.status(400).json({
        error: 'Chybí pozvánkový kód. Pokud tým nemáš, dá se profil založit i bez něj '
             + 'a nabídnout se v draftu.',
        code:  'NO_INVITE_CODE',
      });
    }

    // BUG-09 OPRAVA: Validace čísla dresu (zabraňuje NaN z parseInt)
    const jerseyNum = dresChybi ? 0 : parseInt(jersey, 10);
    if (isNaN(jerseyNum) || jerseyNum < 0 || jerseyNum > 99) {
      return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
    }

    // ── Hráč bez týmu ────────────────────────────────────────────────────
    // Draft pool je jediná cesta do ligy pro toho, kdo nikoho nezná. Bez
    // téhle větve se do něj nedalo dostat vůbec: `POST /draft/profile` chce
    // hráčský profil bez týmu, ale profil šel založit jen pozvánkovým kódem,
    // který hráče rovnou do týmu zapsal.
    if (doDraftu) {
      const existujici = await prisma.player.findUnique({ where: { userId: req.user.id } });
      if (existujici) {
        // Profil už má. S týmem je to chyba, bez týmu je to zopakovaný
        // požadavek — vrátíme, co existuje, ať onboarding doběhne.
        if (existujici.teamId) {
          return res.status(409).json({
            error: 'Hráčský profil už máš a jsi v týmu. Nejdřív ho opusť v nastavení profilu.',
            code:  'ALREADY_IN_TEAM',
          });
        }
        return res.status(200).json(existujici);
      }

      const sezonaLigy = await seasonSvc.currentSeason();
      const volny = await prisma.player.create({
        data: {
          userId:    req.user.id,
          teamId:    null,
          firstName,
          lastName,
          jersey:    jerseyNum,
          position:  position || 'Útočník',
          birthdate: vekOk.datum,
          phone,
          payment:   { create: sezonaLigy ? { season: sezonaLigy } : {} },
        },
      });
      return res.status(201).json(volny);
    }

    // Uživatel už hráče má. Není to nutně chyba — může to být zopakovaný
    // požadavek po výpadku sítě, nebo hráč bez týmu s novou pozvánkou.
    const existing = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (existing) {
      if (existing.teamId === cilovyTeamId) {
        // Retry po timeoutu: vrať, co už existuje, ať onboarding může doběhnout
        return res.status(200).json(existing);
      }
      if (existing.teamId) {
        return res.status(409).json({
          error: 'Hráčský profil už máš a jsi v týmu. Nejdřív ho opusť v nastavení profilu.',
          code:  'ALREADY_IN_TEAM',
        });
      }
      // Profil bez týmu — pozvánku použijeme na připojení, ne na nový profil
      if (await dresObsazeny(cilovyTeamId, jerseyNum, existing.id)) {
        return res.status(409).json({ error: `Číslo dresu ${jerseyNum} je již obsazeno v tomto týmu` });
      }
      const pripojeny = await prisma.player.update({
        where: { id: existing.id },
        data:  { teamId: cilovyTeamId, jersey: jerseyNum },
      });
      await dokonciVstupDoTymu(pripojeny, cilovyTeamId, invite);
      return res.status(200).json(pripojeny);
    }

    // Zkontroluj unikátnost čísla dresu v týmu
    if (await dresObsazeny(cilovyTeamId, jerseyNum)) {
      return res.status(409).json({ error: `Číslo dresu ${jerseyNum} je již obsazeno v tomto týmu` });
    }

    // Sezóna se bere z přihlášky týmu, ne z té, kterou zrovna ukazuje liga —
    // jinak by platba nesla jinou sezónu, než do jaké hráč nastupuje
    const sezona = await licence.sezonaTymu(cilovyTeamId, await seasonSvc.currentSeason());

    const player = await prisma.player.create({
      data: {
        userId: req.user.id,
        teamId: cilovyTeamId,
        firstName,
        lastName,
        jersey: jerseyNum,
        position: position || 'Útočník',
        birthdate: vekOk.datum,
        phone,
        payment: { create: sezona ? { season: sezona } : {} },
      },
    });

    // Kmenový tým se rovnou promítne do soupisky sezóny — z ní se skládá sestava.
    // Případné selhání profil neshodí, jen se zaloguje.
    await dokonciVstupDoTymu(player, cilovyTeamId, invite);

    res.status(201).json(player);
  } catch (err) { next(err); }
});

// POST /players/join – hráč, který tým nemá, se připojí pozvánkovým kódem.
// Bez tohohle endpointu se hráč po opuštění týmu dostal jinam jen draftem:
// nový profil mu brání unikátní userId a PUT /players/:id teamId nemění.
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const { inviteCode, jersey } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Chybí pozvánkový kód' });

    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) {
      return res.status(404).json({ error: 'Nemáš hráčský profil — dokonči nejdřív registraci hráče' });
    }
    if (player.teamId) {
      return res.status(409).json({
        error: 'Jsi v týmu. Nejdřív ho opusť a pak použij nový kód.',
        code:  'ALREADY_IN_TEAM',
      });
    }

    const overeni = await overPozvanku(inviteCode);
    if (overeni.error) return res.status(overeni.status).json({ error: overeni.error });
    const { invite } = overeni;

    // Dres si hráč může u nového týmu změnit; když nic nepošle, zkusíme původní
    const jerseyNum = jersey === undefined || jersey === null || jersey === ''
      ? player.jersey
      : parseInt(jersey, 10);
    if (isNaN(jerseyNum) || jerseyNum < 0 || jerseyNum > 99) {
      return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
    }
    if (await dresObsazeny(invite.teamId, jerseyNum, player.id)) {
      return res.status(409).json({
        error: `Číslo dresu ${jerseyNum} je v týmu obsazené, vyber si jiné`,
        code:  'JERSEY_TAKEN',
      });
    }

    const updated = await prisma.player.update({
      where: { id: player.id },
      data:  { teamId: invite.teamId, jersey: jerseyNum },
    });
    await dokonciVstupDoTymu(updated, invite.teamId, invite);

    res.json({ player: updated, team: invite.team });
  } catch (err) { next(err); }
});

// PUT /players/:id – úprava hráčského profilu (vlastní hráč nebo vedoucí)
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });

    const isSelf    = player.userId === req.user.id;
    const isManager = req.user.manager?.some(m => m.teamId === player.teamId);
    if (!isSelf && !isManager) return res.status(403).json({ error: 'Nemáte oprávnění' });

    const { firstName, lastName, jersey, position, birthdate, phone } = req.body;

    // Věkovou hranici hlídá i editace. Bez toho by stačilo projít registrací
    // se správným datem a hned si ho v profilu přepsat.
    let noveDatum;
    if (birthdate !== undefined) {
      if (!birthdate) {
        return res.status(400).json({
          error: 'Datum narození je povinné.',
          code:  'BIRTHDATE_REQUIRED',
        });
      }
      const vekOk = vekSvc.zkontrolujDatumNarozeni(birthdate);
      if (!vekOk.ok) return res.status(400).json({ error: vekOk.chyba, code: vekOk.kod });
      noveDatum = vekOk.datum;
    }

    // BUG-09 OPRAVA: Validace čísla dresu při editaci
    if (jersey !== undefined && jersey !== null && jersey !== '') {
      const jerseyEditNum = parseInt(jersey, 10);
      if (isNaN(jerseyEditNum) || jerseyEditNum < 0 || jerseyEditNum > 99) {
        return res.status(400).json({ error: 'Číslo dresu musí být číslo v rozsahu 0–99' });
      }
    }

    // Zkontroluj unikátnost čísla dresu při změně
    if (jersey && player.teamId) {
      const jerseyTaken = await prisma.player.findFirst({
        where: { teamId: player.teamId, jersey: parseInt(jersey, 10), NOT: { id: req.params.id } },
      });
      if (jerseyTaken) return res.status(409).json({ error: `Číslo dresu ${parseInt(jersey, 10)} je již obsazeno v tomto týmu` });
    }

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: {
        ...(firstName !== undefined && firstName && { firstName }),
        ...(lastName  !== undefined && lastName  && { lastName }),
        ...(jersey    !== undefined && jersey    && { jersey: parseInt(jersey, 10) }),
        ...(position  !== undefined && { position:  position  || null }),
        ...(noveDatum && { birthdate: noveDatum }),
        ...(phone     !== undefined && { phone:     phone     || null }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /players/:id/leave-team – hráč opustí tým
router.post('/:id/leave-team', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    if (player.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (!player.teamId) return res.status(400).json({ error: 'Hráč není v žádném týmu' });

    const sezona = await licence.sezonaTymu(player.teamId, await seasonSvc.currentSeason());
    if (sezona) await licence.odebratZeSoupisky(req.params.id, player.teamId, sezona);

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: { teamId: null },
    });
    res.json({ ok: true, player: updated });
  } catch (err) { next(err); }
});

// DELETE /players/:id/team/:teamId – manažer odebere hráče z týmu
router.delete('/:id/team/:teamId', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });

    const isManager = req.user.manager?.some(m => m.teamId === req.params.teamId);
    const isSup = req.user?.player?.isSupervisor;
    if (!isManager && !isSup) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (player.teamId !== req.params.teamId) return res.status(400).json({ error: 'Hráč není v tomto týmu' });

    const sezona = await licence.sezonaTymu(req.params.teamId, await seasonSvc.currentSeason());
    if (sezona) await licence.odebratZeSoupisky(req.params.id, req.params.teamId, sezona);

    await prisma.player.update({
      where: { id: req.params.id },
      data: { teamId: null },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /players/:id/photo – nahrání fotky
router.post('/:id/photo', requireAuth, uploadPhoto.single('photo'), async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!player) return res.status(404).json({ error: 'Hráč nenalezen' });
    if (player.userId !== req.user.id) return res.status(403).json({ error: 'Nemáte oprávnění' });
    if (!req.file) return res.status(400).json({ error: 'Nebyl nahrán žádný soubor' });

    const updated = await prisma.player.update({
      where: { id: req.params.id },
      data: { photoUrl: req.file.path },
    });
    res.json({ photoUrl: updated.photoUrl });
  } catch (err) { next(err); }
});

// ==================== DOPORUČENÍ ====================
//
// Každý hráč má svůj kód. Kdo s ním přijde do ligy nový, zaplatí registraci
// a koupí si balíček od tří zápasů výš, přinese tomu, kdo ho přivedl,
// **jeden zápas zdarma**. Nový hráč může jít do libovolného týmu.
//
// **Počet přivedených hráčů omezený není** a strop se ani nechystá — každý
// přivedený si své zápasy platí sám, takže odměna nikdy nepřeroste to, co
// ten člověk do ligy přinesl.

// GET /players/me/referral – můj kód (vygeneruje se při prvním zobrazení)
router.get('/me/referral', requireAuth, async (req, res, next) => {
  try {
    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    let kod = await prisma.referralCode.findUnique({ where: { playerId: player.id } });
    if (!kod) {
      // Kód se odemyká **po prvním odehraném zápase**. Přivést někoho do ligy
      // má smysl až ve chvíli, kdy má člověk co doporučovat — a odměna je
      // zápas zdarma, takže dřív by ji čerpal někdo, kdo sám nehraje.
      // Komu už kód jednou vznikl, zůstává (kontrola je jen na založení).
      const odehrano = await kredit.odehranychZapasu(player.id);
      if (odehrano === 0) {
        return res.status(409).json({
          error: 'Doporučovací kód se odemkne po prvním odehraném zápase.',
          code:  'NO_MATCH_YET',
          played: 0,
        });
      }

      const zkratka = (player.lastName || 'FSL').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '')
        .toUpperCase().slice(0, 3).padEnd(3, 'X');
      kod = await prisma.referralCode.create({
        data: { playerId: player.id, code: `FSL-${zkratka}-${uuidv4().slice(0, 4).toUpperCase()}` },
      });
    }

    const uziti = await prisma.referralUse.findMany({
      where:   { codeId: kod.id },
      include: { newPlayer: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      code:     kod.code,
      invited:  uziti.length,
      rewarded: uziti.filter(u => u.rewardedAt).length,
      uses: uziti.map(u => ({
        player:   u.newPlayer,
        joinedAt: u.createdAt,
        rewarded: !!u.rewardedAt,
      })),
      rule: `Odměna 1 zápas zdarma se připíše, jakmile si přivedený hráč koupí `
          + `balíček od ${kredit.MIN_BALICEK_PRO_ODMENU} zápasů výš. `
          + `Kolik hráčů přivedeš, omezené není.`,
    });
  } catch (err) { next(err); }
});

// POST /players/referral – nový hráč zadá kód toho, kdo ho přivedl
router.post('/referral', requireAuth, async (req, res, next) => {
  try {
    const kodText = String(req.body.code ?? '').trim().toUpperCase();
    if (!kodText) return res.status(400).json({ error: 'Chybí kód' });

    const player = await prisma.player.findUnique({ where: { userId: req.user.id } });
    if (!player) return res.status(404).json({ error: 'Hráčský profil nenalezen' });

    const kod = await prisma.referralCode.findUnique({ where: { code: kodText } });
    if (!kod) return res.status(404).json({ error: 'Takový kód neexistuje', code: 'BAD_REFERRAL' });

    // Vlastní kód si zadat nejde a přivedený může být člověk jen jednou.
    if (kod.playerId === player.id) {
      return res.status(409).json({ error: 'Vlastní kód použít nejde', code: 'SELF_REFERRAL' });
    }
    const uz = await prisma.referralUse.findUnique({ where: { newPlayerId: player.id } });
    if (uz) {
      return res.status(409).json({ error: 'Kód už jsi jednou uplatnil', code: 'ALREADY_REFERRED' });
    }

    // Kód patří novým hráčům. Kdo už za ligu nastoupil, není koho přivádět.
    // Kontumace se nepočítá — hráč byl na papíře v sestavě, ale nehrál.
    const starty = await kredit.odehranychZapasu(player.id);
    if (starty > 0) {
      return res.status(409).json({
        error: 'Kód jde uplatnit jen před prvním odehraným zápasem',
        code:  'NOT_NEW_PLAYER',
      });
    }

    await prisma.referralUse.create({ data: { codeId: kod.id, newPlayerId: player.id } });
    res.status(201).json({
      ok: true,
      note: `Kód je uplatněný. Odměna se tomu, kdo tě přivedl, připíše, `
          + `až si koupíš balíček od ${kredit.MIN_BALICEK_PRO_ODMENU} zápasů výš.`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
