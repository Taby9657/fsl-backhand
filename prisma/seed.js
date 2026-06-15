const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding FSL database...');

  // ==================== TÝMY ====================
  const benatky = await prisma.team.upsert({
    where:  { id: 'team-be' },
    update: {},
    create: {
      id:       'team-be',
      name:     'Benavidez Eagles',
      abbr:     'BE',
      color:    '#C9A140',
      division: 'Divize A',
      payments: { create: { amount: 10000 } },
    },
  });

  const lynx = await prisma.team.upsert({
    where:  { id: 'team-lx' },
    update: {},
    create: {
      id:       'team-lx',
      name:     'Lynx Praha',
      abbr:     'LX',
      color:    '#8B5CF6',
      division: 'Divize A',
      payments: { create: { amount: 10000 } },
    },
  });

  const pr = await prisma.team.upsert({
    where:  { id: 'team-pr' },
    update: {},
    create: {
      id:       'team-pr',
      name:     'Pražská Rebelka',
      abbr:     'PR',
      color:    '#EF4444',
      division: 'Divize A',
      payments: { create: { amount: 10000 } },
    },
  });

  // ==================== UŽIVATELÉ ====================
  const userTN = await prisma.user.upsert({
    where:  { email: 'tomas.novak@fsl.cz' },
    update: {},
    create: { id: 'user-tn', email: 'tomas.novak@fsl.cz' },
  });

  const userMV = await prisma.user.upsert({
    where:  { email: 'martin.vesely@fsl.cz' },
    update: {},
    create: { id: 'user-mv', email: 'martin.vesely@fsl.cz' },
  });

  const userSV = await prisma.user.upsert({
    where:  { email: 'supervisor@fsl.cz' },
    update: {},
    create: { id: 'user-sv', email: 'supervisor@fsl.cz' },
  });

  // ==================== HRÁČI ====================
  await prisma.player.upsert({
    where:  { userId: userTN.id },
    update: {},
    create: {
      id:         'player-tn',
      userId:     userTN.id,
      teamId:     benatky.id,
      firstName:  'Tomáš',
      lastName:   'Novák',
      jersey:     10,
      position:   'Útočník',
      licensed:   true,
      isSupervisor: false,
      payment: { create: { licStatus: 'PAID', licPaidAt: new Date() } },
    },
  });

  await prisma.player.upsert({
    where:  { userId: userMV.id },
    update: {},
    create: {
      id:         'player-mv',
      userId:     userMV.id,
      teamId:     benatky.id,
      firstName:  'Martin',
      lastName:   'Veselý',
      jersey:     8,
      position:   'Obránce',
      licensed:   true,
      isSupervisor: true, // Supervisor
      payment: { create: { licStatus: 'PAID', licPaidAt: new Date() } },
    },
  });

  // ==================== VEDOUCÍ ====================
  await prisma.manager.upsert({
    where:  { userId_teamId: { userId: userMV.id, teamId: benatky.id } },
    update: {},
    create: { userId: userMV.id, teamId: benatky.id },
  });

  // ==================== ROZHODČÍ ====================
  const userRef = await prisma.user.upsert({
    where:  { email: 'jan.prochazka@fsl.cz' },
    update: {},
    create: { id: 'user-ref1', email: 'jan.prochazka@fsl.cz' },
  });

  await prisma.referee.upsert({
    where:  { userId: userRef.id },
    update: {},
    create: {
      id:        'ref-jp',
      userId:    userRef.id,
      firstName: 'Jan',
      lastName:  'Procházka',
      phone:     '+420 601 234 567',
      level:     'A',
      status:    'APPROVED',
    },
  });

  // ==================== POZVÁNKOVÉ KÓDY ====================
  await prisma.inviteCode.upsert({
    where:  { code: 'FSL-BE-DEMO' },
    update: {},
    create: { code: 'FSL-BE-DEMO', teamId: benatky.id },
  });

  // ==================== ZÁPAS ====================
  const now = new Date();
  const matchDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // za týden
  await prisma.match.upsert({
    where:  { id: 'match-1' },
    update: {},
    create: {
      id:         'match-1',
      homeTeamId: benatky.id,
      awayTeamId: lynx.id,
      refereeId:  'ref-jp',
      date:       matchDate,
      venue:      'FSL Hala Praha 5',
      division:   'Divize A',
      round:      1,
      status:     'UPCOMING',
    },
  });

  console.log('✅ Seed dokončen!');
  console.log('  Týmy:    BE, LX, PR');
  console.log('  Hráči:   Tomáš Novák (BE), Martin Veselý (BE, supervisor)');
  console.log('  Kód:     FSL-BE-DEMO');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
