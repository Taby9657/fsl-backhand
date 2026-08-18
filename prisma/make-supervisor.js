'use strict';
// Spusť ПІСЛЯ přihlášení do apky Apple ID.
// Najde nejnovějšího uživatele bez hráčského profilu a propojí ho se supervisorem.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Preferuj uživatele s Apple ID (skutečný přihlášený uživatel)
  const appleUsers = await prisma.user.findMany({
    where: { player: null, appleId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, email: true, createdAt: true, appleId: true },
  });

  const allUsers = await prisma.user.findMany({
    where: { player: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, email: true, createdAt: true, appleId: true },
  });

  const users = appleUsers.length ? appleUsers : allUsers;

  if (!users.length) {
    console.log('Žádný uživatel bez hráčského profilu nenalezen.');
    console.log('→ Přihlas se nejdřív do apky pomocí Apple ID, pak spusť znovu.');
    return;
  }

  if (!appleUsers.length) {
    console.log('⚠️  Žádný uživatel s Apple ID nenalezen – přihlásil ses do apky?');
    console.log('   Pokud ne, přihlas se nejdřív a pak spusť znovu.\n');
  }

  console.log(appleUsers.length ? '✅ Uživatelé s Apple ID:' : '⚠️  Uživatelé BEZ Apple ID (možná špatní):');
  users.forEach((u, i) => console.log(`  [${i}] ${u.email ?? '(no email)'} | Apple: ${u.appleId ? u.appleId.slice(0, 12) + '...' : 'CHYBÍ'} | ${u.createdAt.toISOString()}`));

  const target = users[0];
  console.log(`\nNastavuji supervisora pro: ${target.email ?? target.id}`);

  // Najdi první tým (PRH) a přidej tam hráče-supervisora
  const team = await prisma.team.findFirst({ where: { abbr: 'PRH' } });
  if (!team) { console.error('Tým PRH nenalezen'); return; }

  const player = await prisma.player.create({
    data: {
      userId:      target.id,
      teamId:      team.id,
      firstName:   'Jakub',
      lastName:    'Tabášek',
      jersey:      99,
      position:    'Útočník',
      licensed:    true,
      isSupervisor: true,
      payment: { create: { season: '2025/26', licStatus: 'PAID', licMethod: 'manual', licPaidAt: new Date() } },
    },
  });

  console.log(`✅ Hotovo! Hráč #99 Jakub Tabášek na PRH, isSupervisor=true`);
  console.log(`   User ID: ${target.id}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
