#!/usr/bin/env node
/**
 * Úplné vymazání databáze — zůstane jediný účet: supervisor.
 *
 * ⚠️ MAŽE PRODUKČNÍ DATA. Nedá se vrátit zpět.
 *
 * Rozdíl proti `reset-data.js`: ten schválně nechává všechny uživatelské
 * účty, rozhodčí a hráčské profily. Tenhle skript nechává **jeden jediný
 * účet** (a nastavení ligy) a všechno ostatní maže — včetně rozhodčích,
 * hráčských profilů a vedoucích u toho zbývajícího účtu.
 *
 *   node scripts/vymazat-vse.js                       # jen výpis, nic se nemaže
 *   node scripts/vymazat-vse.js --smazat              # doopravdy smaže
 *   node scripts/vymazat-vse.js --smazat --nechat-aktuality
 *   node scripts/vymazat-vse.js --smazat --email=jiny@ucet.cz
 *
 * ── Co zůstane ──────────────────────────────────────────────────────────
 *   User      jediný řádek — účet UCHOVAT_EMAIL, nastavený jako supervisor
 *   Settings  nastavení ligy včetně aktuální sezóny (singleton)
 *
 * S `--nechat-aktuality` zůstanou i články v Aktualitách (`RoundHighlight`).
 * Nejsou to soutěžní data, ale texty, které někdo psal — a mazací skript je
 * jinak spolkne spolu s hráči a platbami.
 *
 * ── Co jde pryč ─────────────────────────────────────────────────────────
 *   všechny ostatní tabulky ze schématu, tedy i rozhodčí, hráčský profil
 *   a vedoucí u zbývajícího účtu, a všechny ostatní účty.
 *
 * ── Pojistky ────────────────────────────────────────────────────────────
 * 1. Když účet se zadaným e-mailem v databázi není, skript **nic nesmaže**
 *    a vypíše existující účty. Bez téhle kontroly by šlo vymazat ligu
 *    a zůstat bez přihlášení.
 * 2. Skript porovná schéma s vygenerovaným Prisma Clientem. Když je
 *    v `schema.prisma` model, který skript nezná nebo ho klient nemá,
 *    **skončí chybou** místo toho, aby tabulku tiše přeskočil. Přesně tohle
 *    se stalo 9. 9. 2026 — půlka tabulek se málem přeskočila.
 *    **Před spuštěním pusť `npx prisma generate`.**
 * 3. Po smazání proběhne kontrolní přepočet všech tabulek.
 *
 * ── Co se tím NEVRÁTÍ ───────────────────────────────────────────────────
 * Smazáním záznamu o platbě se nikomu nevrací peníze. Co je zaplacené přes
 * Stripe, zůstává zaplacené — a v účetnictví taky. Refundace se řeší
 * ve Stripu, ne tady.
 */

// `src/lib/prisma` si .env sám nenačítá — dělá to jen server.js.
require('dotenv').config();

const fs   = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error(`
Chybí DATABASE_URL — skript neví, ke které databázi se připojit.

V Railway otevři službu Postgres → Variables a vezmi **DATABASE_PUBLIC_URL**
(ta vnitřní, která končí .railway.internal, z notebooku nefunguje).

  DATABASE_URL="postgresql://postgres:...@neco.proxy.rlwy.net:PORT/railway" npm run reset:vse
`);
  process.exit(1);
}

const prisma = require('../src/lib/prisma');

const SMAZAT = process.argv.includes('--smazat');
const NECHAT_AKTUALITY = process.argv.includes('--nechat-aktuality');
const arg    = process.argv.find((a) => a.startsWith('--email='));
const EMAIL  = (arg ? arg.slice('--email='.length) : 'j.tabasek96@seznam.cz').trim().toLowerCase();

/** Tabulky, které zůstávají. Všechno ostatní ze schématu jde pryč. */
const ZUSTAVA = ['User', 'Settings'];

/**
 * Pořadí je od závislých tabulek k nadřazeným. Kdyby přesto někde zůstal
 * cizí klíč, skript to nevzdá — selhané tabulky zkusí v dalším průchodu
 * (viz `smazatVse`), takže chyba v pořadí nic nerozbije.
 */
const TABULKY = [
  ['matchEvent',        'události v zápasech'],
  ['lineupPlayer',      'hráči v sestavách'],
  ['lineupSubmission',  'odeslané sestavy'],
  ['postmatchData',     'pozápasové zprávy'],
  ['refRating',         'hodnocení rozhodčích'],
  ['matchEntry',        'starty (rezervace a odpočty)'],
  ['fine',              'pokuty za kontumaci'],
  ['match',             'zápasy'],

  ['referralUse',       'uplatněná doporučení'],
  ['referralCode',      'doporučovací kódy'],
  ['matchPack',         'balíčky zápasů'],

  ['playoffChoice',     'volby týmů pro playoff'],
  ['teamRoster',        'soupisky'],
  ['teamSeason',        'přihlášky týmů do sezón'],

  ['draftOffer',        'draftové nabídky'],
  ['draftVideo',        'draftová videa'],
  ['draftProfile',      'draftové profily'],

  ['cartItem',          'položky v košících'],
  ['cart',              'košíky'],
  ['playerPayment',     'platby hráčů'],
  ['teamPayment',       'platby týmů'],
  ['bankTransaction',   'zpracované bankovní pohyby'],

  ['inviteCode',        'pozvánkové kódy'],
  ['player',            'hráči'],
  ['manager',           'vedoucí týmů'],
  ['referee',           'rozhodčí'],
  ['team',              'týmy'],

  ['division',          'divize'],
  ['conference',        'konference'],
  ['league',            'ligy'],

  ['roundHighlight',    'zprávy z kol'],
  ['notification',      'oznámení'],
  ['supervisorRequest', 'žádosti na supervisora'],
  ['seasonTransition',  'naplánované přechody sezóny'],
  ['passwordReset',     'kódy pro obnovu hesla'],
];

/** `Match` → `match`, jak se model jmenuje na Prisma Clientu. */
const klic = (model) => model[0].toLowerCase() + model.slice(1);

/**
 * Schéma vs. skript vs. vygenerovaný klient. Cokoli z toho rozejde a mazání
 * by bylo tiše nekompletní — proto se tady končí chybou, ne varováním.
 */
function zkontrolovatSchema() {
  const soubor = path.join(__dirname, '..', 'prisma', 'schema.prisma');
  const modely = [...fs.readFileSync(soubor, 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

  const zname    = new Set([...TABULKY.map(([m]) => m), ...ZUSTAVA.map(klic)]);
  const chybiVeSkriptu = modely.filter((m) => !zname.has(klic(m)));
  const chybiVKlientu  = [...TABULKY.map(([m]) => m), ...ZUSTAVA.map(klic)].filter((m) => !prisma[m]);
  const nejsouVeSchematu = [...zname].filter((m) => !modely.some((x) => klic(x) === m));

  const chyby = [];
  if (chybiVeSkriptu.length) {
    chyby.push(`Ve schématu jsou modely, které skript nezná: ${chybiVeSkriptu.join(', ')}.\n` +
               `  → Doplň je do seznamu TABULKY (nebo do ZUSTAVA, pokud mají zůstat).`);
  }
  if (chybiVKlientu.length) {
    chyby.push(`Vygenerovaný Prisma Client nemá modely: ${chybiVKlientu.join(', ')}.\n` +
               `  → Je starší než schéma. Spusť 'npx prisma generate' a zkus to znovu.`);
  }
  if (nejsouVeSchematu.length) {
    chyby.push(`Skript zná modely, které ve schématu nejsou: ${nejsouVeSchematu.join(', ')}.\n` +
               `  → Asi byly odstraněné migrací; vyhoď je ze seznamu.`);
  }

  if (chyby.length) {
    console.error('\n⛔ Schéma a skript si neodpovídají — nic se nemazalo.\n');
    chyby.forEach((c) => console.error('  ' + c + '\n'));
    process.exit(1);
  }

  console.log(`Schéma zkontrolováno: ${modely.length} modelů, ${TABULKY.length} ke smazání, ` +
              `${ZUSTAVA.length} zůstává (${ZUSTAVA.join(', ')}).`);
}

/** Co se v tomhle běhu opravdu maže. */
function kSmazani() {
  return NECHAT_AKTUALITY
    ? TABULKY.filter(([model]) => model !== 'roundHighlight')
    : TABULKY;
}

async function smazatVse() {
  let zbyva = kSmazani();

  for (let pruchod = 1; zbyva.length > 0; pruchod++) {
    if (pruchod > 5) throw new Error('Tabulky se nedaří smazat ani po pěti průchodech.');
    if (pruchod > 1) console.log(`\n  … druhý pokus u tabulek, které držel cizí klíč (průchod ${pruchod})`);

    const selhalo = [];
    for (const polozka of zbyva) {
      const [model, popis] = polozka;
      try {
        const { count } = await prisma[model].deleteMany({});
        if (count > 0) console.log(`  ✓  ${popis.padEnd(34)} smazáno ${count}`);
      } catch (err) {
        selhalo.push({ polozka, err });
      }
    }

    if (selhalo.length === zbyva.length && selhalo.length > 0) {
      console.error('\nŽádná z těchto tabulek nešla smazat:');
      selhalo.forEach(({ polozka, err }) => console.error(`  ${polozka[0]}: ${err.message.split('\n')[0]}`));
      throw new Error('Mazání se zaseklo — databáze je v rozdělaném stavu, projdi hlášky výš.');
    }
    zbyva = selhalo.map((s) => s.polozka);
  }
}

async function main() {
  console.log(SMAZAT
    ? '\n⚠️  MAZÁNÍ VŠECH DAT — tohle se nedá vrátit zpět.\n'
    : '\nJEN VÝPIS — nic se nemaže. Skutečné mazání spustí `--smazat`.\n');

  zkontrolovatSchema();

  // ── Pojistka: účet, který má zůstat, musí existovat ──
  const ucty = await prisma.user.findMany({
    select: { id: true, email: true, isSupervisor: true, passwordHash: true, googleId: true, appleId: true },
    orderBy: { createdAt: 'asc' },
  });
  const uchovat = ucty.find((u) => u.email.toLowerCase() === EMAIL);

  if (!uchovat) {
    console.error(`\n⛔ Účet ${EMAIL} v databázi není — nic se nemazalo.\n`);
    console.error('   Kdyby skript pokračoval, zůstala by prázdná liga bez přihlášení.');
    console.error('\n   Účty, které v databázi jsou:');
    ucty.forEach((u) => console.error(`     ${u.isSupervisor ? '★' : ' '} ${u.email}`));
    console.error('\n   Spusť skript s `--email=...` a jedním z nich.\n');
    process.exit(1);
  }

  const zpusobPrihlaseni = [
    uchovat.passwordHash && 'heslo',
    uchovat.googleId && 'Google',
    uchovat.appleId && 'Apple',
  ].filter(Boolean).join(' + ') || 'žádný (!)';

  console.log(`\nZůstane účet: ${uchovat.email}`);
  console.log(`  supervisor:  ${uchovat.isSupervisor ? 'ano' : 'ne → skript ho nastaví'}`);
  console.log(`  přihlášení:  ${zpusobPrihlaseni}`);
  if (zpusobPrihlaseni === 'žádný (!)') {
    console.error('\n⛔ Ten účet nemá ani heslo, ani Google/Apple — nepřihlásíš se k němu.');
    console.error('   Nic se nemazalo. Nastav si u něj nejdřív heslo (obnova hesla v aplikaci).\n');
    process.exit(1);
  }

  // ── Výpis / mazání ──
  console.log('');
  let celkem = 0;

  if (!SMAZAT) {
    for (const [model, popis] of kSmazani()) {
      const pocet = await prisma[model].count();
      celkem += pocet;
      if (pocet > 0) console.log(`  •  ${popis.padEnd(34)} ${pocet}`);
    }
    const ostatniUcty = ucty.length - 1;
    celkem += ostatniUcty;
    if (ostatniUcty > 0) console.log(`  •  ${'ostatní účty'.padEnd(34)} ${ostatniUcty}`);

    const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } });
    const aktualit = await prisma.roundHighlight.count();
    console.log(`\nZůstane: účet ${uchovat.email} a nastavení ligy ` +
                `(sezóna ${settings?.currentSeason ?? '— není nastavená —'})` +
                (NECHAT_AKTUALITY ? `, plus ${aktualit} článků v Aktualitách.` : '.'));
    console.log(`\nCelkem ke smazání: ${celkem} záznamů.`);
    console.log('Spusť znovu s `--smazat`, až si tím budeš jistý.\n');
    return;
  }

  await smazatVse();

  const { count: smazanoUctu } = await prisma.user.deleteMany({ where: { id: { not: uchovat.id } } });
  if (smazanoUctu > 0) console.log(`  ✓  ${'ostatní účty'.padEnd(34)} smazáno ${smazanoUctu}`);

  if (!uchovat.isSupervisor) {
    await prisma.user.update({ where: { id: uchovat.id }, data: { isSupervisor: true } });
    console.log(`  ✓  ${'supervisor'.padEnd(34)} nastaven na ${uchovat.email}`);
  }

  // ── Kontrolní přepočet ──
  console.log('\nKontrola po smazání:');
  const zbytky = [];
  for (const [model, popis] of kSmazani()) {
    const pocet = await prisma[model].count();
    if (pocet > 0) zbytky.push(`${popis} (${model}): ${pocet}`);
  }
  const uctyPoté = await prisma.user.findMany({ select: { email: true, isSupervisor: true } });
  const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } });

  console.log(`  účty:            ${uctyPoté.length} — ${uctyPoté.map((u) => `${u.email}${u.isSupervisor ? ' (supervisor)' : ''}`).join(', ') || '— žádný —'}`);
  console.log(`  aktuální sezóna: ${settings?.currentSeason ?? '— není nastavená —'}`);
  console.log(`  ostatní tabulky: ${zbytky.length === 0 ? 'prázdné' : 'ZBYTKY!'}`);
  zbytky.forEach((z) => console.log(`     ⚠️  ${z}`));

  if (zbytky.length > 0 || uctyPoté.length !== 1 || !uctyPoté[0].isSupervisor) {
    console.error('\n⚠️  Stav nesedí s tím, co měl skript nechat. Projdi hlášky výš.\n');
    process.exit(1);
  }

  if (NECHAT_AKTUALITY) {
    console.log(`  aktuality:       ${await prisma.roundHighlight.count()} (ponechány)`);
  }

  console.log('\nHotovo. V databázi je jediný účet (supervisor) a nastavení ligy.');
  console.log('Smazáním se nikomu nevrátily peníze — refundace patří do Stripu.');
  console.log('Ligovou strukturu (liga → konference → divize) je potřeba založit znovu.\n');
}

main()
  .catch((err) => { console.error('\nChyba:', err.message, '\n'); process.exit(1); })
  .finally(() => prisma.$disconnect());
