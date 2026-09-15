#!/usr/bin/env node
/**
 * Nastaví existujícímu účtu příznak supervisora (`User.isSupervisor`).
 *
 *   node scripts/udelat-supervisora.js                      # jen vypíše účty
 *   node scripts/udelat-supervisora.js --email=ja@email.cz  # nastaví
 *
 * K čemu to je: po `vymazat-vse.js --bez-uctu` nezůstane v databázi žádný
 * účet a v aplikaci není nikdo, kdo by supervisora nastavil — z webu se
 * dají založit jen hráči, vedoucí a rozhodčí. Cesta zpátky vede přes
 * registraci na webu a tenhle skript.
 *
 * Účet se tímhle nezakládá. Musí existovat, jinak skript vypíše, co v
 * databázi je, a skončí.
 */

require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error(`
Chybí DATABASE_URL — skript neví, ke které databázi se připojit.

V Railway otevři službu Postgres → Variables a vezmi **DATABASE_PUBLIC_URL**
(ta vnitřní, která končí .railway.internal, z notebooku nefunguje).
`);
  process.exit(1);
}

const prisma = require('../src/lib/prisma');

const arg   = process.argv.find((a) => a.startsWith('--email='));
const EMAIL = arg ? arg.slice('--email='.length).trim().toLowerCase() : null;

const zpusobPrihlaseni = (u) => [
  u.passwordHash && 'heslo',
  u.googleId && 'Google',
  u.appleId && 'Apple',
].filter(Boolean).join(' + ') || 'žádný (!)';

async function main() {
  const ucty = await prisma.user.findMany({
    select: { id: true, email: true, isSupervisor: true, passwordHash: true, googleId: true, appleId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (ucty.length === 0) {
    console.error('\n⛔ V databázi není žádný účet.\n');
    console.error('   Zaregistruj se nejdřív na webu (fslleague.cz), pak spusť tenhle skript znovu.\n');
    process.exit(1);
  }

  if (!EMAIL) {
    console.log(`\nÚčty v databázi (${ucty.length}):\n`);
    ucty.forEach((u) => console.log(`  ${u.isSupervisor ? '★' : ' '} ${u.email.padEnd(34)} ${zpusobPrihlaseni(u)}`));
    console.log('\n★ = supervisor');
    console.log('\nNastavíš ho příkazem:  npm run supervisor -- --email=ja@email.cz\n');
    return;
  }

  const ucet = ucty.find((u) => u.email.toLowerCase() === EMAIL);

  if (!ucet) {
    console.error(`\n⛔ Účet ${EMAIL} v databázi není — nic se nezměnilo.\n`);
    console.error('   Účty, které v databázi jsou:');
    ucty.forEach((u) => console.error(`     ${u.isSupervisor ? '★' : ' '} ${u.email}`));
    console.error('');
    process.exit(1);
  }

  if (zpusobPrihlaseni(ucet) === 'žádný (!)') {
    console.error(`\n⛔ Účet ${ucet.email} nemá ani heslo, ani Google/Apple — nepřihlásíš se k němu.`);
    console.error('   Nic se nezměnilo. Nastav si u něj nejdřív heslo (obnova hesla).\n');
    process.exit(1);
  }

  if (ucet.isSupervisor) {
    console.log(`\n${ucet.email} supervisorem už je — nic se nemění.\n`);
    return;
  }

  await prisma.user.update({ where: { id: ucet.id }, data: { isSupervisor: true } });

  const po = await prisma.user.findUnique({ where: { id: ucet.id }, select: { email: true, isSupervisor: true } });

  if (!po?.isSupervisor) {
    console.error('\n⛔ Zápis neprošel — účet supervisorem není. Zkus to znovu.\n');
    process.exit(1);
  }

  console.log(`\n✓ ${po.email} je supervisor.`);
  console.log('  Odhlas se a přihlas znovu — token se vydává při přihlášení.\n');
}

main()
  .catch((err) => { console.error('\nChyba:', err.message, '\n'); process.exit(1); })
  .finally(() => prisma.$disconnect());
