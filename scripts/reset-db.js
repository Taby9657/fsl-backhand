/**
 * FSL – RESET DATABÁZE
 * Smaže veškerá data ve správném pořadí (cizí klíče).
 * Spusť: node scripts/reset-db.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  console.log('\n⚠️  FSL RESET DATABÁZE');
  console.log('════════════════════════════════════════');
  console.log('Tato operace NEVRATNĚ smaže všechna data!');
  console.log(`DB: ${process.env.DATABASE_URL?.split('@')[1] ?? 'unknown'}\n`);

  const answer = await confirm('Opravdu chceš smazat vše? Napiš "ano" pro potvrzení: ');
  if (answer !== 'ano') {
    console.log('❌ Reset zrušen.');
    process.exit(0);
  }

  console.log('\n🗑  Mažu data...');

  // Pořadí musí respektovat cizí klíče (mazáme závislé tabulky jako první)
  const steps = [
    ['DraftOffer',         () => prisma.draftOffer.deleteMany()],
    ['DraftVideo',         () => prisma.draftVideo.deleteMany()],
    ['DraftProfile',       () => prisma.draftProfile.deleteMany()],
    ['LineupPlayer',       () => prisma.lineupPlayer.deleteMany()],
    ['LineupSubmission',   () => prisma.lineupSubmission.deleteMany()],
    ['RefRating',          () => prisma.refRating.deleteMany()],
    ['PostmatchData',      () => prisma.postmatchData.deleteMany()],
    ['MatchEvent',         () => prisma.matchEvent.deleteMany()],
    ['Match',              () => prisma.match.deleteMany()],
    ['PlayerPayment',      () => prisma.playerPayment.deleteMany()],
    ['TeamPayment',        () => prisma.teamPayment.deleteMany()],
    ['BankTransaction',    () => prisma.bankTransaction.deleteMany()],
    ['InviteCode',         () => prisma.inviteCode.deleteMany()],
    ['Notification',       () => prisma.notification.deleteMany()],
    ['SupervisorRequest',  () => prisma.supervisorRequest.deleteMany()],
    ['Manager',            () => prisma.manager.deleteMany()],
    ['Player',             () => prisma.player.deleteMany()],
    ['Referee',            () => prisma.referee.deleteMany()],
    ['User',               () => prisma.user.deleteMany()],
    ['RoundHighlight',     () => prisma.roundHighlight.deleteMany()],
    ['Team',               () => prisma.team.deleteMany()],
  ];

  for (const [name, fn] of steps) {
    const result = await fn();
    console.log(`  ✓ ${name.padEnd(18)} smazáno: ${result.count ?? '?'} záznamů`);
  }

  console.log('\n✅ Databáze je prázdná.\n');
}

main()
  .catch(err => { console.error('❌ Chyba:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
