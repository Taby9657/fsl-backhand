/**
 * FSL – Fio Banka párování plateb
 *
 * Fio API doku: https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf
 *
 * Tok:
 *  1. Každý hráč/tým dostane unikátní variabilní symbol (VS)
 *  2. Platí převodem na FSL účet s tímto VS
 *  3. bankSync() stáhne transakce z Fio a spáruje podle VS
 *  4. Označí platbu jako PAID, vytvoří BankTransaction záznam
 */


const prisma = require('../lib/prisma');

const FIO_API_BASE = 'https://fioapi.fio.cz/v1/rest';
const FIO_TOKEN    = process.env.FIO_API_TOKEN;

// ==================== VARIABILNÍ SYMBOLY ====================

/**
 * Generuje deterministický 10-místný VS z player/team DB id.
 * Fio akceptuje VS 0–9999999999 (max 10 číslic).
 *
 * Schéma:
 *   Hráč – licence:     1 + 7místné číslo (prefix 1)
 *   Hráč – superlicence: 2 + 7místné číslo (prefix 2)
 *   Tým  – registrace:  3 + 7místné číslo (prefix 3)
 *   Tým  – domácí zápas: 4 + 7místné číslo (prefix 4)
 */
function generateVS(type, sequenceNumber) {
  // BUG-07 OPRAVA: Zamezení přetečení pořadového čísla VS
  // Fio API akceptuje VS max 10 číslic (0–9 999 999 999), prefix zabírá 1 číslo
  if (sequenceNumber > 9_999_999) {
    throw new Error(`VS overflow: pořadové číslo ${sequenceNumber} přesahuje maximální hodnotu 9 999 999`);
  }
  const prefixes = {
    PLAYER_LICENSE: 1,
    SUPER_LICENSE:  2,
    TEAM_REG:       3,
    HOME_FEE:       4,
  };
  const prefix = prefixes[type] ?? 9;
  const seq    = String(sequenceNumber).padStart(7, '0').slice(0, 7);
  return `${prefix}${seq}`;
}

/**
 * Přidělí VS hráči (pokud ještě nemá) a vrátí ho.
 * BUG-10: retry při kolizi unikátního VS (race condition)
 */
async function ensurePlayerVS(playerId, type = 'PLAYER_LICENSE') {
  // Licence a superlicence mají vlastní sloupec – jinak by je nešlo při
  // příchozím převodu odlišit (obě by měly stejný VS).
  const field = type === 'SUPER_LICENSE' ? 'superVariableSymbol' : 'variableSymbol';

  for (let attempt = 0; attempt < 5; attempt++) {
    const payment = await prisma.playerPayment.findUnique({ where: { playerId } });
    if (!payment) throw new Error('PlayerPayment nenalezen');
    if (payment[field]) return payment[field];

    const count = await prisma.playerPayment.count();
    // attempt v pořadovém čísle: při kolizi se pokusíme o jiný symbol,
    // jinak by se opakovaně generoval ten samý a retry by nikdy neuspěl
    const vs = generateVS(type, count + 1 + attempt);
    try {
      await prisma.playerPayment.update({ where: { playerId }, data: { [field]: vs } });
      return vs;
    } catch (err) {
      if (err.code !== 'P2002' || attempt >= 4) throw err;
      // Jiný request přidělil VS ve stejný moment → zkusíme znovu
    }
  }
}

/**
 * Přidělí VS týmu a vrátí ho.
 * BUG-10: retry při kolizi unikátního VS (race condition)
 */
async function ensureTeamVS(teamId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const payment = await prisma.teamPayment.findUnique({ where: { teamId } });
    if (!payment) throw new Error('TeamPayment nenalezen');
    if (payment.variableSymbol) return payment.variableSymbol;

    const count = await prisma.teamPayment.count();
    const vs    = generateVS('TEAM_REG', count + 1 + attempt);
    try {
      await prisma.teamPayment.update({ where: { teamId }, data: { variableSymbol: vs } });
      return vs;
    } catch (err) {
      if (err.code !== 'P2002' || attempt >= 4) throw err;
    }
  }
}

/**
 * Přidělí VS konkrétnímu domácímu zápasu (poplatek 2 200 Kč).
 * VS je na úrovni zápasu, ne týmu – jeden tým hraje doma vícekrát za sezónu
 * a každá platba musí jít spárovat se svým zápasem.
 */
async function ensureMatchHomeFeeVS(matchId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw new Error('Zápas nenalezen');
    if (match.homeFeeVS) return match.homeFeeVS;

    const count = await prisma.match.count({ where: { homeFeeVS: { not: null } } });
    const vs    = generateVS('HOME_FEE', count + 1 + attempt);
    try {
      await prisma.match.update({ where: { id: matchId }, data: { homeFeeVS: vs } });
      return vs;
    } catch (err) {
      if (err.code !== 'P2002' || attempt >= 4) throw err;
    }
  }
}

// ==================== FIO API ====================

/**
 * Stáhne transakce za posledních N dní z Fio API.
 */
async function fetchFioTransactions(days = 30) {
  if (!FIO_TOKEN) throw new Error('FIO_API_TOKEN není nastaven');

  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const fmt = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const url = `${FIO_API_BASE}/periods/${FIO_TOKEN}/${fmt(from)}/${fmt(to)}/transactions.json`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Fio API chyba ${response.status}: ${text}`);
  }

  const data = await response.json();
  const transactions = data?.accountStatement?.transactionList?.transaction ?? [];
  return transactions.map(parseTransaction).filter(Boolean);
}

/**
 * Normalizuje Fio transakci do jednoduchého objektu.
 * Fio vrací každé pole jako { value, name, id } nebo null.
 */
function parseTransaction(raw) {
  const get = (key) => raw[key]?.value ?? null;

  const amount = get('column1');   // Objem (záporný = odchozí)
  if (!amount || amount <= 0) return null; // zajímají nás jen příchozí

  return {
    transactionId:  String(get('column22') ?? get('column0')), // ID pohybu
    amount:         Math.round(amount),
    variableSymbol: String(get('column5') ?? '').trim() || null,
    senderAccount:  get('column2'),
    senderName:     get('column10'),
    date:           new Date(get('column0') ?? Date.now()),
    message:        get('column16') ?? '',
  };
}

// ==================== PÁROVÁNÍ ====================

/**
 * Hlavní funkce – stáhne transakce a spáruje je s platbami.
 * Vrací přehled výsledků.
 */
async function bankSync(days = 30) {
  const transactions = await fetchFioTransactions(days);
  const results = { matched: [], skipped: [], errors: [] };

  for (const tx of transactions) {
    try {
      // Přeskočit již zpracované transakce
      const existing = await prisma.bankTransaction.findUnique({
        where: { transactionId: tx.transactionId },
      });
      if (existing) {
        results.skipped.push({ txId: tx.transactionId, reason: 'již zpracováno' });
        continue;
      }

      const matchResult = await matchTransaction(tx);

      // Ulož transakci vždy (i nespárované)
      await prisma.bankTransaction.create({
        data: {
          transactionId:  tx.transactionId,
          amount:         tx.amount,
          variableSymbol: tx.variableSymbol,
          senderName:     tx.senderName,
          senderAccount:  tx.senderAccount,
          date:           tx.date,
          matched:        matchResult.matched,
        },
      });

      if (matchResult.matched) {
        results.matched.push({ txId: tx.transactionId, ...matchResult });
      } else {
        results.skipped.push({ txId: tx.transactionId, reason: matchResult.reason, vs: tx.variableSymbol });
      }
    } catch (err) {
      results.errors.push({ txId: tx.transactionId, error: err.message });
    }
  }

  return results;
}

/**
 * Pokusí se spárovat jednu transakci s platebním záznamem.
 */
async function matchTransaction(tx) {
  const vs = tx.variableSymbol;
  if (!vs) return { matched: false, reason: 'chybí variabilní symbol' };

  // 1. Hráčská licence (prefix 1)
  const licPayment = await prisma.playerPayment.findUnique({
    where:   { variableSymbol: vs },
    include: { player: { select: { id: true, firstName: true, lastName: true, userId: true } } },
  });
  if (licPayment) return payPlayerLicense(licPayment, tx);

  // 2. Superlicence (prefix 2) – vlastní sloupec, aby šla odlišit od licence
  const superPayment = await prisma.playerPayment.findFirst({
    where:   { superVariableSymbol: vs },
    include: { player: { select: { id: true, firstName: true, lastName: true, userId: true } } },
  });
  if (superPayment) return paySuperLicense(superPayment, tx);

  // 3. Registrace týmu (prefix 3)
  const teamPayment = await prisma.teamPayment.findUnique({
    where:   { variableSymbol: vs },
    include: { team: true },
  });
  if (teamPayment) return payTeamRegistration(teamPayment, tx);

  // 4. Poplatek za domácí zápas (prefix 4) – VS je na konkrétním zápase
  const match = await prisma.match.findFirst({
    where:   { homeFeeVS: vs },
    include: { homeTeam: { select: { id: true, name: true } } },
  });
  if (match) return payHomeFee(match, tx);

  return { matched: false, reason: 'variabilní symbol nenalezen v databázi' };
}

// ---------- jednotlivé typy plateb ----------

async function payPlayerLicense(payment, tx) {
  if (payment.licStatus === 'PAID') {
    return { matched: false, reason: 'licence již evidována jako zaplacená' };
  }
  if (tx.amount < payment.licFee) {
    return {
      matched: false,
      reason: `nedostatečná částka (přišlo ${tx.amount}, požadováno ${payment.licFee})`,
    };
  }
  // Atomický update se WHERE podmínkou: zabrání race condition při souběžném zpracování
  const updated = await prisma.playerPayment.updateMany({
    where: { id: payment.id, licStatus: { not: 'PAID' } },
    data:  { licStatus: 'PAID', licPaidAt: tx.date, licMethod: 'bank' },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
  }

  await prisma.player.update({
    where: { id: payment.playerId },
    data:  { licensed: true },
  });
  await sendNotification(
    payment.player.userId,
    'Platba přijata',
    `Licenční poplatek ${tx.amount} Kč byl spárován.`,
    'payments',
  );
  return { matched: true, type: 'PLAYER_LICENSE', playerId: payment.playerId, amount: tx.amount };
}

async function paySuperLicense(payment, tx) {
  if (payment.superStatus === 'PAID') {
    return { matched: false, reason: 'superlicence již evidována jako zaplacená' };
  }
  if (tx.amount < payment.superFee) {
    return {
      matched: false,
      reason: `nedostatečná částka pro superlicenci (přišlo ${tx.amount}, požadováno ${payment.superFee})`,
    };
  }
  const updated = await prisma.playerPayment.updateMany({
    where: { id: payment.id, superStatus: { not: 'PAID' } },
    data:  { superStatus: 'PAID', superPaidAt: tx.date, superLic: true },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'superlicence právě zpracována jiným procesem (race condition)' };
  }

  await sendNotification(
    payment.player.userId,
    'Platba přijata',
    `Super licence ${tx.amount} Kč zaplacena.`,
    'payments',
  );
  return { matched: true, type: 'SUPER_LICENSE', playerId: payment.playerId, amount: tx.amount };
}

async function payTeamRegistration(payment, tx) {
  if (payment.status === 'PAID') {
    return { matched: false, reason: 'týmová platba již zaplacena' };
  }
  if (tx.amount < payment.amount) {
    return {
      matched: false,
      reason: `nedostatečná částka (přišlo ${tx.amount}, požadováno ${payment.amount})`,
    };
  }
  const updated = await prisma.teamPayment.updateMany({
    where: { id: payment.id, status: { not: 'PAID' } },
    data:  { status: 'PAID', paidAt: tx.date, method: 'bank' },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'týmová platba právě zpracována jiným procesem (race condition)' };
  }

  await notifyTeamManagers(
    payment.teamId,
    'Platba přijata',
    `Registrační poplatek ${tx.amount} Kč byl spárován.`,
  );
  return { matched: true, type: 'TEAM_REG', teamId: payment.teamId, amount: tx.amount };
}

const HOME_FEE_AMOUNT = 2200;

async function payHomeFee(match, tx) {
  if (match.homeFeePaid) {
    return { matched: false, reason: 'poplatek za tento zápas je již uhrazen' };
  }
  if (tx.amount < HOME_FEE_AMOUNT) {
    return {
      matched: false,
      reason: `nedostatečná částka (přišlo ${tx.amount}, požadováno ${HOME_FEE_AMOUNT})`,
    };
  }
  const updated = await prisma.match.updateMany({
    where: { id: match.id, homeFeePaid: false },
    data:  { homeFeePaid: true },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'poplatek právě zpracován jiným procesem (race condition)' };
  }

  const dateStr = new Date(match.date).toLocaleDateString('cs-CZ');
  await notifyTeamManagers(
    match.homeTeamId,
    'Platba přijata',
    `Poplatek za domácí zápas ${dateStr} (${tx.amount} Kč) byl spárován.`,
  );
  return { matched: true, type: 'HOME_FEE', matchId: match.id, teamId: match.homeTeamId, amount: tx.amount };
}

/** Pošle oznámení všem vedoucím týmu. */
async function notifyTeamManagers(teamId, title, body) {
  try {
    const managers = await prisma.manager.findMany({
      where:  { teamId },
      select: { userId: true },
    });
    for (const m of managers) {
      await sendNotification(m.userId, title, body, 'payments');
    }
  } catch (_) {}
}

async function sendNotification(userId, title, body, screen) {
  try {
    const { createNotification } = require('../routes/notifications');
    await createNotification(userId, title, body, screen);
  } catch (_) {}
}

// ==================== QR PLATBA ====================

/**
 * Vrátí data pro generování QR kódu platby (formát SPAYD pro ČR).
 * Frontend z toho vygeneruje QR pomocí např. qrcode.js.
 */
async function getPaymentQR(type, id) {
  const IBAN   = process.env.BANK_IBAN;   // CZ6508000000192000145399
  const BIC    = process.env.BANK_BIC;    // GIBACZPX (ČSOB, GE Money…)

  if (!IBAN) throw new Error('BANK_IBAN není nastaven');

  let vs, amount, message;

  if (type === 'player-license') {
    const payment = await prisma.playerPayment.findUnique({
      where:   { playerId: id },
      include: { player: { select: { firstName: true, lastName: true } } },
    });
    vs      = await ensurePlayerVS(id, 'PLAYER_LICENSE');
    amount  = payment.licFee;
    message = `FSL licence ${payment.player.firstName} ${payment.player.lastName}`;
  } else if (type === 'super-license') {
    const payment = await prisma.playerPayment.findUnique({
      where:   { playerId: id },
      include: { player: { select: { firstName: true, lastName: true } } },
    });
    vs      = await ensurePlayerVS(id, 'SUPER_LICENSE');
    amount  = payment.superFee;
    message = `FSL superlicence ${payment.player.firstName} ${payment.player.lastName}`;
  } else if (type === 'team-reg') {
    const payment = await prisma.teamPayment.findUnique({
      where:   { teamId: id },
      include: { team: { select: { name: true } } },
    });
    vs      = await ensureTeamVS(id, 'TEAM_REG');
    amount  = payment.amount;
    message = `FSL registrace ${payment.team.name}`;
  } else if (type === 'home-fee') {
    // id = matchId (každý domácí zápas má vlastní VS)
    const match = await prisma.match.findUnique({
      where:   { id },
      include: { homeTeam: { select: { name: true } } },
    });
    if (!match) throw new Error('Zápas nenalezen');
    vs      = await ensureMatchHomeFeeVS(id);
    amount  = HOME_FEE_AMOUNT;
    message = `FSL domaci zapas ${new Date(match.date).toLocaleDateString('cs-CZ')} ${match.homeTeam.name}`;
  } else {
    throw new Error('Neznámý typ platby');
  }

  // SPAYD formát (Short Payment Descriptor) – standard pro ČR QR platby
  const spayd = [
    'SPD*1.0',
    `ACC:${IBAN}${BIC ? `+${BIC}` : ''}`,
    `AM:${amount}.00`,
    'CC:CZK',
    `X-VS:${vs}`,
    `MSG:${message}`,
  ].join('*');

  return { spayd, vs, amount, iban: IBAN, message };
}

module.exports = {
  bankSync,
  ensurePlayerVS,
  ensureTeamVS,
  ensureMatchHomeFeeVS,
  getPaymentQR,
  matchTransaction, // exportováno kvůli testům párování
};
