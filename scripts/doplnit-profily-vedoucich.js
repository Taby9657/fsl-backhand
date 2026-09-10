#!/usr/bin/env node
/**
 * Doplnění hráčských profilů vedoucím, kteří tým založili dřív, než profil
 * začal vznikat automaticky.
 *
 * Bez profilu vedoucí nemůže zaplatit balíček startů ani licenci — obojí visí
 * na hráči, ne na týmu, a `POST /payments/pack` mu vrátí „Hráčský profil
 * nenalezen". Registraci týmu zaplatí, a pak už nikam.
 *
 * Ve výchozím stavu **nic nemění** a jen vypíše, koho by doplnil. Skutečný
 * zápis spustí až `--zapsat`.
 *
 *   node scripts/doplnit-profily-vedoucich.js            # jen výpis
 *   node scripts/doplnit-profily-vedoucich.js --zapsat   # doopravdy založí
 *
 * Jméno se bere z e-mailu (`j.tabasek96@…` → „J Tabasek"). Není to hezké,
 * ale je to k poznání a vedoucí si ho v profilu přepíše. Číslo dresu dostane
 * nejnižší volné v týmu. Nikdo, kdo profil má, se nepřepisuje.
 */

require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('\nChybí DATABASE_URL — skript neví, ke které databázi se připojit.\n');
  process.exit(1);
}

const prisma = require('../src/lib/prisma');
const hracskyProfil = require('../src/services/hracskyProfil');
const licence = require('../src/services/licence');
const seasonSvc = require('../src/services/seasonTransition');

const ZAPSAT = process.argv.includes('--zapsat');

async function main() {
  const managers = await prisma.manager.findMany({
    include: {
      user: { select: { id: true, email: true, player: { select: { id: true, teamId: true } } } },
      team: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const chybi = managers.filter(m => !m.user.player);
  const bezTymu = managers.filter(m => m.user.player && !m.user.player.teamId);

  console.log(`\nVedoucích celkem: ${managers.length}`);
  console.log(`Bez hráčského profilu: ${chybi.length}`);
  console.log(`S profilem, ale bez týmu: ${bezTymu.length}\n`);

  const kOprave = [...chybi, ...bezTymu];
  if (kOprave.length === 0) {
    console.log('Není co doplňovat.\n');
    return;
  }

  for (const m of kOprave) {
    console.log(`  ${m.user.email}  →  ${m.team.name}${m.user.player ? '  (jen připojit k týmu)' : ''}`);
  }

  if (!ZAPSAT) {
    console.log('\nZkušební běh — nic se nezapsalo. Spusť znovu s --zapsat.\n');
    return;
  }

  const aktualni = await seasonSvc.currentSeason();
  let hotovo = 0;

  for (const m of kOprave) {
    // Sezóna se bere z přihlášky týmu, ne z té, kterou zrovna ukazuje liga —
    // stejně jako u běžného hráče v `POST /players`.
    const sezona = await licence.sezonaTymu(m.teamId, aktualni);
    try {
      const vysledek = await prisma.$transaction(tx => hracskyProfil.zalozProfilVedouciho(tx, {
        userId:   m.userId,
        email:    m.user.email,
        teamId:   m.teamId,
        teamName: m.team.name,
        season:   sezona,
      }));

      if (!vysledek.player) {
        console.error(`  ✗ ${m.user.email}: ${vysledek.duvod}`);
        continue;
      }

      if (sezona) {
        await licence.pridatDoSoupisky(vysledek.player.id, m.teamId, sezona, { isHome: true });
      }
      hotovo++;
      console.log(`  ✓ ${m.user.email}: ${vysledek.player.firstName} ${vysledek.player.lastName}, dres ${vysledek.player.jersey} (${vysledek.duvod})`);
    } catch (err) {
      console.error(`  ✗ ${m.user.email}: ${err.message}`);
    }
  }

  console.log(`\nDoplněno ${hotovo} z ${kOprave.length}.\n`);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
