'use strict';
// Spusť ПІСЛЯ přihlášení do apky Apple ID.
// Najde nejnovějšího uživatele bez hráčského profilu a propojí ho se supervisorem.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Najdi nejnovějšího uživatele (Apple login ho právě vytvořil)
  const users = await prisma.user.findMany({
    where: { player: null },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, email: true, createdAt: true, appleId: true },
  });

  if (!users.length) {
    console.log('Žádný uživatel bez hráčského profilu nenalezen.');
    return;
  }

  console.log('Nalezení uživatelé bez hráčského profilu:');
  users.forEach((u, i) => console.log(`  [${i}] ${u.email ?? '(no email)'} | Apple: ${u.appleId ?? 'none'} | ${u.createdAt.toISOString()}`));

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
