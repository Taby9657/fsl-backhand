/**
 * FSL – SEED TESTOVACÍCH DAT
 * Vytvoří kompletní testovací data: týmy, hráče, zápasy, platby, draft, highlights.
 * Spusť: node scripts/seed-test.js
 *
 * PO SPUŠTĚNÍ: Přihlaš se do appky přes Google, pak spusť:
 *   node scripts/link-account.js
 * a zadej svůj userId pro přiřazení role.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEASON = '2025/26';

// Pomocná funkce – datum relativně od dnes
function daysAgo(n)   { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysLater(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }

async function main() {
  console.log('\n🌱 FSL SEED TESTOVACÍCH DAT');
  console.log('════════════════════════════════════════\n');

  // ══════════════════════════════════════════
  //  1. TÝMY
  // ══════════════════════════════════════════
  console.log('📋 Vytvářím týmy...');

  const [teamOrli, teamOhen, teamSila, teamBoure] = await Promise.all([
    prisma.team.create({ data: {
      name: 'Pražští Orli', abbr: 'PRG', color: '#C9A140',
      venue: 'Sportovní hala Praha 6', division: 'Divize A',
    }}),
    prisma.team.create({ data: {
      name: 'Brněnský Oheň', abbr: 'BRN', color: '#EF4444',
      venue: 'KV Arena Brno', division: 'Divize A',
    }}),
    prisma.team.create({ data: {
      name: 'Ostravská Síla', abbr: 'OVA', color: '#3B82F6',
      venue: 'Multifunkční aréna Ostrava', division: 'Divize A',
    }}),
    prisma.team.create({ data: {
      name: 'Hradecká Bouře', abbr: 'HRD', color: '#10B981',
      venue: 'Zimní stadion Hradec Králové', division: 'Divize A',
    }}),
  ]);

  console.log(`  ✓ ${teamOrli.name}, ${teamOhen.name}, ${teamSila.name}, ${teamBoure.name}`);

  // ══════════════════════════════════════════
  //  2. USERS (placeholder – přihlášení přes Google je nahradí)
  // ══════════════════════════════════════════
  console.log('\n👤 Vytvářím testovací uživatele...');

  // Seed uživatelé nemají googleId – nemohou se přímo přihlásit.
  // Po přihlášení přes Google spusť link-account.js pro přiřazení role.
  const [
    uSupervisor, uGM1, uGM2,
    uP1, uP2, uP3, uP4, uP5,
    uFreeAgent1, uFreeAgent2,
    uReferee, uRefPending,
  ] = await Promise.all([
    prisma.user.create({ data: { email: 'seed-supervisor@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-gm1@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-gm2@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-p1@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-p2@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-p3@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-p4@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-p5@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-free1@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-free2@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-referee@fsl.test' } }),
    prisma.user.create({ data: { email: 'seed-refpending@fsl.test' } }),
  ]);

  console.log('  ✓ 12 seed uživatelů vytvořeno');

  // ══════════════════════════════════════════
  //  3. HRÁČI
  // ══════════════════════════════════════════
  console.log('\n🏑 Vytvářím hráče...');

  const [
    playerSupervisor, playerGM1,
    playerP1, playerP2,       // Pražští Orli
    playerP3, playerP4, playerP5, // Brněnský Oheň
    playerFree1, playerFree2,
  ] = await Promise.all([
    // Pražští Orli
    prisma.player.create({ data: {
      userId: uSupervisor.id, teamId: teamOrli.id,
      firstName: 'Tomáš', lastName: 'Novák',
      jersey: 1, position: 'Brankář', isSupervisor: true,
      phone: '+420 601 111 001',
    }}),
    prisma.player.create({ data: {
      userId: uGM1.id, teamId: teamOrli.id,
      firstName: 'Karel', lastName: 'Svoboda',
      jersey: 10, position: 'Útočník',
      phone: '+420 602 111 002',
    }}),
    prisma.player.create({ data: {
      userId: uP1.id, teamId: teamOrli.id,
      firstName: 'Jan', lastName: 'Procházka',
      jersey: 7, position: 'Útočník',
    }}),
    prisma.player.create({ data: {
      userId: uP2.id, teamId: teamOrli.id,
      firstName: 'Marek', lastName: 'Horáček',
      jersey: 15, position: 'Obránce',
    }}),
    // Brněnský Oheň
    prisma.player.create({ data: {
      userId: uGM2.id, teamId: teamOhen.id,
      firstName: 'Michal', lastName: 'Krejčí',
      jersey: 9, position: 'Útočník',
      phone: '+420 603 222 001',
    }}),
    prisma.player.create({ data: {
      userId: uP3.id, teamId: teamOhen.id,
      firstName: 'Ondřej', lastName: 'Blažek',
      jersey: 23, position: 'Obránce',
    }}),
    prisma.player.create({ data: {
      userId: uP4.id, teamId: teamOhen.id,
      firstName: 'Lukáš', lastName: 'Veselý',
      jersey: 11, position: 'Útočník',
    }}),
    // Volní hráči (bez týmu)
    prisma.player.create({ data: {
      userId: uFreeAgent1.id,
      firstName: 'Radek', lastName: 'Dvořák',
      jersey: 88, position: 'Útočník',
      phone: '+420 777 888 001',
    }}),
    prisma.player.create({ data: {
      userId: uFreeAgent2.id,
      firstName: 'Patrik', lastName: 'Šimánek',
      jersey: 44, position: 'Obránce',
      phone: '+420 777 888 002',
    }}),
    // Uživatel seed-p5 → hráč Ostravské Síly (bez managera = jen hráč s týmem)
    prisma.player.create({ data: {
      userId: uP5.id, teamId: teamSila.id,
      firstName: 'Jakub', lastName: 'Mašek',
      jersey: 3, position: 'Brankář',
    }}),
  ]);

  console.log('  ✓ 10 hráčů vytvořeno');

  // ══════════════════════════════════════════
  //  4. MANAŽEŘI
  // ══════════════════════════════════════════
  console.log('\n🏆 Vytvářím manažery...');

  await Promise.all([
    prisma.manager.create({ data: { userId: uGM1.id, teamId: teamOrli.id } }),
    prisma.manager.create({ data: { userId: uGM2.id, teamId: teamOhen.id } }),
  ]);

  console.log('  ✓ GM Pražských Orlů (Karel Svoboda), GM Brněnského Ohně (Michal Krejčí)');

  // ══════════════════════════════════════════
  //  5. ROZHODČÍ
  // ══════════════════════════════════════════
  console.log('\n🚩 Vytvářím rozhodčí...');

  const [referee, refPending] = await Promise.all([
    prisma.referee.create({ data: {
      userId: uReferee.id,
      firstName: 'Martin', lastName: 'Kolář',
      phone: '+420 605 333 001',
      level: 'B', status: 'APPROVED',
      bankAccount: '2200123456', bankCode: '0800',
      address: 'Korunní 15', city: 'Praha', zip: '12000',
    }}),
    prisma.referee.create({ data: {
      userId: uRefPending.id,
      firstName: 'Petr', lastName: 'Blaha',
      phone: '+420 606 333 002',
      level: 'C', status: 'PENDING',
      bankAccount: '2200654321', bankCode: '2010',
      address: 'Náměstí Míru 5', city: 'Brno', zip: '60200',
    }}),
  ]);

  console.log('  ✓ Martin Kolář (APPROVED), Petr Blaha (PENDING)');

  // ══════════════════════════════════════════
  //  6. POZVÁNKOVÉ KÓDY
  // ══════════════════════════════════════════
  await Promise.all([
    prisma.inviteCode.create({ data: { code: 'FSL-TM-ORLI', teamId: teamOrli.id } }),
    prisma.inviteCode.create({ data: { code: 'FSL-TM-OHEN', teamId: teamOhen.id } }),
    prisma.inviteCode.create({ data: { code: 'FSL-TM-SILA', teamId: teamSila.id } }),
    prisma.inviteCode.create({ data: { code: 'FSL-TM-BOUR', teamId: teamBoure.id } }),
  ]);

  // ══════════════════════════════════════════
  //  7. ZÁPASY
  // ══════════════════════════════════════════
  console.log('\n⚽ Vytvářím zápasy...');

  const [matchDone1, matchDone2, matchLive, matchUp1, matchUp2, matchCancelled] = await Promise.all([
    // ODEHRANÉ
    prisma.match.create({ data: {
      homeTeamId: teamOrli.id, awayTeamId: teamOhen.id,
      refereeId: referee.id,
      season: SEASON, division: 'Divize A', round: 1,
      date: daysAgo(15), venue: 'Sportovní hala Praha 6',
      homeScore: 5, awayScore: 3, status: 'DONE',
      homeFeePaid: true,
    }}),
    prisma.match.create({ data: {
      homeTeamId: teamOhen.id, awayTeamId: teamSila.id,
      refereeId: referee.id,
      season: SEASON, division: 'Divize A', round: 2,
      date: daysAgo(8), venue: 'KV Arena Brno',
      homeScore: 2, awayScore: 2, status: 'DONE',
      homeFeePaid: false,
    }}),
    // LIVE
    prisma.match.create({ data: {
      homeTeamId: teamSila.id, awayTeamId: teamBoure.id,
      refereeId: referee.id,
      season: SEASON, division: 'Divize A', round: 3,
      date: new Date(), venue: 'Multifunkční aréna Ostrava',
      homeScore: 1, awayScore: 0, status: 'LIVE',
    }}),
    // NADCHÁZEJÍCÍ
    prisma.match.create({ data: {
      homeTeamId: teamOrli.id, awayTeamId: teamSila.id,
      season: SEASON, division: 'Divize A', round: 4,
      date: daysLater(6), venue: 'Sportovní hala Praha 6',
      status: 'UPCOMING',
    }}),
    prisma.match.create({ data: {
      homeTeamId: teamBoure.id, awayTeamId: teamOhen.id,
      season: SEASON, division: 'Divize A', round: 5,
      date: daysLater(13), venue: 'Zimní stadion Hradec Králové',
      status: 'UPCOMING',
    }}),
    // ZRUŠENO
    prisma.match.create({ data: {
      homeTeamId: teamSila.id, awayTeamId: teamOrli.id,
      season: SEASON, division: 'Divize A', round: 6,
      date: daysAgo(3), venue: 'Multifunkční aréna Ostrava',
      status: 'CANCELLED',
    }}),
  ]);

  console.log('  ✓ 2× DONE, 1× LIVE, 2× UPCOMING, 1× CANCELLED');

  // ══════════════════════════════════════════
  //  8. UDÁLOSTI ZÁPASŮ (góly + tresty)
  // ══════════════════════════════════════════
  console.log('\n🎯 Vytvářím události zápasů...');

  // matchDone1: Orli 5:3 Oheň
  await prisma.matchEvent.createMany({ data: [
    { matchId: matchDone1.id, type: 'GOAL', minute: 4,  period: 1, teamId: teamOrli.id, scorerId: playerGM1.id, assistId: playerP1.id },
    { matchId: matchDone1.id, type: 'GOAL', minute: 11, period: 1, teamId: teamOhen.id, scorerId: playerP3.id },
    { matchId: matchDone1.id, type: 'PENALTY', minute: 14, period: 1, teamId: teamOhen.id, penaltyId: playerP4.id, penaltyType: '2min' },
    { matchId: matchDone1.id, type: 'GOAL', minute: 17, period: 1, teamId: teamOrli.id, scorerId: playerP1.id, assistId: playerGM1.id },
    { matchId: matchDone1.id, type: 'GOAL', minute: 23, period: 2, teamId: teamOhen.id, scorerId: playerP3.id, assistId: playerP4.id },
    { matchId: matchDone1.id, type: 'GOAL', minute: 28, period: 2, teamId: teamOrli.id, scorerId: playerGM1.id },
    { matchId: matchDone1.id, type: 'GOAL', minute: 34, period: 2, teamId: teamOhen.id, scorerId: playerP4.id },
    { matchId: matchDone1.id, type: 'PENALTY', minute: 37, period: 2, teamId: teamOrli.id, penaltyId: playerP2.id, penaltyType: '2min' },
    { matchId: matchDone1.id, type: 'GOAL', minute: 42, period: 3, teamId: teamOrli.id, scorerId: playerSupervisor.id, assistId: playerGM1.id },
    { matchId: matchDone1.id, type: 'GOAL', minute: 47, period: 3, teamId: teamOrli.id, scorerId: playerP1.id },
    { matchId: matchDone1.id, type: 'MATCH_END', minute: 60, period: 3 },
  ]});

  // matchDone2: Oheň 2:2 Síla
  await prisma.matchEvent.createMany({ data: [
    { matchId: matchDone2.id, type: 'GOAL', minute: 8,  period: 1, teamId: teamOhen.id, scorerId: playerP3.id },
    { matchId: matchDone2.id, type: 'GOAL', minute: 19, period: 1, teamId: teamSila.id, scorerId: playerP5.id },
    { matchId: matchDone2.id, type: 'PENALTY', minute: 25, period: 2, teamId: teamOhen.id, penaltyId: playerGM2.id, penaltyType: '2min' },
    { matchId: matchDone2.id, type: 'GOAL', minute: 31, period: 2, teamId: teamOhen.id, scorerId: playerGM2.id, assistId: playerP3.id },
    { matchId: matchDone2.id, type: 'GOAL', minute: 55, period: 3, teamId: teamSila.id, scorerId: playerP5.id },
    { matchId: matchDone2.id, type: 'MATCH_END', minute: 60, period: 3 },
  ]});

  // Live zápas – jeden gól zatím
  await prisma.matchEvent.createMany({ data: [
    { matchId: matchLive.id, type: 'GOAL', minute: 7, period: 1, teamId: teamSila.id, scorerId: playerP5.id },
  ]});

  console.log('  ✓ Události vytvořeny (17 gólů + 3 tresty)');

  // ══════════════════════════════════════════
  //  9. PLATBY HRÁČŮ
  // ══════════════════════════════════════════
  console.log('\n💰 Vytvářím platby...');

  // Platba hráče – generujeme variabilní symbol jako číslo
  let vsCounter = 100001;
  const playerPaymentData = [
    { playerId: playerSupervisor.id, licStatus: 'PAID',    licPaidAt: daysAgo(20), licMethod: 'bank' },
    { playerId: playerGM1.id,        licStatus: 'PAID',    licPaidAt: daysAgo(18), licMethod: 'bank' },
    { playerId: playerP1.id,         licStatus: 'PENDING' },
    { playerId: playerP2.id,         licStatus: 'OVERDUE' },
    { playerId: playerP3.id,         licStatus: 'PAID',    licPaidAt: daysAgo(10), licMethod: 'bank' },
    { playerId: playerP4.id,         licStatus: 'PENDING' },
    { playerId: playerGM2.id,        licStatus: 'PENDING' },
    { playerId: playerP5.id,         licStatus: 'WAIVED' },
    { playerId: playerFree1.id,      licStatus: 'PENDING' },
    { playerId: playerFree2.id,      licStatus: 'PENDING' },
  ];

  for (const data of playerPaymentData) {
    await prisma.playerPayment.create({ data: {
      playerId: data.playerId,
      season: SEASON,
      licFee: 300,
      licStatus: data.licStatus,
      licPaidAt: data.licPaidAt ?? null,
      licMethod: data.licMethod ?? null,
      superLic: false,
      superFee: 300,
      superStatus: 'PENDING',
      variableSymbol: String(vsCounter++),
    }});
  }

  // Platby týmů
  await Promise.all([
    prisma.teamPayment.create({ data: {
      teamId: teamOrli.id, season: SEASON, amount: 10000,
      status: 'PAID', paidAt: daysAgo(25), method: 'bank',
      variableSymbol: '900001',
    }}),
    prisma.teamPayment.create({ data: {
      teamId: teamOhen.id, season: SEASON, amount: 10000,
      status: 'PENDING', variableSymbol: '900002',
    }}),
    prisma.teamPayment.create({ data: {
      teamId: teamSila.id, season: SEASON, amount: 10000,
      status: 'OVERDUE', variableSymbol: '900003',
    }}),
    prisma.teamPayment.create({ data: {
      teamId: teamBoure.id, season: SEASON, amount: 10000,
      status: 'PENDING', variableSymbol: '900004',
    }}),
  ]);

  console.log('  ✓ Platby hráčů + týmové platby vytvořeny');

  // ══════════════════════════════════════════
  //  10. DRAFT
  // ══════════════════════════════════════════
  console.log('\n📋 Vytvářím draft data...');

  const draftProfile1 = await prisma.draftProfile.create({ data: {
    playerId: playerFree1.id,
    bio: 'Hraju florbal 8 let, specializace útočník. Hledám tým v divizi A nebo B. Jsem týmový hráč, spolehlivý na trénincích.',
    pubSkill: 'Mám nejlepší backhand v celé lize, garantuji aspoň 15 gólů za sezónu.',
    position: 'Útočník',
    isActive: true,
  }});

  const draftProfile2 = await prisma.draftProfile.create({ data: {
    playerId: playerFree2.id,
    bio: 'Zkušený obránce z mládežnické ligy, teď hledám seniorský tým. Dobré bruslení, čisté hry.',
    pubSkill: 'Žádný útočník mě ještě nepřekonal 1vs1 celou poslední sezónu.',
    position: 'Obránce',
    isActive: true,
  }});

  // Nabídka od Pražských Orlů na volného hráče 1
  const offerExpiresAt = daysLater(2); // okno vyprší za 2 dny
  await prisma.draftOffer.create({ data: {
    profileId: draftProfile1.id,
    teamId: teamOrli.id,
    message: 'Ahoj Radku, sledujeme tě delší dobu. Rádi bychom tě viděli na tréninku před rozhodnutím.',
    status: 'PENDING',
    isFirst: true,
    expiresAt: offerExpiresAt,
  }});

  console.log('  ✓ 2 draft profily, 1 nabídka od Pražských Orlů (vyprší za 2 dny)');

  // ══════════════════════════════════════════
  //  11. HIGHLIGHTS
  // ══════════════════════════════════════════
  console.log('\n🎬 Vytvářím highlights...');

  await prisma.roundHighlight.createMany({ data: [
    {
      round: 1, pinned: true,
      title: 'Orli rozstříleli Oheň 5:3!',
      body: 'Dramatický zápas prvního kola skončil vítězstvím domácích. Hattrick Karla Svobody rozhodl.',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    {
      round: 2, pinned: false,
      title: 'Remíza v Brně: Oheň vs Síla 2:2',
      body: 'Vyrovnaný souboj druhého kola. Síla srovnala ve třetí třetině. Oba týmy odchází s bodem.',
    },
    {
      round: null, pinned: false,
      title: 'Nová sezóna 2025/26 začíná!',
      body: 'Vítejte v nové sezóně FSL Ligy. Přihlaste své týmy, doplňte soupisky a těšte se na vzrušující florbal.',
    },
  ]});

  console.log('  ✓ 3 highlights (1 pinned)');

  // ══════════════════════════════════════════
  //  12. NOTIFIKACE (ukázkové)
  // ══════════════════════════════════════════
  await prisma.notification.createMany({ data: [
    {
      userId: uFreeAgent1.id,
      title: 'Draft – nová nabídka',
      body: 'Tým Pražští Orli tě chce draftovat. Máš 72 hodin na rozhodnutí.',
      screen: 'draft', read: false,
    },
    {
      userId: uGM1.id,
      title: 'Nový hráč v draftu',
      body: 'Patrik Šimánek se přidal do draft poolu.',
      screen: 'draft', read: false,
    },
  ]});

  // ══════════════════════════════════════════
  //  VÝSLEDKY
  // ══════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('✅ SEED DOKONČEN');
  console.log('═'.repeat(60));

  console.log(`
📦 VYTVOŘENÁ DATA:
  • 4 týmy: Pražští Orli, Brněnský Oheň, Ostravská Síla, Hradecká Bouře
  • 10 hráčů (8 s týmem, 2 volní)
  • 2 manažeři (GM Orlů, GM Ohně)
  • 2 rozhodčí (1 APPROVED, 1 PENDING)
  • 6 zápasů (2 DONE, 1 LIVE, 2 UPCOMING, 1 CANCELLED)
  • Události: góly + tresty v odehraných zápasech
  • Platby hráčů + týmů
  • 2 draft profily + 1 nabídka
  • 3 highlights
  • Pozvánkové kódy: FSL-TM-ORLI, FSL-TM-OHEN, FSL-TM-SILA, FSL-TM-BOUR

🔑 SEED USER IDs (pro přiřazení rolí):
`);

  const seedUsers = [
    { email: uSupervisor.id,    role: 'SUPERVISOR + hráč Pražských Orlů (Tomáš Novák)' },
    { email: uGM1.id,           role: 'GM Pražských Orlů + hráč (Karel Svoboda #10)' },
    { email: uGM2.id,           role: 'GM Brněnského Ohně (Michal Krejčí #9)' },
    { email: uP5.id,            role: 'Hráč S TÝMEM – Ostravská Síla (Jakub Mašek #3)' },
    { email: uFreeAgent1.id,    role: 'Hráč BEZ TÝMU + aktivní draft profil (Radek Dvořák)' },
    { email: uFreeAgent2.id,    role: 'Hráč BEZ TÝMU + aktivní draft profil (Patrik Šimánek)' },
    { email: uReferee.id,       role: 'Rozhodčí APPROVED (Martin Kolář)' },
    { email: uRefPending.id,    role: 'Rozhodčí PENDING (Petr Blaha)' },
  ];

  for (const u of seedUsers) {
    console.log(`  ${u.email}`);
    console.log(`    → ${u.role}\n`);
  }

  console.log(`📌 JAK SE PŘIHLÁSIT DO APPKY:
  1. Přihlaš se přes Google – v DB vznikne nový User
  2. Spusť: node scripts/link-account.js
  3. Zadej svůj User ID (z DB) a vyber roli
  4. Appka po refreshUser() ukáže přiřazenou roli
`);
}

main()
  .catch(err => { console.error('\n❌ CHYBA při seedu:', err.message); console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
