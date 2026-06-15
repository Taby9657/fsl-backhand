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

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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
 */
async function ensurePlayerVS(playerId, type = 'PLAYER_LICENSE') {
  const payment = await prisma.playerPayment.findUnique({ where: { playerId } });
  if (!payment) throw new Error('PlayerPayment nenalezen');
  if (payment.variableSymbol) return payment.variableSymbol;

  // Sekvence = pořadí záznamu (PlayerPayment.id je UUID → použijeme rowNumber)
  const count = await prisma.playerPayment.count();
  const vs    = generateVS(type, count + 1);

  await prisma.playerPayment.update({
    where: { playerId },
    data:  { variableSymbol: vs },
  });
  return vs;
}

/**
 * Přidělí VS týmu a vrátí ho.
 */
async function ensureTeamVS(teamId, type = 'TEAM_REG') {
  const payment = await prisma.teamPayment.findUnique({ where: { teamId } });
  if (!payment) throw new Error('TeamPayment nenalezen');
  if (payment.variableSymbol) return payment.variableSymbol;

  const count = await prisma.teamPayment.count();
  const vs    = generateVS(type, count + 1);

  await prisma.teamPayment.update({
    where: { teamId },
    data:  { variableSymbol: vs },
  });
  return vs;
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

  // 1. Zkus hráčskou licenci
  const playerPayment = await prisma.playerPayment.findUnique({
    where:   { variableSymbol: vs },
    include: { player: { select: { id: true, firstName: true, lastName: true, userId: true } } },
  });

  if (playerPayment) {
    const type = inferPlayerPaymentType(vs);

    if (type === 'PLAYER_LICENSE' && playerPayment.licStatus !== 'PAID') {
      if (tx.amount < playerPayment.licFee) {
        return { matched: false, reason: `nedostatečná částka (přišlo ${tx.amount}, požadováno ${playerPayment.licFee})` };
      }
      await prisma.playerPayment.update({
        where: { variableSymbol: vs },
        data:  { licStatus: 'PAID', licPaidAt: tx.date, licMethod: 'bank' },
      });
      await prisma.player.update({
        where: { id: playerPayment.playerId },
        data:  { licensed: true },
      });
      await sendNotification(playerPayment.player.userId, 'Platba přijata', `Licenční poplatek ${tx.amount} Kč byl spárován.`, 'payments');
      return { matched: true, type: 'PLAYER_LICENSE', playerId: playerPayment.playerId, amount: tx.amount };
    }

    if (type === 'SUPER_LICENSE' && playerPayment.superStatus !== 'PAID') {
      if (tx.amount < playerPayment.superFee) {
        return { matched: false, reason: `nedostatečná částka pro superlicenci` };
      }
      await prisma.playerPayment.update({
        where: { variableSymbol: vs },
        data:  { superStatus: 'PAID', superPaidAt: tx.date, superLic: true },
      });
      await sendNotification(playerPayment.player.userId, 'Platba přijata', `Super licence ${tx.amount} Kč zaplacena.`, 'payments');
      return { matched: true, type: 'SUPER_LICENSE', playerId: playerPayment.playerId, amount: tx.amount };
    }

    return { matched: false, reason: 'platba již evidována jako PAID' };
  }

  // 2. Zkus týmovou platbu
  const teamPayment = await prisma.teamPayment.findUnique({
    where:   { variableSymbol: vs },
    include: { team: true },
  });

  if (teamPayment) {
    if (teamPayment.status === 'PAID') {
      return { matched: false, reason: 'týmová platba již zaplacena' };
    }
    if (tx.amount < teamPayment.amount) {
      return { matched: false, reason: `nedostatečná částka (přišlo ${tx.amount}, požadováno ${teamPayment.amount})` };
    }
    await prisma.teamPayment.update({
      where: { variableSymbol: vs },
      data:  { status: 'PAID', paidAt: tx.date, method: 'bank' },
    });
    return { matched: true, type: 'TEAM_REG', teamId: teamPayment.teamId, amount: tx.amount };
  }

  return { matched: false, reason: 'variabilní symbol nenalezen v databázi' };
}

function inferPlayerPaymentType(vs) {
  if (vs.startsWith('1')) return 'PLAYER_LICENSE';
  if (vs.startsWith('2')) return 'SUPER_LICENSE';
  return 'PLAYER_LICENSE';
}

async function sendNotification(userId, title, body, screen) {
  try {
    await prisma.notification.create({ data: { userId, title, body, screen } });
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
    const payment = await prisma.teamPayment.findUnique({
      where:   { teamId: id },
      include: { team: { select: { name: true } } },
    });
    vs      = await ensureTeamVS(id, 'HOME_FEE');
    amount  = 2200;
    message = `FSL domaci zapas ${payment.team.name}`;
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

module.exports = { bankSync, ensurePlayerVS, ensureTeamVS, getPaymentQR };
