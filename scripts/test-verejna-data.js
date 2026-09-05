/**
 * Test veřejných dat — co smí z API ven bez přihlášení.
 *
 * Běží bez databáze: prisma je nahrazená mockem přes Module._load, takže
 * `npm run test:public` jde spustit kdekoliv (i v CI) a je rychlý.
 *
 * Hlídá čtyři věci, které se v tomhle projektu už jednou pokazily:
 *   1. Prisma při `include` vrací všechny sloupce — hash hesla, telefon,
 *      datum narození, variabilní symbol.
 *   2. Vedoucí týmu a supervisor musí svá data vidět dál.
 *   3. `optionalAuth` nesmí u rozbitého tokenu vracet 401, jinak spadne web.
 *   4. Počty týmů a stav registrace (poznámka supervisora, odvolání týmu)
 *      jsou jen pro supervisora — veřejně jde ven struktura, ne čísla.
 */
const Module = require('module');

/** Napodobí prismí `select`, aby test doopravdy ověřoval whitelisty v routách. */
function vyber(obj, select) {
  if (!select) return JSON.parse(JSON.stringify(obj));
  const out = {};
  for (const [klic, spec] of Object.entries(select)) {
    if (spec === true) { if (klic in obj) out[klic] = obj[klic]; }
    else if (spec && spec.select && obj[klic] != null) out[klic] = vyber(obj[klic], spec.select);
  }
  return out;
}

const TEAM = {
  id: 'T1', name: 'Tym', abbr: 'TYM',
  color: '#C9A140', colorSecondary: null, logoUrl: null, venue: 'Hala',
  division: 'Divize A', conference: null, createdAt: '2026-08-01T00:00:00.000Z',
  regStatus: 'REJECTED', regNote: 'Duvod zamitnuti od supervisora',
  regAppeal: 'Odvolani tymu', regAppealAt: '2026-08-02T00:00:00.000Z',
  _count: { players: 1 },
  players: [{
    id: 'P1', teamId: 'T1', userId: 'U9', firstName: 'Jan', lastName: 'Novak',
    jersey: 10, position: 'Útočník', photoUrl: null, licensed: true,
    phone: '601157458', birthdate: '2000-01-01',
    payment: { id: 'PAY1', season: '2025/26', licStatus: 'PAID', superStatus: 'PENDING', superLic: true,
               variableSymbol: '10000001', stripeId: 'cs_live_x', licSessionId: 'cs_live_y' },
  }],
  managers: [{ id: 'M1', teamId: 'T1', userId: 'U1', user: { id: 'U1', email: 'a@b.cz', passwordHash: 'HASH' } }],
};
const PLAYER = { ...TEAM.players[0], team: { id: 'T1', name: 'Tym' }, goals: [{ id: 'G1' }], assists: [], mvpVotes: [] };

const USERS = {
  U1: { id: 'U1', email: 'a@b.cz', isSupervisor: false, player: null,
        manager: [{ id: 'M1', teamId: 'T1' }] },
  U8: { id: 'U8', email: 'cizi@b.cz', isSupervisor: false, player: null, manager: [] },
  U9: { id: 'U9', email: 'hrac@b.cz', isSupervisor: false, player: { id: 'P1', isSupervisor: false }, manager: [] },
  U0: { id: 'U0', email: 'super@b.cz', isSupervisor: true, player: null, manager: [] },
};

const LIGA = {
  id: 'L1', name: 'FSL Liga', level: 1, season: '2025/26',
  conferences: [{ id: 'K1', leagueId: 'L1', name: 'Hlavni',
                  divisions: [{ id: 'D1', conferenceId: 'K1', name: 'Divize A' }] }],
};

const fakePrisma = {
  team: {
    findUnique: async () => JSON.parse(JSON.stringify(TEAM)),
    findMany:   async ({ select }) => [vyber(TEAM, select)],
    groupBy:    async () => [{ division: 'Divize A', conference: null, _count: { division: 7 } }],
  },
  player: { findUnique: async () => JSON.parse(JSON.stringify(PLAYER)) },
  user:   { findUnique: async ({ where }) => USERS[where.id] ?? null },
  league: { findMany: async () => [JSON.parse(JSON.stringify(LIGA))] },
  teamSeason: {
    groupBy:  async () => [{ leagueId: 'L1', conferenceId: 'K1', divisionId: 'D1', _count: { teamId: 7 } }],
    findMany: async ({ include }) => [{
      leagueId: 'L1', conferenceId: 'K1', divisionId: 'D1',
      team: vyber(TEAM, include.team.select),
      league: { id: 'L1', name: 'FSL Liga' },
      conference: { id: 'K1', name: 'Hlavni' },
      division: { id: 'D1', name: 'Divize A' },
    }],
  },
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('lib/prisma')) return fakePrisma;
  if (request.endsWith('utils/fileUpload')) {
    const mw = { single: () => (r, s, n) => n() };
    return { uploadLogo: mw, uploadPhoto: mw };
  }
  if (request.endsWith('services/push')) return { sendPush: async () => {} };
  if (request.endsWith('services/seasonTransition')) {
    return { currentSeason: async () => '2025/26' };
  }
  return orig.apply(this, arguments);
};

const express = require('express');
const teams = require('../src/routes/teams');
const players = require('../src/routes/players');
const leagues = require('../src/routes/leagues');
const app = express();
app.use('/teams', teams);
app.use('/players', players);
app.use('/leagues', leagues);

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let fail = 0;
  const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };

  const anonTeam = await (await fetch(`${base}/teams/T1`)).json();
  const p = anonTeam.players[0];
  ok(p.phone === undefined, 'tým anonym: bez telefonu');
  ok(p.birthdate === undefined, 'tým anonym: bez data narození');
  ok(p.userId === undefined, 'tým anonym: bez userId');
  ok(p.payment.variableSymbol === undefined, 'tým anonym: bez VS');
  ok(p.payment.licStatus === 'PAID', 'tým anonym: stav licence zůstává');
  ok(p.firstName === 'Jan' && p.jersey === 10, 'tým anonym: soupiska se vrací');
  ok(JSON.stringify(anonTeam).includes('HASH') === false, 'tým anonym: bez hash hesla');
  ok(anonTeam.managers[0].user === undefined, 'tým anonym: bez kontaktu na vedoucího');

  const anonPlayer = await (await fetch(`${base}/players/P1`)).json();
  ok(anonPlayer.phone === undefined, 'hráč anonym: bez telefonu');
  ok(anonPlayer.birthdate === undefined, 'hráč anonym: bez data narození');
  ok(anonPlayer.payment.variableSymbol === undefined, 'hráč anonym: bez VS');
  ok(Array.isArray(anonPlayer.goals) && anonPlayer.goals.length === 1, 'hráč anonym: statistiky zůstávají');
  ok(anonPlayer.team && anonPlayer.team.name === 'Tym', 'hráč anonym: tým zůstává');

  // Přihlášení
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const jwt = require('jsonwebtoken');
  const token = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);
  const jako = async (url, userId) => (await fetch(base + url, {
    headers: userId ? { Authorization: `Bearer ${token(userId)}` } : {},
  })).json();

  const vedouci = await jako('/teams/T1', 'U1');
  ok(vedouci.players[0].phone === '601157458', 'tým vedoucí: vidí telefon');
  ok(vedouci.players[0].payment.variableSymbol === '10000001', 'tým vedoucí: vidí VS');

  const cizi = await jako('/teams/T1', 'U8');
  ok(cizi.players[0].phone === undefined, 'tým cizí přihlášený: bez telefonu');

  const spatnyToken = await (await fetch(base + '/teams/T1', { headers: { Authorization: 'Bearer nesmysl' } })).json();
  ok(spatnyToken.players && spatnyToken.players[0].phone === undefined, 'tým rozbitý token: 200 a veřejná data, ne 401');

  const hracSam = await jako('/players/P1', 'U9');
  ok(hracSam.phone === '601157458', 'hráč sám: vidí svůj telefon');
  const hracCizi = await jako('/players/P1', 'U8');
  ok(hracCizi.phone === undefined, 'hráč cizí: bez telefonu');
  const hracVedouci = await jako('/players/P1', 'U1');
  ok(hracVedouci.phone === '601157458', 'hráč vedoucí jeho týmu: vidí telefon');

  // ---- počty a stav registrace: jen supervisor ----
  const seznam = (await jako('/teams'))[0];
  ok(seznam.regNote === undefined, 'seznam týmů anonym: bez poznámky supervisora');
  ok(seznam.regAppeal === undefined, 'seznam týmů anonym: bez odvolání týmu');
  ok(seznam.regStatus === undefined, 'seznam týmů anonym: bez stavu registrace');
  ok(seznam._count === undefined, 'seznam týmů anonym: bez velikosti soupisky');
  ok(seznam.name === 'Tym' && seznam.division === 'Divize A', 'seznam týmů anonym: název a divize zůstávají');

  const seznamSuper = (await jako('/teams', 'U0'))[0];
  ok(seznamSuper.regNote === 'Duvod zamitnuti od supervisora', 'seznam týmů supervisor: vidí poznámku');
  ok(seznamSuper._count.players === 1, 'seznam týmů supervisor: vidí soupisku');

  const detailAnon = await jako('/teams/T1');
  ok(detailAnon.regNote === undefined, 'detail týmu anonym: bez poznámky supervisora');
  ok(detailAnon.regAppeal === undefined, 'detail týmu anonym: bez odvolání týmu');

  const divize = (await jako('/teams/divisions'))[0];
  ok(divize._count === undefined, 'divize anonym: bez počtu týmů');
  ok(divize.division === 'Divize A', 'divize anonym: název divize zůstává');
  ok((await jako('/teams/divisions', 'U0'))[0]._count.division === 7, 'divize supervisor: vidí počet');

  const strom = await jako('/leagues');
  ok(strom.leagues[0].teamCount === undefined, 'strom soutěží anonym: bez teamCount');
  ok(strom.leagues[0].conferences[0].divisions[0].name === 'Divize A', 'strom soutěží anonym: struktura zůstává');
  ok((await jako('/leagues', 'U0')).leagues[0].teamCount === 7, 'strom soutěží supervisor: vidí teamCount');

  const ligoveTymy = (await jako('/leagues/teams')).teams[0];
  ok(ligoveTymy._count === undefined, 'týmy v soutěži anonym: bez velikosti soupisky');
  ok(ligoveTymy.regStatus === undefined, 'týmy v soutěži anonym: bez stavu registrace');
  ok(ligoveTymy.placement.division.name === 'Divize A', 'týmy v soutěži anonym: zařazení zůstává');
  ok((await jako('/leagues/teams', 'U0')).teams[0]._count.players === 1, 'týmy v soutěži supervisor: vidí soupisku');

  server.close();
  console.log(fail === 0 ? '\nVŠE PROŠLO' : `\n${fail} SELHALO`);
  process.exit(fail === 0 ? 0 : 1);
});
