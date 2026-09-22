/**
 * FSL — TESTOVACÍ DATA PRO CHAT A PANDU
 *
 *   node scripts/seed-chat.js                 vytvoří data
 *   node scripts/seed-chat.js --email a@b.cz  přidá k tomu tvůj účet (jinak info@fslleague.cz)
 *   node scripts/seed-chat.js --smaz          smaže všechno, co skript vytvořil
 *
 * **Proč je to bezpečné pustit i na ostré databázi.** Týmy se veřejně
 * nezobrazují do startu sezóny (`utils/sezona.js`), hráči taky ne a všichni
 * testovací uživatelé mají e-mail na doméně `@chat.test`, takže se nedají
 * splést s živými přihláškami. `--smaz` je najde podle jména týmu a podle té
 * domény a odklidí je i se zprávami.
 *
 * **Čeho se skript nedotkne.** Pokud už tvůj účet hráčský profil má, skript
 * ho nechá být a jen tě přidá do testovací konverzace — nikdy ti nepřepíše
 * tým, ve kterém doopravdy hraješ.
 *
 * Co vznikne:
 *   · dva testovací týmy (jeden otevřený, s Pandou na FULL)
 *   · 11 hráčů + soupiska na sezónu, z toho jeden brankář
 *   · zápas za čtyři dny → v „Můj tým" svítí 7/9 a chybí brankář
 *   · týmový chat s historií (Panda, hráči, dva dny zpátky)
 *   · vlákno „Napsat lize", které čeká na supervisora → fronta není prázdná
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const chat = require('../src/services/chat');
const { SABLONY } = require('../src/services/panda-texty');
const seasonSvc = require('../src/services/seasonTransition');

const TYM = 'ZKUŠEBNÍ TÝM (chat)';
const SOUPER = 'ZKUŠEBNÍ SOUPEŘ (chat)';
const DOMENA = '@chat.test';
const HALA = 'Sokolovna Žižkov';

const arg = (jmeno) => {
  const i = process.argv.indexOf(jmeno);
  return i === -1 ? null : process.argv[i + 1];
};
const MAZAT = process.argv.includes('--smaz');
const MUJ_EMAIL = arg('--email') || 'info@fslleague.cz';

/** Hráči testovacího týmu. `hraje` = co odpověděl na „jedeš?". */
const LIDE = [
  { jm: 'Petr',    pr: 'Novák',     c: 7,  post: 'Útočník', slot: 'FIELD',      hraje: true  },
  { jm: 'Martin',  pr: 'Kříž',      c: 12, post: 'Obránce', slot: 'FIELD',      hraje: true  },
  { jm: 'Jakub',   pr: 'Dvořák',    c: 18, post: 'Útočník', slot: 'FIELD',      hraje: true  },
  { jm: 'Ondřej',  pr: 'Veselý',    c: 23, post: 'Obránce', slot: 'FIELD',      hraje: true  },
  { jm: 'Lukáš',   pr: 'Horák',     c: 9,  post: 'Útočník', slot: 'FIELD',      hraje: true  },
  { jm: 'David',   pr: 'Němec',     c: 15, post: 'Obránce', slot: 'FIELD',      hraje: true  },
  { jm: 'Tomáš',   pr: 'Pokorný',   c: 21, post: 'Útočník', slot: 'FIELD',      hraje: true  },
  { jm: 'Filip',   pr: 'Marek',     c: 4,  post: 'Obránce', slot: 'FIELD',      hraje: false },
  { jm: 'Adam',    pr: 'Beneš',     c: 27, post: 'Útočník', slot: 'FIELD',      hraje: null  },
  { jm: 'Michal',  pr: 'Šimek',     c: 33, post: 'Útočník', slot: 'FIELD',      hraje: null  },
  { jm: 'Radek',   pr: 'Kolář',     c: 1,  post: 'Brankář', slot: 'GOALKEEPER', hraje: null  },
];

const email = (i) => `chat-test-${i + 1}${DOMENA}`;

/** Čas: `dnu` dní od teď, v `hod`:`min` pražského času. */
function kdy(dnu, hod, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dnu);
  // Praha je v listopadu +01:00, v září +02:00 — offset si necháme spočítat.
  const o = chat.offsetPrahy(d) / 60;
  d.setUTCHours(hod - o, min, 0, 0);
  return d;
}

/* ══════════════════════════════ MAZÁNÍ ══════════════════════════════ */

async function smaz() {
  console.log('\n🧹 Mažu testovací data chatu\n');

  const tymy = await prisma.team.findMany({
    where: { name: { in: [TYM, SOUPER] } },
    select: { id: true, name: true },
  });
  if (!tymy.length) {
    console.log('  Nic tu není — buď už smazáno, nebo ještě nevytvořeno.');
    return;
  }
  const tymIds = tymy.map(t => t.id);

  const hraci = await prisma.player.findMany({
    where: { teamId: { in: tymIds } },
    select: { id: true, userId: true, firstName: true, lastName: true, user: { select: { email: true } } },
  });
  const testovaci = hraci.filter(h => h.user?.email?.endsWith(DOMENA));
  const skutecni  = hraci.filter(h => !h.user?.email?.endsWith(DOMENA));
  const vsichniIds = hraci.map(h => h.id);

  const konverzace = await prisma.conversation.findMany({
    where: {
      OR: [
        { teamId: { in: tymIds } },
        { ownerPlayerId: { in: vsichniIds } },
      ],
    },
    select: { id: true },
  });
  const konvIds = konverzace.map(k => k.id);

  const zapasy = await prisma.match.findMany({
    where: { OR: [{ homeTeamId: { in: tymIds } }, { awayTeamId: { in: tymIds } }] },
    select: { id: true },
  });
  const zapasIds = zapasy.map(z => z.id);

  // Pořadí je dané cizími klíči: nejdřív obsah, pak nosiče. Chat schválně
  // nemá relace na Prisma úrovni (zprávy musí přežít smazání účtu), takže
  // se navázané řádky mažou ručně — kaskáda to za nás neudělá.
  const zpravyIds = (await prisma.message.findMany({
    where: { conversationId: { in: konvIds } }, select: { id: true },
  })).map(m => m.id);
  await prisma.messageReaction.deleteMany({ where: { messageId: { in: zpravyIds } } });
  await prisma.messageAttachment.deleteMany({ where: { messageId: { in: zpravyIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: konvIds } } });
  await prisma.conversationMember.deleteMany({ where: { conversationId: { in: konvIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: konvIds } } });
  await prisma.pandaEvent.deleteMany({ where: { teamId: { in: tymIds } } });
  await prisma.matchSignup.deleteMany({ where: { matchId: { in: zapasIds } } });
  await prisma.matchScorekeeper.deleteMany({ where: { matchId: { in: zapasIds } } });
  await prisma.matchNote.deleteMany({ where: { matchId: { in: zapasIds } } });
  await prisma.matchPreview.deleteMany({ where: { matchId: { in: zapasIds } } });
  await prisma.match.deleteMany({ where: { id: { in: zapasIds } } });
  await prisma.teamRoster.deleteMany({ where: { teamId: { in: tymIds } } });

  // Skutečný člověk se jen vyváže z testovacího týmu — profil mu zůstane.
  for (const h of skutecni) {
    await prisma.player.update({ where: { id: h.id }, data: { teamId: null } });
    console.log(`  · ${h.firstName} ${h.lastName} vyvázán z testovacího týmu (profil zůstal)`);
  }

  await prisma.player.deleteMany({ where: { id: { in: testovaci.map(h => h.id) } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMENA } } });
  await prisma.team.deleteMany({ where: { id: { in: tymIds } } });

  console.log(`\n  ✓ smazáno: ${tymy.length} týmy, ${testovaci.length} testovacích hráčů, ${konvIds.length} konverzací, ${zapasIds.length} zápasů\n`);
}

/* ══════════════════════════════ SEED ══════════════════════════════ */

async function seed() {
  console.log('\n🌱 Testovací data pro chat a Pandu\n');

  const uz = await prisma.team.findFirst({ where: { name: TYM }, select: { id: true } });
  if (uz) {
    console.log('  ⚠ Testovací tým už existuje. Nejdřív spusť: node scripts/seed-chat.js --smaz\n');
    return;
  }

  const season = (await seasonSvc.currentSeason()) || '2026/27';
  console.log(`  Sezóna: ${season}`);

  const tym = await prisma.team.create({
    data: {
      name: TYM, abbr: 'TST', color: '#7C5CFF', division: 'Zkušební',
      venue: HALA, isOpen: true, pandaMode: 'FULL', regStatus: 'APPROVED',
    },
  });
  const souper = await prisma.team.create({
    data: {
      name: SOUPER, abbr: 'TS2', color: '#E0417A', division: 'Zkušební',
      isOpen: true, pandaMode: 'FULL', regStatus: 'APPROVED',
    },
  });
  console.log(`  ✓ týmy: ${tym.name} (otevřený, Panda FULL) + ${souper.name}`);

  // ── hráči ───────────────────────────────────────────────────────────
  const hraci = [];
  for (const [i, c] of LIDE.entries()) {
    const user = await prisma.user.create({ data: { email: email(i) } });
    const hrac = await prisma.player.create({
      data: {
        userId: user.id, teamId: tym.id,
        firstName: c.jm, lastName: c.pr, jersey: c.c, position: c.post,
      },
    });
    await prisma.teamRoster.create({
      data: { playerId: hrac.id, teamId: tym.id, season, slot: c.slot },
    });
    hraci.push({ ...c, id: hrac.id });
  }
  console.log(`  ✓ ${hraci.length} hráčů na soupisce (1 brankář)`);

  // ── zápas za čtyři dny ──────────────────────────────────────────────
  const zapas = await prisma.match.create({
    data: {
      homeTeamId: tym.id, awayTeamId: souper.id,
      division: 'Zkušební', season, round: 1,
      date: kdy(4, 19), venue: HALA, status: 'UPCOMING',
    },
  });
  console.log(`  ✓ zápas ${new Date(zapas.date).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })}, ${HALA}`);

  for (const h of hraci) {
    if (h.hraje === null) continue;
    await prisma.matchSignup.create({
      data: { matchId: zapas.id, playerId: h.id, playing: h.hraje },
    });
  }
  const jede = hraci.filter(h => h.hraje === true).length;
  console.log(`  ✓ přihlášky: ${jede}/${chat.MIN_HRACU}, brankář zatím mlčí`);

  // ── týmový chat ─────────────────────────────────────────────────────
  const konverzace = await chat.tymovaKonverzace(tym.id);
  await chat.synchronizujCleny(tym.id, season);

  const stav = `${jede}/${chat.MIN_HRACU}`;
  const zpravy = [
    { kdo: null,        t: SABLONY.OTEVRENO({ zapas, hala: HALA }), tr: 'PROVOZNI', v: kdy(-2, 9, 2) },
    { kdo: hraci[0].id, t: 'Jedu, přijedu rovnou z práce.',          tr: 'SPOLECENSKA', v: kdy(-2, 9, 14) },
    { kdo: hraci[1].id, t: 'Já taky. Vezmu náhradní míčky.',         tr: 'SPOLECENSKA', v: kdy(-2, 9, 15) },
    { kdo: hraci[7].id, t: 'Bohužel jsem ve čtvrtek pryč, omlouvám se.', tr: 'SPOLECENSKA', v: kdy(-1, 18, 40) },
    { kdo: null,        t: SABLONY.CHYBI_BRANKAR({ stav }),          tr: 'PROVOZNI', v: kdy(-1, 19, 0) },
    { kdo: hraci[2].id, t: 'Radku, vezmeš bránu? Jinak se poptám v práci.', tr: 'SPOLECENSKA', v: kdy(0, 8, 30) },
  ];
  for (const z of zpravy) {
    await prisma.message.create({
      data: {
        conversationId: konverzace.id,
        authorPlayerId: z.kdo,
        body: z.t,
        class: z.tr,
        createdAt: z.v,
      },
    });
  }
  await prisma.conversation.update({
    where: { id: konverzace.id },
    data: { lastMessageAt: zpravy[zpravy.length - 1].v },
  });
  console.log(`  ✓ týmový chat: ${zpravy.length} zpráv (2 od Pandy)`);

  // ── vlákno s ligou, které čeká na supervisora ───────────────────────
  const vlakno = await chat.vlaknoSLigou(hraci[4].id);
  const dueAt = chat.konecDalsihoDne();
  await prisma.message.create({
    data: {
      conversationId: vlakno.id, authorPlayerId: hraci[4].id, class: 'PROVOZNI',
      body: 'Zaplatil jsem balíček startů minulý týden, ale pořád mi to píše nezaplaceno. Můžete se na to kouknout?',
      createdAt: kdy(0, 7, 55),
    },
  });
  await prisma.message.create({
    data: {
      conversationId: vlakno.id, authorPlayerId: chat.PANDA, class: 'PROVOZNI',
      body: `Předala jsem to lize. Ozve se ti nejpozději ${new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', weekday: 'long', day: 'numeric', month: 'numeric' }).format(dueAt).replace(/ /g, ' ')}.`,
      createdAt: kdy(0, 7, 55),
    },
  });
  await prisma.conversation.update({
    where: { id: vlakno.id },
    data: {
      lastMessageAt: kdy(0, 7, 55),
      waitingSupervisor: true,
      dueAt,
      escalCategory: 'nezatrideno',
      escalReason: 'seed — ukázka fronty supervisora',
    },
  });
  console.log(`  ✓ „Napsat lize": jedno vlákno čeká na supervisora (do ${dueAt.toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })})`);

  // ── tvůj účet ───────────────────────────────────────────────────────
  const ja = await prisma.user.findUnique({
    where: { email: MUJ_EMAIL },
    select: { id: true, email: true, player: { select: { id: true, teamId: true, firstName: true, lastName: true } } },
  });
  if (!ja) {
    console.log(`\n  ⚠ Účet ${MUJ_EMAIL} v databázi není — do týmu tě přidat neumím.`);
    console.log('    Spusť skript znovu s --email a adresou, kterou se přihlašuješ.');
  } else if (!ja.player) {
    const muj = await prisma.player.create({
      data: {
        userId: ja.id, teamId: tym.id,
        firstName: 'Jakub', lastName: 'Tabášek', jersey: 99, position: 'Útočník',
      },
    });
    await prisma.teamRoster.create({ data: { playerId: muj.id, teamId: tym.id, season, slot: 'FIELD' } });
    await prisma.conversationMember.create({ data: { conversationId: konverzace.id, playerId: muj.id } });
    console.log(`\n  ✓ ${MUJ_EMAIL} dostal hráčský profil (#99) v testovacím týmu`);
  } else if (!ja.player.teamId) {
    await prisma.player.update({ where: { id: ja.player.id }, data: { teamId: tym.id } });
    await prisma.teamRoster.create({ data: { playerId: ja.player.id, teamId: tym.id, season, slot: 'FIELD' } });
    await prisma.conversationMember.create({ data: { conversationId: konverzace.id, playerId: ja.player.id } });
    console.log(`\n  ✓ ${ja.player.firstName} ${ja.player.lastName} zařazen do testovacího týmu`);
  } else {
    await prisma.conversationMember.create({
      data: { conversationId: konverzace.id, playerId: ja.player.id },
    }).catch(() => {});
    console.log(`\n  ✓ ${ja.player.firstName} ${ja.player.lastName} přidán do testovacího chatu`);
    console.log('    (vlastní tým ti skript nechal být, takže „Můj tým" ukazuje pořád ten tvůj)');
  }

  console.log('\n  Kam se podívat:');
  console.log('    /zpravy   — seznam konverzací, týmový chat, fronta „Čeká na tebe"');
  console.log('    /muj-tym  — Hraju / nemůžu, 7/9, chybí brankář');
  console.log('\n  Úklid: node scripts/seed-chat.js --smaz\n');
}

(MAZAT ? smaz() : seed())
  .catch(e => { console.error('\n❌', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
