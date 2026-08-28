/**
 * FSL – SEED TESTOVACÍCH DAT
 * Spusť: node scripts/seed-test.js
 *
 * POZOR: Spusť nejdřív "npx prisma generate" pokud vidíš chyby o neznámých polích.
 *
 * PO SPUŠTĚNÍ: Přihlaš se do appky přes Google, pak spusť:
 *   node scripts/link-account.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEASON = '2025/26';

function daysAgo(n)   { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysLater(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }

async function main() {
  console.log('\n🌱 FSL SEED TESTOVACÍCH DAT');
  console.log('════════════════════════════════════════\n');

  // ══════════════════════════════════════════
  //  1. TÝMY
  // ══════════════════════════════════════════
  console.log('📋 Vytvářím týmy...');

  const teamOrli  = await prisma.team.create({ data: { name: 'Pražští Orli',    abbr: 'PRG', color: '#C9A140', division: 'Divize A' }});
  const teamOhen  = await prisma.team.create({ data: { name: 'Brněnský Oheň',   abbr: 'BRN', color: '#EF4444', division: 'Divize A' }});
  const teamSila  = await prisma.team.create({ data: { name: 'Ostravská Síla',  abbr: 'OVA', color: '#3B82F6', division: 'Divize A' }});
  const teamBoure = await prisma.team.create({ data: { name: 'Hradecká Bouře',  abbr: 'HRD', color: '#10B981', division: 'Divize A' }});

  console.log(`  ✓ ${teamOrli.name}, ${teamOhen.name}, ${teamSila.name}, ${teamBoure.name}`);

  // ══════════════════════════════════════════
  //  2. USERS (placeholder – bez googleId)
  // ══════════════════════════════════════════
  console.log('\n👤 Vytvářím seed uživatele...');

  const uSupervisor  = await prisma.user.create({ data: { email: 'seed-supervisor@fsl.test' }});
  const uGM1         = await prisma.user.create({ data: { email: 'seed-gm1@fsl.test' }});
  const uGM2         = await prisma.user.create({ data: { email: 'seed-gm2@fsl.test' }});
  const uOrliP1      = await prisma.user.create({ data: { email: 'seed-orli-p1@fsl.test' }});
  const uOrliP2      = await prisma.user.create({ data: { email: 'seed-orli-p2@fsl.test' }});
  const uOhenP1      = await prisma.user.create({ data: { email: 'seed-ohen-p1@fsl.test' }});
  const uOhenP2      = await prisma.user.create({ data: { email: 'seed-ohen-p2@fsl.test' }});
  const uSilaP1      = await prisma.user.create({ data: { email: 'seed-sila-p1@fsl.test' }});
  const uFreeAgent1  = await prisma.user.create({ data: { email: 'seed-free1@fsl.test' }});
  const uFreeAgent2  = await prisma.user.create({ data: { email: 'seed-free2@fsl.test' }});
  const uReferee     = await prisma.user.create({ data: { email: 'seed-referee@fsl.test' }});
  const uRefPending  = await prisma.user.create({ data: { email: 'seed-refpending@fsl.test' }});

  console.log('  ✓ 12 seed uživatelů');

  // ══════════════════════════════════════════
  //  3. HRÁČI
  // ══════════════════════════════════════════
  console.log('\n🏑 Vytvářím hráče...');

  // Pražští Orli
  const pSupervisor = await prisma.player.create({ data: {
    userId: uSupervisor.id, teamId: teamOrli.id,
    firstName: 'Tomáš', lastName: 'Novák',
    jersey: 1, position: 'Brankář', isSupervisor: true,
    phone: '+420 601 111 001',
  }});
  const pGM1 = await prisma.player.create({ data: {
    userId: uGM1.id, teamId: teamOrli.id,
    firstName: 'Karel', lastName: 'Svoboda',
    jersey: 10, position: 'Útočník',
    phone: '+420 602 111 002',
  }});
  const pOrliP1 = await prisma.player.create({ data: {
    userId: uOrliP1.id, teamId: teamOrli.id,
    firstName: 'Jan', lastName: 'Procházka',
    jersey: 7, position: 'Útočník',
  }});
  const pOrliP2 = await prisma.player.create({ data: {
    userId: uOrliP2.id, teamId: teamOrli.id,
    firstName: 'Marek', lastName: 'Horáček',
    jersey: 15, position: 'Obránce',
  }});

  // Brněnský Oheň
  const pGM2 = await prisma.player.create({ data: {
    userId: uGM2.id, teamId: teamOhen.id,
    firstName: 'Michal', lastName: 'Krejčí',
    jersey: 9, position: 'Útočník',
    phone: '+420 603 222 001',
  }});
  const pOhenP1 = await prisma.player.create({ data: {
    userId: uOhenP1.id, teamId: teamOhen.id,
    firstName: 'Ondřej', lastName: 'Blažek',
    jersey: 23, position: 'Obránce',
  }});
  const pOhenP2 = await prisma.player.create({ data: {
    userId: uOhenP2.id, teamId: teamOhen.id,
    firstName: 'Lukáš', lastName: 'Veselý',
    jersey: 11, position: 'Útočník',
  }});

  // Ostravská Síla
  const pSilaP1 = await prisma.player.create({ data: {
    userId: uSilaP1.id, teamId: teamSila.id,
    firstName: 'Jakub', lastName: 'Mašek',
    jersey: 3, position: 'Brankář',
  }});

  // Volní hráči (bez týmu) – pro draft testování
  const pFree1 = await prisma.player.create({ data: {
    userId: uFreeAgent1.id,
    firstName: 'Radek', lastName: 'Dvořák',
    jersey: 88, position: 'Útočník',
    phone: '+420 777 888 001',
  }});
  const pFree2 = await prisma.player.create({ data: {
    userId: uFreeAgent2.id,
    firstName: 'Patrik', lastName: 'Šimánek',
    jersey: 44, position: 'Obránce',
    phone: '+420 777 888 002',
  }});

  console.log('  ✓ 10 hráčů (8 s týmem, 2 volní)');

  // ══════════════════════════════════════════
  //  4. MANAŽEŘI
  // ══════════════════════════════════════════
  await prisma.manager.create({ data: { userId: uGM1.id, teamId: teamOrli.id }});
  await prisma.manager.create({ data: { userId: uGM2.id, teamId: teamOhen.id }});
  console.log('\n🏆 Manažeři: Karel Svoboda (Orli), Michal Krejčí (Oheň)');

  // ══════════════════════════════════════════
  //  5. ROZHODČÍ
  // ══════════════════════════════════════════
  const referee = await prisma.referee.create({ data: {
    userId: uReferee.id,
    firstName: 'Martin', lastName: 'Kolář',
    phone: '+420 605 333 001',
    level: 'B', status: 'APPROVED',
    bankAccount: '2200123456', bankCode: '0800',
    address: 'Korunní 15', city: 'Praha', zip: '12000',
  }});
  await prisma.referee.create({ data: {
    userId: uRefPending.id,
    firstName: 'Petr', lastName: 'Blaha',
    phone: '+420 606 333 002',
    level: 'C', status: 'PENDING',
    bankAccount: '2200654321', bankCode: '2010',
    address: 'Náměstí Míru 5', city: 'Brno', zip: '60200',
  }});
  console.log('\n🚩 Rozhodčí: Martin Kolář (APPROVED), Petr Blaha (PENDING)');

  // ══════════════════════════════════════════
  //  6. POZVÁNKOVÉ KÓDY
  // ══════════════════════════════════════════
  await prisma.inviteCode.createMany({ data: [
    { code: 'FSL-TM-ORLI', teamId: teamOrli.id },
    { code: 'FSL-TM-OHEN', teamId: teamOhen.id },
    { code: 'FSL-TM-SILA', teamId: teamSila.id },
    { code: 'FSL-TM-BOUR', teamId: teamBoure.id },
  ]});

  // ══════════════════════════════════════════
  //  7. ZÁPASY
  // ══════════════════════════════════════════
  console.log('\n⚽ Vytvářím zápasy...');

  const matchDone1 = await prisma.match.create({ data: {
    homeTeamId: teamOrli.id, awayTeamId: teamOhen.id,
    refereeId: referee.id,
    season: SEASON, division: 'Divize A', round: 1,
    date: daysAgo(15), venue: 'Sportovní hala Praha 6',
    homeScore: 5, awayScore: 3, status: 'DONE', homeFeePaid: true,
  }});
  const matchDone2 = await prisma.match.create({ data: {
    homeTeamId: teamOhen.id, awayTeamId: teamSila.id,
    refereeId: referee.id,
    season: SEASON, division: 'Divize A', round: 2,
    date: daysAgo(8), venue: 'KV Arena Brno',
    homeScore: 2, awayScore: 2, status: 'DONE', homeFeePaid: false,
  }});
  const matchLive = await prisma.match.create({ data: {
    homeTeamId: teamSila.id, awayTeamId: teamBoure.id,
    refereeId: referee.id,
    season: SEASON, division: 'Divize A', round: 3,
    date: new Date(), venue: 'Multifunkční aréna Ostrava',
    homeScore: 1, awayScore: 0, status: 'LIVE',
  }});
  await prisma.match.create({ data: {
    homeTeamId: teamOrli.id, awayTeamId: teamSila.id,
    season: SEASON, division: 'Divize A', round: 4,
    date: daysLater(6), venue: 'Sportovní hala Praha 6',
    status: 'UPCOMING',
  }});
  await prisma.match.create({ data: {
    homeTeamId: teamBoure.id, awayTeamId: teamOhen.id,
    season: SEASON, division: 'Divize A', round: 5,
    date: daysLater(13), venue: 'Zimní stadion Hradec Králové',
    status: 'UPCOMING',
  }});
  await prisma.match.create({ data: {
    homeTeamId: teamSila.id, awayTeamId: teamOrli.id,
    season: SEASON, division: 'Divize A', round: 6,
    date: daysAgo(3),
    status: 'CANCELLED',
  }});

  console.log('  ✓ 2× DONE, 1× LIVE, 2× UPCOMING, 1× CANCELLED');

  // ══════════════════════════════════════════
  //  8. UDÁLOSTI ZÁPASŮ
  // ══════════════════════════════════════════
  console.log('\n🎯 Vytvářím události...');

  // matchDone1: Orli 5:3 Oheň
  await prisma.matchEvent.createMany({ data: [
    { matchId: matchDone1.id, type: 'GOAL',    minute: 4,  period: 1, teamId: teamOrli.id, scorerId: pGM1.id,    assistId: pOrliP1.id },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 11, period: 1, teamId: teamOhen.id, scorerId: pGM2.id },
    { matchId: matchDone1.id, type: 'PENALTY', minute: 14, period: 1, teamId: teamOhen.id, penaltyId: pOhenP2.id, penaltyType: '2min' },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 17, period: 1, teamId: teamOrli.id, scorerId: pOrliP1.id, assistId: pGM1.id },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 23, period: 2, teamId: teamOhen.id, scorerId: pGM2.id,    assistId: pOhenP1.id },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 28, period: 2, teamId: teamOrli.id, scorerId: pGM1.id },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 34, period: 2, teamId: teamOhen.id, scorerId: pOhenP2.id },
    { matchId: matchDone1.id, type: 'PENALTY', minute: 37, period: 2, teamId: teamOrli.id, penaltyId: pOrliP2.id, penaltyType: '2min' },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 42, period: 3, teamId: teamOrli.id, scorerId: pSupervisor.id, assistId: pGM1.id },
    { matchId: matchDone1.id, type: 'GOAL',    minute: 47, period: 3, teamId: teamOrli.id, scorerId: pOrliP1.id },
    { matchId: matchDone1.id, type: 'MATCH_END', minute: 60, period: 3 },
  ]});

  // matchDone2: Oheň 2:2 Síla
  await prisma.matchEvent.createMany({ data: [
    { matchId: matchDone2.id, type: 'GOAL',    minute: 8,  period: 1, teamId: teamOhen.id, scorerId: pGM2.id },
    { matchId: matchDone2.id, type: 'GOAL',    minute: 19, period: 1, teamId: teamSila.id, scorerId: pSilaP1.id },
    { matchId: matchDone2.id, type: 'PENALTY', minute: 25, period: 2, teamId: teamOhen.id, penaltyId: pOhenP1.id, penaltyType: '2min' },
    { matchId: matchDone2.id, type: 'GOAL',    minute: 31, period: 2, teamId: teamOhen.id, scorerId: pOhenP2.id, assistId: pGM2.id },
    { matchId: matchDone2.id, type: 'GOAL',    minute: 55, period: 3, teamId: teamSila.id, scorerId: pSilaP1.id },
    { matchId: matchDone2.id, type: 'MATCH_END', minute: 60, period: 3 },
  ]});

  // Live zápas – jeden gól
  await prisma.matchEvent.create({ data: {
    matchId: matchLive.id, type: 'GOAL', minute: 7, period: 1,
    teamId: teamSila.id, scorerId: pSilaP1.id,
  }});

  console.log('  ✓ 17 gólů + 3 tresty');

  // ══════════════════════════════════════════
  //  9. PLATBY HRÁČŮ
  // ══════════════════════════════════════════
  console.log('\n💰 Vytvářím platby...');

  const platbyHracu = [
    { player: pSupervisor, licStatus: 'PAID',    licPaidAt: daysAgo(20), licMethod: 'bank' },
    { player: pGM1,        licStatus: 'PAID',    licPaidAt: daysAgo(18), licMethod: 'bank' },
    { player: pOrliP1,     licStatus: 'PENDING' },
    { player: pOrliP2,     licStatus: 'OVERDUE' },
    { player: pGM2,        licStatus: 'PAID',    licPaidAt: daysAgo(10), licMethod: 'bank' },
    { player: pOhenP1,     licStatus: 'PENDING' },
    { player: pOhenP2,     licStatus: 'PENDING' },
    { player: pSilaP1,     licStatus: 'WAIVED' },
    { player: pFree1,      licStatus: 'PENDING' },
    { player: pFree2,      licStatus: 'PENDING' },
  ];

  for (let i = 0; i < platbyHracu.length; i++) {
    const { player, licStatus, licPaidAt, licMethod } = platbyHracu[i];
    await prisma.playerPayment.create({ data: {
      playerId: player.id,
      season: SEASON,
      licFee: 250, licStatus,
      licPaidAt: licPaidAt ?? null,
      licMethod: licMethod ?? null,
      superLic: false, superFee: 250, superStatus: 'PENDING',
      variableSymbol: String(100001 + i),
    }});
  }

  // Platby týmů
  await prisma.teamPayment.createMany({ data: [
    { teamId: teamOrli.id,  season: SEASON, amount: 8000, status: 'PAID',    paidAt: daysAgo(25), method: 'bank', variableSymbol: '900001' },
    { teamId: teamOhen.id,  season: SEASON, amount: 8000, status: 'PENDING', variableSymbol: '900002' },
    { teamId: teamSila.id,  season: SEASON, amount: 8000, status: 'OVERDUE', variableSymbol: '900003' },
    { teamId: teamBoure.id, season: SEASON, amount: 8000, status: 'PENDING', variableSymbol: '900004' },
  ]});

  console.log('  ✓ Platby hráčů (PAID/PENDING/OVERDUE/WAIVED) + týmové platby');

  // ══════════════════════════════════════════
  //  10. DRAFT
  // ══════════════════════════════════════════
  console.log('\n📋 Vytvářím draft...');

  const draftProfile1 = await prisma.draftProfile.create({ data: {
    playerId: pFree1.id,
    bio: 'Hraju florbal 8 let, specializace útočník. Hledám tým v divizi A nebo B. Jsem týmový hráč, spolehlivý na trénincích.',
    pubSkill: 'Mám nejlepší backhand v celé lize, garantuji aspoň 15 gólů za sezónu.',
    position: 'Útočník',
    isActive: true,
  }});

  await prisma.draftProfile.create({ data: {
    playerId: pFree2.id,
    bio: 'Zkušený obránce z mládežnické ligy, hledám seniorský tým. Dobré bruslení, čisté hry.',
    pubSkill: 'Žádný útočník mě ještě nepřekonal 1vs1 celou poslední sezónu.',
    position: 'Obránce',
    isActive: true,
  }});

  // Nabídka od Orli pro Radka Dvořáka
  await prisma.draftOffer.create({ data: {
    profileId: draftProfile1.id,
    teamId: teamOrli.id,
    message: 'Ahoj Radku, sledujeme tě delší dobu. Rádi bychom tě viděli na tréninku.',
    status: 'PENDING', isFirst: true,
    expiresAt: daysLater(2),
  }});

  console.log('  ✓ 2 draft profily, 1 nabídka od Orlů (vyprší za 2 dny)');

  // ══════════════════════════════════════════
  //  11. HIGHLIGHTS
  // ══════════════════════════════════════════
  await prisma.roundHighlight.createMany({ data: [
    {
      round: 1, pinned: true,
      title: 'Orli rozstříleli Oheň 5:3!',
      body: 'Dramatický zápas prvního kola skončil vítězstvím domácích. Karel Svoboda zaznamenal hattrick.',
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    {
      round: 2, pinned: false,
      title: 'Remíza v Brně: Oheň vs Síla 2:2',
      body: 'Vyrovnaný souboj druhého kola. Síla srovnala ve třetí třetině.',
    },
    {
      round: null, pinned: false,
      title: 'Nová sezóna 2025/26 startuje!',
      body: 'Vítejte v nové sezóně FSL Ligy. Přihlaste své týmy a těšte se na vzrušující florbal.',
    },
  ]});

  // ══════════════════════════════════════════
  //  12. NOTIFIKACE
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
  console.log('✅ SEED HOTOVÝ');
  console.log('═'.repeat(60));

  console.log(`
📦 DATA:
  4 týmy | 10 hráčů | 2 GM | 2 rozhodčí
  6 zápasů (2 DONE s góly, 1 LIVE, 2 UPCOMING, 1 CANCELLED)
  Platby: PAID/PENDING/OVERDUE/WAIVED varianty
  Draft: 2 profily + 1 nabídka
  3 highlights | Kódy: FSL-TM-ORLI / OHEN / SILA / BOUR

🔑 SEED USER IDs:
`);

  const seedInfo = [
    { id: uSupervisor.id, popis: 'SUPERVISOR + Brankář Pražských Orlů (Tomáš Novák #1)' },
    { id: uGM1.id,        popis: 'GM Pražských Orlů + Útočník (Karel Svoboda #10)' },
    { id: uGM2.id,        popis: 'GM Brněnského Ohně + Útočník (Michal Krejčí #9)' },
    { id: uSilaP1.id,     popis: 'Hráč S TÝMEM – Ostravská Síla (Jakub Mašek #3)' },
    { id: uFreeAgent1.id, popis: 'Hráč BEZ TÝMU + draft profil + nabídka od Orlů (Radek Dvořák)' },
    { id: uFreeAgent2.id, popis: 'Hráč BEZ TÝMU + draft profil (Patrik Šimánek)' },
    { id: uReferee.id,    popis: 'Rozhodčí APPROVED (Martin Kolář)' },
    { id: uRefPending.id, popis: 'Rozhodčí PENDING (Petr Blaha)' },
  ];

  for (const u of seedInfo) {
    console.log(`  ${u.id}`);
    console.log(`  → ${u.popis}\n`);
  }

  console.log(`📌 DALŠÍ KROKY:
  1. Přihlaš se v appce přes Google
  2. node scripts/link-account.js  →  přiřaď svůj Google účet k roli
`);
}

main()
  .catch(err => { console.error('\n❌ CHYBA:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
