'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SEASON = '2025/26';
const BASE   = new Date('2026-08-18T14:00:00Z'); // round 10 = today

function roundDate(round) {
  const d = new Date(BASE);
  d.setDate(d.getDate() + (round - 10) * 7);
  d.setHours(14 + (round % 3) * 2, 0, 0, 0);
  return d;
}

// Deterministic pseudo-random
function h(n) { const x = Math.sin(n + 1) * 10000; return x - Math.floor(x); }
function rand(s, lo, hi) { return Math.floor(h(s) * (hi - lo + 1)) + lo; }

const FIRST = ['Jan','Jakub','Petr','Martin','Tomáš','Michal','Pavel','Lukáš','Ondřej','David','Josef','Jiří','Radek','Milan','Roman','Marek','Filip','Vojtěch','Zdeněk','Václav','Karel','Daniel','Matěj','Adam','Patrik','Robert','Miroslav','Jaroslav','René','Vladimír','Stanislav','Antonín','Aleš','Radoslav','Libor'];
const LAST  = ['Novák','Dvořák','Procházka','Kučera','Veselý','Horáček','Pokorný','Blažek','Fiala','Kratochvíl','Kopecký','Mareš','Kovář','Beneš','Horák','Pospíšil','Hájek','Čermák','Vlček','Šimánek','Sýkora','Urban','Dolejš','Konečný','Navrátil','Dušek','Rybář','Zeman','Hrdlička','Brož','Sedlák','Matoušek','Dobeš','Bajer','Kyselý'];
function pname(i) { return { firstName: FIRST[i % FIRST.length], lastName: LAST[(i * 7 + 3) % LAST.length] }; }

const DIVISIONS = [
  { name: 'Západ A', conf: 'Západ', teams: [
    { name: 'Prague Hawks',       abbr: 'PRH', color: '#7C3AED', venue: 'FSL Aréna Praha' },
    { name: 'Kladno Kings',       abbr: 'KLK', color: '#C9A140', venue: 'Hala Kladno' },
    { name: 'Plzeň Panthers',     abbr: 'PLP', color: '#2563EB', venue: 'ČEZ Aréna Plzeň' },
    { name: 'Liberec Eagles',     abbr: 'LIE', color: '#DC2626', venue: 'Home Credit Aréna' },
    { name: 'Ml. Boleslav Jets',  abbr: 'MBJ', color: '#16A34A', venue: 'Hala Ml. Boleslav' },
    { name: 'Most Sharks',        abbr: 'MSH', color: '#EA580C', venue: 'Hala Most' },
    { name: 'Teplice Dragons',    abbr: 'TPD', color: '#DB2777', venue: 'Hala Teplice' },
    { name: 'Ústí Wolves',        abbr: 'USW', color: '#0891B2', venue: 'Sportovní hala Ústí' },
  ]},
  { name: 'Západ B', conf: 'Západ', teams: [
    { name: 'ČB Bears',           abbr: 'CBB', color: '#9333EA', venue: 'Sportovní hala ČB' },
    { name: 'Písek Tigers',       abbr: 'PST', color: '#B45309', venue: 'Hala Písek' },
    { name: 'Strakonice Falcons', abbr: 'STF', color: '#1D4ED8', venue: 'Hala Strakonice' },
    { name: 'Tábor Vipers',       abbr: 'TBV', color: '#B91C1C', venue: 'Hala Tábor' },
    { name: 'Příbram Storm',      abbr: 'PBS', color: '#15803D', venue: 'Hala Příbram' },
    { name: 'Rakovník Raiders',   abbr: 'RKR', color: '#C2410C', venue: 'Hala Rakovník' },
    { name: 'Chomutov Bulls',     abbr: 'CHB', color: '#BE185D', venue: 'Hala Chomutov' },
    { name: 'KV Lions',           abbr: 'KVL', color: '#0E7490', venue: 'Hala Karlovy Vary' },
  ]},
  { name: 'Východ A', conf: 'Východ', teams: [
    { name: 'Ostrava Panthers',   abbr: 'OSP', color: '#7C3AED', venue: 'Ostravar Aréna' },
    { name: 'Opava Falcons',      abbr: 'OPF', color: '#C9A140', venue: 'Hala Opava' },
    { name: 'FM Bears',           abbr: 'FMB', color: '#2563EB', venue: 'Hala Frýdek-Místek' },
    { name: 'Karviná Thunder',    abbr: 'KVT', color: '#DC2626', venue: 'Hala Karviná' },
    { name: 'Havířov Storm',      abbr: 'HVS', color: '#16A34A', venue: 'Hala Havířov' },
    { name: 'Třinec Eagles',      abbr: 'TRE', color: '#EA580C', venue: 'Werk Aréna Třinec' },
    { name: 'Zlín Cobras',        abbr: 'ZLC', color: '#DB2777', venue: 'Hala Zlín' },
    { name: 'Olomouc Wolves',     abbr: 'OLW', color: '#0891B2', venue: 'Hala Olomouc' },
  ]},
  { name: 'Východ B', conf: 'Východ', teams: [
    { name: 'Hradec Lions',       abbr: 'HKL', color: '#9333EA', venue: 'Hala Hradec Králové' },
    { name: 'Pardubice Lynx',     abbr: 'PDL', color: '#B45309', venue: 'Enteria Aréna' },
    { name: 'Jihlava Foxes',      abbr: 'JHF', color: '#1D4ED8', venue: 'Hala Jihlava' },
    { name: 'Znojmo Snakes',      abbr: 'ZNS', color: '#B91C1C', venue: 'Hala Znojmo' },
    { name: 'Hodonín Spartans',   abbr: 'HDS', color: '#15803D', venue: 'Hala Hodonín' },
    { name: 'Kroměříž Hawks',     abbr: 'KMH', color: '#C2410C', venue: 'Hala Kroměříž' },
    { name: 'UH Knights',         abbr: 'UHK', color: '#BE185D', venue: 'Hala Uh. Hradiště' },
    { name: 'Brno Bulls',         abbr: 'BRB', color: '#0E7490', venue: 'Hala Brno' },
  ]},
];

const REFEREE_DATA = [
  { fn: 'Jan',    ln: 'Procházka',  lvl: 'A' },
  { fn: 'Pavel',  ln: 'Horák',      lvl: 'A' },
  { fn: 'Filip',  ln: 'Hájek',      lvl: 'A' },
  { fn: 'Michal', ln: 'Kratochvíl', lvl: 'B' },
  { fn: 'Tomáš',  ln: 'Beneš',      lvl: 'B' },
  { fn: 'David',  ln: 'Šimánek',    lvl: 'B' },
  { fn: 'Roman',  ln: 'Sýkora',     lvl: 'B' },
  { fn: 'Martin', ln: 'Kopecký',    lvl: 'C' },
  { fn: 'Lukáš',  ln: 'Sedlák',     lvl: 'C' },
  { fn: 'Ondřej', ln: 'Vlček',      lvl: 'C' },
];

// Standard circle round-robin, returns 14 rounds (7 + return leg)
function roundRobin(teams) {
  const n = teams.length, t = [...teams], rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const ms = [];
    for (let i = 0; i < n / 2; i++) ms.push([t[i], t[n - 1 - i]]);
    rounds.push(ms);
    t.splice(1, 0, t.splice(n - 1, 1)[0]);
  }
  return [...rounds, ...rounds.map(r => r.map(([h, a]) => [a, h]))];
}

async function addEvents(matchId, homeId, awayId, hs, as_, hPlayers, aPlayers, seed) {
  if (!hPlayers.length || !aPlayers.length) return;
  const used = new Set();
  function uniqMin(s, max) {
    let m, t = 0;
    do { m = rand(s + t++ * 31, 1, max); } while (used.has(m) && t < 30);
    used.add(m); return m;
  }

  const events = [];

  for (let g = 0; g < hs; g++) {
    const per = Math.min(Math.ceil((g + 1) / Math.max(1, Math.ceil(hs / 3))), 3);
    const min = uniqMin(seed + g * 13, per * 20);
    const si  = rand(seed + g * 11, 0, hPlayers.length - 1);
    const ai  = (si + 1) % hPlayers.length;
    const hasA = rand(seed + g * 7, 0, 3) > 0;
    events.push({ matchId, type: 'GOAL', minute: min, period: per, teamId: homeId,
      scorerId: hPlayers[si].id, assistId: hasA ? hPlayers[ai].id : null });
  }
  for (let g = 0; g < as_; g++) {
    const per = Math.min(Math.ceil((g + 1) / Math.max(1, Math.ceil(as_ / 3))), 3);
    const min = uniqMin(seed + g * 17 + 100, per * 20);
    const si  = rand(seed + g * 13 + 50, 0, aPlayers.length - 1);
    const ai  = (si + 1) % aPlayers.length;
    const hasA = rand(seed + g * 9 + 50, 0, 3) > 0;
    events.push({ matchId, type: 'GOAL', minute: min, period: per, teamId: awayId,
      scorerId: aPlayers[si].id, assistId: hasA ? aPlayers[ai].id : null });
  }
  // 0-3 penalties per match
  const pens = rand(seed + 777, 0, 3);
  for (let p = 0; p < pens; p++) {
    const isH = rand(seed + p * 19, 0, 1) === 0;
    const pl  = isH ? hPlayers : aPlayers;
    const pi  = rand(seed + p * 23, 0, pl.length - 1);
    const min = uniqMin(seed + p * 29 + 200, 60);
    events.push({ matchId, type: 'PENALTY', minute: min, period: Math.ceil(min / 20),
      teamId: isH ? homeId : awayId, penaltyId: pl[pi].id,
      penaltyType: ['2min', '5min', '10min'][rand(seed + p, 0, 2)] });
  }

  events.sort((a, b) => a.minute - b.minute);
  for (const e of events) await prisma.matchEvent.create({ data: e });
}

async function main() {
  console.log('🧹 Mažu celou databázi...');
  await prisma.lineupPlayer.deleteMany();
  await prisma.lineupSubmission.deleteMany();
  await prisma.postmatchData.deleteMany();
  await prisma.refRating.deleteMany();
  await prisma.matchEvent.deleteMany();
  await prisma.match.deleteMany();
  await prisma.draftOffer.deleteMany();
  await prisma.draftVideo.deleteMany();
  await prisma.draftProfile.deleteMany();
  await prisma.playerPayment.deleteMany();
  await prisma.teamPayment.deleteMany();
  await prisma.inviteCode.deleteMany();
  await prisma.player.deleteMany();
  await prisma.referee.deleteMany();
  await prisma.manager.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.supervisorRequest.deleteMany();
  await prisma.roundHighlight.deleteMany();
  await prisma.bankTransaction.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  console.log('✅ Hotovo\n');

  // ── ROZHODČÍ ─────────────────────────────────────────────
  console.log('🦺 Rozhodčí...');
  const refs = [];
  for (let i = 0; i < REFEREE_DATA.length; i++) {
    const r  = REFEREE_DATA[i];
    const u  = await prisma.user.create({ data: { email: `ref${i + 1}@fsl.cz` } });
    refs.push(await prisma.referee.create({
      data: { userId: u.id, firstName: r.fn, lastName: r.ln,
        level: r.lvl, status: 'APPROVED',
        phone: `+420 60${i} 000 00${i}`, bankAccount: `100000${i}`, bankCode: '0800' },
    }));
  }

  // ── TÝMY + HRÁČI ─────────────────────────────────────────
  console.log('🏒 Týmy + hráči (32 × 15)...');
  const allTeams = [];
  let pi = 0;

  for (const div of DIVISIONS) {
    for (const td of div.teams) {
      const team = await prisma.team.create({
        data: { name: td.name, abbr: td.abbr, color: td.color, venue: td.venue,
          division: div.name, conference: div.conf,
          payments: { create: { season: SEASON, amount: 10000, status: 'PAID',
            paidAt: new Date('2025-09-01'), method: 'bank' } } },
      });

      // Manager
      const mu = await prisma.user.create({ data: { email: `mgr.${td.abbr.toLowerCase()}@fsl.cz` } });
      await prisma.manager.create({ data: { userId: mu.id, teamId: team.id } });
      await prisma.inviteCode.create({ data: { code: `FSL-${td.abbr}-DEMO`, teamId: team.id } });

      // 15 players: jersey 1-2 = GK, 3-10 = forward, 11-15 = defender
      const fielders = [], gks = [];
      for (let p = 0; p < 15; p++) {
        const { firstName, lastName } = pname(pi++);
        const isGK  = p < 2;
        const pos   = isGK ? 'Brankář' : (p < 10 ? 'Útočník' : 'Obránce');
        const pu    = await prisma.user.create({ data: { email: `p${pi}@fsl.cz` } });
        const player = await prisma.player.create({
          data: { userId: pu.id, teamId: team.id, firstName, lastName,
            jersey: p + 1, position: pos, licensed: true,
            payment: { create: { season: SEASON, licStatus: 'PAID',
              licPaidAt: new Date('2025-09-15'), licMethod: 'bank' } } },
        });
        if (isGK) gks.push(player); else fielders.push(player);
      }
      allTeams.push({ team, divName: div.name, fielders, gks });
    }
  }

  // ── HIGHLIGHTS ───────────────────────────────────────────
  await prisma.roundHighlight.createMany({ data: [
    { round: 10, title: 'Živě: 4 zápasy právě probíhají!',
      body: 'Prague Hawks vedou nad Kladno Kings 2:1 po 1. třetině. Olomouc Wolves rozstříleli Havířov 3:0.',
      pinned: true },
    { round: 9, title: 'Highlights 9. kola – drama v závěru',
      body: 'Prague Hawks otočili zápas v posledních 3 minutách a porazili Liberec Eagles 6:4. Hattrick Jan Novák!',
      pinned: false },
    { round: 8, title: 'Rekord Olomouce: 5. výhra v řadě',
      body: 'Olomouc Wolves jsou nezdolatelní – Havířov zdolali 8:2 a upevnili vedení v divizi Východ A.',
      pinned: false },
    { round: 6, title: 'Tabulka střelců po 6 kolech',
      body: 'Vedení v tabulce střelců drží Tomáš Procházka (PRH) s 11 body. Karviná a Ostrava bojují o čelo divize.',
      pinned: false },
  ]});

  // ── ZÁPASY (14 kol × 4 divize) ───────────────────────────
  console.log('📅 Zápasy...');
  const byDiv = {};
  for (const t of allTeams) {
    if (!byDiv[t.divName]) byDiv[t.divName] = [];
    byDiv[t.divName].push(t);
  }

  let totalMatches = 0, liveCount = 0;

  for (const [divName, divTeams] of Object.entries(byDiv)) {
    const schedule = roundRobin(divTeams); // 14 rounds × 4 matches

    for (let ri = 0; ri < schedule.length; ri++) {
      const round = ri + 1;
      const ref   = refs[ri % refs.length];

      for (let mi = 0; mi < schedule[ri].length; mi++) {
        const [homeT, awayT] = schedule[ri][mi];
        totalMatches++;
        const seed = totalMatches * 13 + round * 7 + mi * 3;

        let status;
        if      (round < 10)                      status = 'DONE';
        else if (round === 10 && mi === 0 && liveCount < 4) { status = 'LIVE'; liveCount++; }
        else if (round === 10)                    status = 'DONE';
        else                                      status = 'UPCOMING';

        // Scores: home 1-7, away 0-6 (floorball realistický rozsah)
        const hs  = status !== 'UPCOMING' ? Math.max(rand(seed, 1, 7), 1) : 0;
        const as_ = status !== 'UPCOMING' ? rand(seed + 1, 0, 6)          : 0;

        // For LIVE: current partial score (lower)
        const liveHS = status === 'LIVE' ? rand(seed + 5, 0, 3) : hs;
        const liveAS = status === 'LIVE' ? rand(seed + 6, 0, 2) : as_;

        const match = await prisma.match.create({
          data: {
            homeTeamId: homeT.team.id, awayTeamId: awayT.team.id,
            refereeId: ref.id, division: divName, season: SEASON,
            round, date: roundDate(round),
            venue: homeT.team.venue,
            homeScore: status === 'LIVE' ? liveHS : hs,
            awayScore: status === 'LIVE' ? liveAS : as_,
            status,
          },
        });

        if (status === 'DONE') {
          await addEvents(match.id, homeT.team.id, awayT.team.id, hs, as_,
            homeT.fielders, awayT.fielders, seed);
        } else if (status === 'LIVE') {
          await addEvents(match.id, homeT.team.id, awayT.team.id, liveHS, liveAS,
            homeT.fielders, awayT.fielders, seed + 500);
        }
      }
    }
  }

  const doneCount = totalMatches - liveCount - (4 * 4 * 4); // roughly
  console.log('\n🎉 Seed hotov!');
  console.log(`   32 týmů  |  4 divize  |  2 konference`);
  console.log(`   ${pi} hráčů (15/tým, licencovaní)  |  ${refs.length} rozhodčích`);
  console.log(`   ${totalMatches} zápasů – ${liveCount} LIVE, ~${9 * 4 * 4} DONE, zbytek UPCOMING`);
  console.log('');
  console.log('──────────────────────────────────────────');
  console.log('⚠️  SUPERVISOR SETUP (po spuštění seeda):');
  console.log('   1. Přihlaš se do apky Apple ID');
  console.log('   2. Spusť: node prisma/make-supervisor.js');
  console.log('      (najde tvůj účet a nastaví isSupervisor=true)');
  console.log('──────────────────────────────────────────');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
