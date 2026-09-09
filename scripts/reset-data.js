#!/usr/bin/env node
/**
 * Vymazání soutěžních dat — start s novou logikou od nuly.
 *
 * ⚠️ MAŽE PRODUKČNÍ DATA. Nedá se vrátit zpět.
 *
 * Ve výchozím stavu **nic nemaže** a jen vypíše, co by šlo pryč. Skutečné
 * mazání spustí až `--smazat`.
 *
 *   node scripts/reset-data.js                # jen výpis, nic se nemaže
 *   node scripts/reset-data.js --smazat       # doopravdy smaže
 *   node scripts/reset-data.js --smazat --vcetne-uctu   # smaže i uživatele
 *
 * ── Co zůstává ──────────────────────────────────────────────────────────
 *   Settings          nastavení ligy včetně aktuální sezóny
 *   User              **všechny účty**, aby se bylo čím přihlásit
 *   Referee           rozhodčí a jejich údaje
 *
 * Účty se schválně nechávají: kdyby se smazaly, přijdeš o vlastní
 * přihlášení i o příznak supervisora a ligu by pak nespravoval nikdo.
 * S `--vcetne-uctu` se smažou taky, ale supervisorské účty i tak zůstanou.
 *
 * ── Co jde pryč ─────────────────────────────────────────────────────────
 *   zápasy, události, sestavy, hodnocení rozhodčích, pozápasové zprávy,
 *   soupisky, volby playoff, hráči, týmy, přihlášky do sezón, ligová
 *   struktura, pozvánkové kódy, platby, balíčky zápasů a starty,
 *   doporučovací kódy, draft, bankovní transakce, zprávy z kol, oznámení,
 *   žádosti na supervisora, plánované přechody sezóny.
 *
 * ── Co se tím NEVRÁTÍ ───────────────────────────────────────────────────
 * Smazáním záznamu o platbě se nikomu nevrací peníze. Co je zaplacené přes
 * Stripe, zůstává zaplacené — a v účetnictví taky. Refundace se řeší
 * ve Stripu, ne tady.
 */

const prisma = require('../src/lib/prisma');

const SMAZAT       = process.argv.includes('--smazat');
const VCETNE_UCTU  = process.argv.includes('--vcetne-uctu');

/**
 * Pořadí je důležité: nejdřív to, co na něčem visí, pak to, na čem to viselo.
 * Většina vazeb má sice `onDelete: Cascade`, ale spoléhat se na to znamená
 * mazat naslepo — takhle je vidět, kolik čeho zmizelo.
 */
const TABULKY = [
  ['matchEvent',        'události v zápasech'],
  ['lineupPlayer',      'hráči v sestavách'],
  ['lineupSubmission',  'odeslané sestavy'],
  ['postmatchData',     'pozápasové zprávy'],
  ['refRating',         'hodnocení rozhodčích'],
  ['matchEntry',        'starty (rezervace a odpočty)'],
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

  ['playerPayment',     'platby hráčů'],
  ['teamPayment',       'platby týmů'],
  ['bankTransaction',   'zpracované bankovní pohyby'],

  ['inviteCode',        'pozvánkové kódy'],
  ['player',            'hráči'],
  ['manager',           'vedoucí týmů'],
  ['team',              'týmy'],

  ['division',          'divize'],
  ['conference',        'konference'],
  ['league',            'ligy'],

  ['roundHighlight',    'zprávy z kol'],
  ['notification',      'oznámení'],
  ['supervisorRequest', 'žádosti na supervisora'],
  ['seasonTransition',  'naplánované přechody sezóny'],
];

async function main() {
  console.log(SMAZAT
    ? '\n⚠️  MAZÁNÍ DAT — tohle se nedá vrátit zpět.\n'
    : '\nJEN VÝPIS — nic se nemaže. Skutečné mazání spustí `--smazat`.\n');

  let celkem = 0;
  for (const [model, popis] of TABULKY) {
    if (!prisma[model]) {
      console.log(`  ?  ${popis.padEnd(34)} — model ${model} v schématu není, přeskakuji`);
      continue;
    }
    const pocet = await prisma[model].count();
    celkem += pocet;
    if (pocet === 0) continue;

    if (SMAZAT) {
      const { count } = await prisma[model].deleteMany({});
      console.log(`  ✓  ${popis.padEnd(34)} smazáno ${count}`);
    } else {
      console.log(`  •  ${popis.padEnd(34)} ${pocet}`);
    }
  }

  // ── Účty ──
  const supervisori = await prisma.user.count({ where: { isSupervisor: true } });
  const ostatni     = await prisma.user.count({ where: { isSupervisor: false } });

  if (VCETNE_UCTU) {
    if (SMAZAT) {
      const { count } = await prisma.user.deleteMany({ where: { isSupervisor: false } });
      console.log(`  ✓  ${'účty (mimo supervisory)'.padEnd(34)} smazáno ${count}`);
    } else {
      console.log(`  •  ${'účty (mimo supervisory)'.padEnd(34)} ${ostatni}`);
    }
  } else if (ostatni > 0) {
    console.log(`  –  ${'účty'.padEnd(34)} ${ostatni} zůstává (přidej --vcetne-uctu)`);
  }

  const settings = await prisma.settings.findUnique({ where: { id: 'singleton' } });
  const rozhodci = await prisma.referee.count();

  console.log('\nZůstává:');
  console.log(`  aktuální sezóna: ${settings?.currentSeason ?? '— není nastavená —'}`);
  console.log(`  supervisorů:     ${supervisori}`);
  console.log(`  rozhodčích:      ${rozhodci}`);

  if (!SMAZAT) {
    console.log(`\nCelkem ke smazání: ${celkem} záznamů.`);
    console.log('Spusť znovu s `--smazat`, až si tím budeš jistý.\n');
  } else {
    console.log('\nHotovo. Liga je prázdná a jede na nové logice.');
    console.log('Smazáním se nikomu nevrátily peníze — refundace patří do Stripu.\n');
  }

  if (supervisori === 0) {
    console.log('⚠️  V databázi není žádný supervisor. Bez něj ligu nikdo nespravuje —');
    console.log('    nastav `User.isSupervisor = true` dřív, než se odhlásíš.\n');
  }
}

main()
  .catch((err) => { console.error('\nChyba:', err.message, '\n'); process.exit(1); })
  .finally(() => prisma.$disconnect());
