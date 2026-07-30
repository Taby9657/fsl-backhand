/**
 * FSL – PŘIŘAZENÍ ROLE K GOOGLE ÚČTU
 *
 * Po přihlášení přes Google v appce spusť tento script.
 * Zadej svůj User ID (z DB) a roli, kterou chceš testovat.
 * Script přesune seed data na tvůj reálný účet.
 *
 * Spusť: node scripts/link-account.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const ROLES = [
  { key: '1', label: 'SUPERVISOR + hráč (Tomáš Novák, Pražští Orli)',    email: 'seed-supervisor@fsl.test' },
  { key: '2', label: 'GM Pražských Orlů + hráč (Karel Svoboda #10)',      email: 'seed-gm1@fsl.test' },
  { key: '3', label: 'GM Brněnského Ohně (Michal Krejčí #9)',             email: 'seed-gm2@fsl.test' },
  { key: '4', label: 'Hráč S TÝMEM – Ostravská Síla (Jakub Mašek #3)',   email: 'seed-p5@fsl.test' },
  { key: '5', label: 'Hráč BEZ TÝMU + draft profil (Radek Dvořák)',      email: 'seed-free1@fsl.test' },
  { key: '6', label: 'Hráč BEZ TÝMU + draft profil (Patrik Šimánek)',    email: 'seed-free2@fsl.test' },
  { key: '7', label: 'Rozhodčí APPROVED (Martin Kolář)',                  email: 'seed-referee@fsl.test' },
  { key: '8', label: 'Rozhodčí PENDING (Petr Blaha)',                     email: 'seed-refpending@fsl.test' },
];

async function main() {
  console.log('\n🔗 FSL – PŘIŘAZENÍ ROLE K GOOGLE ÚČTU');
  console.log('════════════════════════════════════════\n');

  // Zobraz posledních 10 přihlášených uživatelů
  const recentUsers = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { player: true, manager: { include: { team: true } }, referee: true },
  });

  console.log('Poslední uživatelé v DB:');
  for (const u of recentUsers) {
    const roleInfo = [
      u.player ? `hráč (${u.player.firstName} ${u.player.lastName})` : null,
      u.manager?.length ? `GM (${u.manager[0].team?.name})` : null,
      u.referee ? `rozhodčí` : null,
      u.player?.isSupervisor ? '⭐ SUPERVISOR' : null,
    ].filter(Boolean).join(', ');
    const isSeed = u.email.endsWith('@fsl.test') ? ' [SEED]' : '';
    console.log(`  [${u.createdAt.toISOString().slice(0, 19)}] ${u.id}${isSeed}`);
    console.log(`    email: ${u.email}  |  role: ${roleInfo || 'žádná'}\n`);
  }

  const myUserId = (await ask('Zadej svůj User ID (tvůj Google účet): ')).trim();
  if (!myUserId) { console.log('❌ Zrušeno.'); process.exit(0); }

  const myUser = await prisma.user.findUnique({
    where: { id: myUserId },
    include: { player: true, manager: true, referee: true },
  });

  if (!myUser) { console.log('❌ User nenalezen.'); process.exit(1); }
  if (myUser.email.endsWith('@fsl.test')) {
    console.log('⚠️  Tohle je seed účet – zadej svůj reálný Google účet!');
    process.exit(1);
  }

  console.log(`\n✓ Nalezen: ${myUser.email}`);

  console.log('\nDostupné role:');
  for (const r of ROLES) console.log(`  ${r.key}. ${r.label}`);

  const choice = (await ask('\nVyber číslo role (nebo Enter pro zrušení): ')).trim();
  const role = ROLES.find(r => r.key === choice);
  if (!role) { console.log('❌ Zrušeno.'); process.exit(0); }

  // Najdi seed uživatele pro vybranou roli
  const seedUser = await prisma.user.findUnique({
    where: { email: role.email },
    include: { player: true, manager: { include: { team: true } }, referee: true },
  });

  if (!seedUser) {
    console.log(`\n❌ Seed user "${role.email}" nenalezen. Spusť nejdřív seed-test.js`);
    process.exit(1);
  }

  console.log(`\n🔄 Přesunuji roli "${role.label}" na tvůj účet...\n`);

  // Přesun playera
  if (seedUser.player) {
    if (myUser.player) {
      // Smaž starý player záznam (pokud existuje z onboardingu bez role)
      await prisma.player.delete({ where: { id: myUser.player.id } });
    }
    await prisma.player.update({
      where: { id: seedUser.player.id },
      data: { userId: myUserId },
    });
    console.log(`  ✓ Player přesunut: ${seedUser.player.firstName} ${seedUser.player.lastName}`);
  }

  // Přesun manager záznamu
  for (const mgr of (seedUser.manager ?? [])) {
    // Zkontroluj, zda neexistuje duplicita
    const existing = await prisma.manager.findUnique({
      where: { userId_teamId: { userId: myUserId, teamId: mgr.teamId } },
    });
    if (!existing) {
      await prisma.manager.update({ where: { id: mgr.id }, data: { userId: myUserId } });
    } else {
      await prisma.manager.delete({ where: { id: mgr.id } });
    }
    console.log(`  ✓ Manager role přesunuta: ${mgr.team?.name ?? mgr.teamId}`);
  }

  // Přesun rozhodčího
  if (seedUser.referee) {
    if (myUser.referee) {
      await prisma.referee.delete({ where: { id: myUser.referee.id } });
    }
    await prisma.referee.update({ where: { id: seedUser.referee.id }, data: { userId: myUserId } });
    console.log(`  ✓ Referee přesunut: ${seedUser.referee.firstName} ${seedUser.referee.lastName} (${seedUser.referee.status})`);
  }

  // Smaž prázdný seed user (pokud má jen e-mail bez dalších dat)
  try {
    await prisma.user.delete({ where: { id: seedUser.id } });
    console.log(`  ✓ Seed placeholder user smazán`);
  } catch {
    console.log(`  ⚠ Seed user nesmazán (pravděpodobně má jiné závislosti)`);
  }

  console.log(`
✅ HOTOVO!

Role "${role.label}" je nyní přiřazena tvému účtu.
Restartuj appku nebo proveď pull-to-refresh – role se projeví okamžitě.

⚠️  Pro testování jiné role: opakuj příkaz a vyber jinou roli.
    Pozor: aktuální role bude přepsána!
`);

  rl.close();
}

main()
  .catch(err => { console.error('\n❌ Chyba:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
