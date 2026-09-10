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
 *   Tým  – pokuta za kontumaci: 5 + 7místné číslo (prefix 5)
 *   Hráč – balíček zápasů: 7 + 7místné číslo (prefix 7)
 *   Košík (víc poplatků naráz): 8 + 7místné číslo (prefix 8)
 *
 * Prefix 4 je vysloužilý a nerecykluje se.
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
    // Prefix 4 je vysloužilý a schválně se nerecykluje — kdyby dorazil
    // starý převod, ať skončí mezi nespárovanými a někdo se na něj podívá.
    FINE:           5,
    MATCH_PACK:     7,
    // Košík: víc poplatků v jedné platbě. Jeden VS, jedno spárování,
    // nulový poplatek — proto košík vůbec vznikl.
    CART:           8,
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

    // Počítáme jen už PŘIDĚLENÉ symboly, ne všechny platební řádky. S count()
    // přes celou tabulku se pořadové číslo nehýbe, takže každý další hráč
    // potřeboval o jeden retry víc a pátý narazil na strop pěti pokusů.
    const count = await prisma.playerPayment.count({ where: { [field]: { not: null } } });
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

    // Stejný důvod jako u hráčů – jen už přidělené symboly.
    const count = await prisma.teamPayment.count({ where: { variableSymbol: { not: null } } });
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
 * Přidělí VS konkrétnímu balíčku zápasů.
 * VS je na balíčku, ne na hráči — jeden člověk si jich za sezónu koupí víc
 * a každý převod musí jít spárovat se svým balíčkem.
 */
async function ensurePackVS(packId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pack = await prisma.matchPack.findUnique({ where: { id: packId } });
    if (!pack) throw new Error('Balíček nenalezen');
    if (pack.variableSymbol) return pack.variableSymbol;

    const count = await prisma.matchPack.count({ where: { variableSymbol: { not: null } } });
    const vs    = generateVS('MATCH_PACK', count + 1 + attempt);
    try {
      await prisma.matchPack.update({ where: { id: packId }, data: { variableSymbol: vs } });
      return vs;
    } catch (err) {
      if (err.code !== 'P2002' || attempt >= 4) throw err;
    }
  }
}

/**
 * Přidělí VS pokutě za kontumaci.
 */
async function ensureFineVS(fineId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const fine = await prisma.fine.findUnique({ where: { id: fineId } });
    if (!fine) throw new Error('Pokuta nenalezena');
    if (fine.variableSymbol) return fine.variableSymbol;

    const count = await prisma.fine.count({ where: { variableSymbol: { not: null } } });
    const vs    = generateVS('FINE', count + 1 + attempt);
    try {
      await prisma.fine.update({ where: { id: fineId }, data: { variableSymbol: vs } });
      return vs;
    } catch (err) {
      if (err.code !== 'P2002' || attempt >= 4) throw err;
    }
  }
}

/**
 * Přidělí VS košíku. Prefix 8 — jedna platba za víc poplatků naráz.
 */
async function ensureCartVS(cartId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cart = await prisma.cart.findUnique({ where: { id: cartId } });
    if (!cart) throw new Error('Košík nenalezen');
    if (cart.variableSymbol) return cart.variableSymbol;

    const count = await prisma.cart.count({ where: { variableSymbol: { not: null } } });
    const vs    = generateVS('CART', count + 1 + attempt);
    try {
      await prisma.cart.update({ where: { id: cartId }, data: { variableSymbol: vs } });
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
 * Fio posílá datum jako `2026-09-01+0200` – ISO datum plus offset, bez času.
 * `new Date()` na tenhle tvar vrací **Invalid Date**. Neošetřené by to shodilo
 * zápis do BankTransaction, transakce by se neuložila, každou noc se zkusila
 * znovu a nikdy by se nespárovala.
 */
function parseFioDate(raw) {
  if (!raw) return new Date();

  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})(?:([+-])(\d{2}):?(\d{2}))?/);
  if (m) {
    const [, den, znak, hh, mm] = m;
    const offset = znak ? `${znak}${hh}:${mm}` : 'Z';
    const d = new Date(`${den}T00:00:00${offset}`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
}

/**
 * Normalizuje Fio transakci do jednoduchého objektu.
 * Fio vrací každé pole jako { value, name, id } nebo null.
 */
function parseTransaction(raw) {
  const get = (key) => raw[key]?.value ?? null;

  const amount = get('column1');   // Objem (záporný = odchozí)
  if (!amount || amount <= 0) return null; // zajímají nás jen příchozí

  const id = get('column22');      // ID pohybu
  if (!id) return null;            // bez ID nejde hlídat duplicity – radši přeskočit

  return {
    transactionId:  String(id),
    amount:         Math.round(amount),
    variableSymbol: String(get('column5') ?? '').trim() || null,
    senderAccount:  get('column2'),
    senderName:     get('column10'),
    date:           parseFioDate(get('column0')),
    message:        get('column16') ?? '',
  };
}

// ==================== PÁROVÁNÍ ====================

/**
 * Vypadá chyba na problém s tokenem?
 *
 * Fio na neplatný nebo vypršelý token odpovídá 401/403; chybějící token
 * zachytáváme sami dřív, než se kamkoli sáhne. Rozlišujeme to proto, aby
 * oznámení supervisorovi rovnou řeklo, co s tím — „obnov token ve Fiu" je
 * něco jiného než „Fio je dole".
 */
function jeChybaTokenu(err) {
  const t = String(err?.message ?? '');
  return /FIO_API_TOKEN není nastaven/.test(t) || /Fio API chyba (401|403)/.test(t);
}

/**
 * Zapíše, jak dopadl běh párování, a při selhání se ozve supervisorovi.
 *
 * **Tichý výpadek je u peněz horší než hlasitá chyba.** Když `FIO_API_TOKEN`
 * chyběl, převody se od 28. 8. do 10. 9. 2026 nepárovaly jedenáct dní a jediná
 * stopa byla řádka v logu Railway, kam se nikdo nedívá. Lidem přitom peníze
 * odešly a licence zůstaly nezaplacené.
 *
 * Oznámení chodí při **každém** selhání. Když párování běží jednou denně, je
 * to nejvýš jedna zpráva za den — a dokud je rozbité, má se o tom vědět.
 */
async function zapisZdravi(chyba) {
  const ted = new Date();
  try {
    if (!chyba) {
      await prisma.settings.upsert({
        where:  { id: 'singleton' },
        create: { id: 'singleton', bankSyncLastOkAt: ted, bankSyncFailStreak: 0, bankSyncLastError: null },
        update: { bankSyncLastOkAt: ted, bankSyncFailStreak: 0, bankSyncLastError: null },
      });
      return;
    }

    const stav = await prisma.settings.upsert({
      where:  { id: 'singleton' },
      create: {
        id: 'singleton', bankSyncLastErrorAt: ted,
        bankSyncLastError: String(chyba.message ?? chyba).slice(0, 500),
        bankSyncFailStreak: 1,
      },
      update: {
        bankSyncLastErrorAt: ted,
        bankSyncLastError: String(chyba.message ?? chyba).slice(0, 500),
        bankSyncFailStreak: { increment: 1 },
      },
    });

    const kolikrat = stav?.bankSyncFailStreak ?? 1;
    const posledniOk = stav?.bankSyncLastOkAt
      ? `Naposledy to prošlo ${new Date(stav.bankSyncLastOkAt).toLocaleString('cs-CZ')}.`
      : 'Od nasazení to neprošlo ani jednou.';

    await ohlasSupervisorum(
      'Párování převodů nefunguje',
      (jeChybaTokenu(chyba)
        ? 'Fio nepustilo backend k výpisu — token nejspíš vypršel, byl smazaný, '
          + 'nebo chybí. Založ nový ve Fiu (Nastavení → API, práva „Pouze sledovat '
          + 'účet") a přepiš ho v Railway do proměnné FIO_API_TOKEN. '
        : 'Párování bankovních převodů selhalo. ')
      + `Selhalo ${kolikrat}× po sobě. ${posledniOk} `
      + `Chyba: ${String(chyba.message ?? chyba).slice(0, 200)}. `
      + 'Do opravy se převody nespárují — platby dorazí na účet, ale licence '
      + 'a balíčky zůstanou nezaplacené.',
    );
  } catch (err) {
    // Zápis zdraví nesmí shodit samotné párování.
    console.error('[BankSync] Stav párování se nepodařilo zapsat:', err.message);
  }
}

/**
 * Poslední známý stav párování — pro nástěnku supervisora.
 *
 * `zdrave: false` znamená, že poslední běh selhal. `lastOkAt: null` s nulovou
 * sérií znamená, že párování ještě nikdy neběželo.
 */
async function stavParovani() {
  const s = await prisma.settings.findUnique({ where: { id: 'singleton' } });
  const selhani = s?.bankSyncFailStreak ?? 0;
  return {
    zdrave:      selhani === 0,
    lastOkAt:    s?.bankSyncLastOkAt ?? null,
    lastErrorAt: s?.bankSyncLastErrorAt ?? null,
    lastError:   s?.bankSyncLastError ?? null,
    failStreak:  selhani,
    tokenSet:    !!FIO_TOKEN,
  };
}

/**
 * Hlavní funkce – stáhne transakce a spáruje je s platbami.
 * Vrací přehled výsledků.
 */
async function bankSync(days = 30) {
  let transactions;
  try {
    transactions = await fetchFioTransactions(days);
  } catch (err) {
    // Zapiš a ohlas, ale chybu nepolykej — ruční spuštění musí vidět, co se
    // stalo, a noční úloha ji zaloguje.
    await zapisZdravi(err);
    throw err;
  }
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

  // Doběhlo to. Sérii selhání tím nulujeme a supervisor přestane dostávat
  // oznámení — tichý úspěch je v pořádku, tichý výpadek ne.
  await zapisZdravi(null);
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

  // 4. Pokuta za kontumaci (prefix 5)
  const fine = await prisma.fine.findUnique({
    where:   { variableSymbol: vs },
    include: { team: { select: { id: true, name: true, abbr: true } } },
  });
  if (fine) return payFine(fine, tx);

  // 5. Balíček zápasů (prefix 7)
  const pack = await prisma.matchPack.findUnique({
    where:   { variableSymbol: vs },
    include: { player: { select: { id: true, firstName: true, lastName: true, userId: true } } },
  });
  if (pack) return payMatchPack(pack, tx);

  // 6. Košík (prefix 8) — víc poplatků v jedné platbě
  const cart = await prisma.cart.findUnique({
    where:   { variableSymbol: vs },
    include: { items: true, user: { select: { id: true } } },
  });
  if (cart) return payCart(cart, tx);

  return { matched: false, reason: 'variabilní symbol nenalezen v databázi' };
}

// ---------- jednotlivé typy plateb ----------

async function payPlayerLicense(payment, tx) {
  if (payment.licStatus === 'PAID') {
    return { matched: false, reason: 'licence již evidována jako zaplacená' };
  }

  const zaplaceno = (payment.licPaidAmount ?? 0) + tx.amount;

  if (zaplaceno < payment.licFee) {
    // Částečná platba: připíšeme ji a čekáme na doplatek. Dřív se takový
    // převod zahodil a člověk zůstal napořád nezaplacený.
    const pripsano = await prisma.playerPayment.updateMany({
      where: { id: payment.id, licStatus: { not: 'PAID' } },
      data:  { licPaidAmount: zaplaceno, licMethod: 'bank' },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
    }
    const chybi = payment.licFee - zaplaceno;
    await sendNotification(
      payment.player.userId,
      'Přijata částečná platba',
      `Přišlo ${tx.amount} Kč, celkem evidujeme ${zaplaceno} z ${payment.licFee} Kč. Do zaplacení licence chybí ${chybi} Kč.`,
      'payments',
    );
    return castecna('PLAYER_LICENSE', { playerId: payment.playerId }, tx, zaplaceno, payment.licFee);
  }

  // Atomický update se WHERE podmínkou: zabrání race condition při souběžném zpracování
  const updated = await prisma.playerPayment.updateMany({
    where: { id: payment.id, licStatus: { not: 'PAID' } },
    data:  { licStatus: 'PAID', licPaidAt: tx.date, licMethod: 'bank', licPaidAmount: zaplaceno },
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
  await hlidejPreplatek('licence', zaplaceno, payment.licFee, tx);
  return {
    matched: true, type: 'PLAYER_LICENSE', playerId: payment.playerId,
    amount: tx.amount, paidTotal: zaplaceno,
  };
}

async function paySuperLicense(payment, tx) {
  if (payment.superStatus === 'PAID') {
    return { matched: false, reason: 'superlicence již evidována jako zaplacená' };
  }

  const zaplaceno = (payment.superPaidAmount ?? 0) + tx.amount;

  if (zaplaceno < payment.superFee) {
    const pripsano = await prisma.playerPayment.updateMany({
      where: { id: payment.id, superStatus: { not: 'PAID' } },
      data:  { superPaidAmount: zaplaceno },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'superlicence právě zpracována jiným procesem (race condition)' };
    }
    const chybi = payment.superFee - zaplaceno;
    await sendNotification(
      payment.player.userId,
      'Přijata částečná platba',
      `Přišlo ${tx.amount} Kč, celkem evidujeme ${zaplaceno} z ${payment.superFee} Kč. Do zaplacení superlicence chybí ${chybi} Kč.`,
      'payments',
    );
    return castecna('SUPER_LICENSE', { playerId: payment.playerId }, tx, zaplaceno, payment.superFee);
  }

  const updated = await prisma.playerPayment.updateMany({
    where: { id: payment.id, superStatus: { not: 'PAID' } },
    data:  { superStatus: 'PAID', superPaidAt: tx.date, superLic: true, superPaidAmount: zaplaceno },
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
  await hlidejPreplatek('superlicence', zaplaceno, payment.superFee, tx);
  return {
    matched: true, type: 'SUPER_LICENSE', playerId: payment.playerId,
    amount: tx.amount, paidTotal: zaplaceno,
  };
}

async function payTeamRegistration(payment, tx) {
  // Registrace se platí každou sezónu znovu, ale `TeamPayment` je jeden řádek
  // na tým. Řádek z minulé sezóny proto neznamená, že je zaplaceno teď —
  // jinak by tým, který zaplatil loni, o poplatek letos nikdy nepožádal.
  const sezona     = await aktualniSezonaBezpecne();
  const zeStare    = jeZeStareSezony(payment, sezona);
  const jizPrislo  = zeStare ? 0 : (payment.paidAmount ?? 0);
  const novaSezona = zeStare ? { season: sezona } : {};

  // Při přeúčtování na novou sezónu se na starý řádek nedá vázat podmínkou
  // `status not PAID` (starý řádek PAID je) — hlídáme tedy sezónu, na kterou
  // jsme se dívali. Kdyby ji mezitím přepsal jiný proces, update neprojde.
  const kde = zeStare
    ? { id: payment.id, season: payment.season }
    : { id: payment.id, status: { not: 'PAID' } };

  if (payment.status === 'PAID' && !zeStare) {
    return { matched: false, reason: 'týmová platba již zaplacena' };
  }
  if (payment.status === 'WAIVED' && !zeStare) {
    return { matched: false, reason: 'poplatek za registraci je odpuštěn' };
  }

  const zaplaceno = jizPrislo + tx.amount;

  if (zaplaceno < payment.amount) {
    const pripsano = await prisma.teamPayment.updateMany({
      where: kde,
      data:  { ...novaSezona, status: 'PENDING', paidAmount: zaplaceno, method: 'bank' },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'týmová platba právě zpracována jiným procesem (race condition)' };
    }
    const chybi = payment.amount - zaplaceno;
    await notifyTeamManagers(
      payment.teamId,
      'Přijata částečná platba',
      `Přišlo ${tx.amount} Kč, celkem evidujeme ${zaplaceno} z ${payment.amount} Kč. Do zaplacení registrace chybí ${chybi} Kč.`,
    );
    return castecna('TEAM_REG', { teamId: payment.teamId }, tx, zaplaceno, payment.amount);
  }

  const updated = await prisma.teamPayment.updateMany({
    where: kde,
    data:  { ...novaSezona, status: 'PAID', paidAt: tx.date, method: 'bank', paidAmount: zaplaceno },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'týmová platba právě zpracována jiným procesem (race condition)' };
  }

  await notifyTeamManagers(
    payment.teamId,
    'Platba přijata',
    `Registrační poplatek ${tx.amount} Kč byl spárován.`,
  );
  await hlidejPreplatek('registrace týmu', zaplaceno, payment.amount, tx);
  return {
    matched: true, type: 'TEAM_REG', teamId: payment.teamId,
    amount: tx.amount, paidTotal: zaplaceno, ...(zeStare ? { season: sezona } : {}),
  };
}

// ---------- částečné platby a přeplatky ----------

/**
 * Výsledek pro připsanou, ale zatím nedostatečnou platbu.
 *
 * `matched: true` je tu schválně: transakci jsme přiřadili konkrétní platbě
 * a připsali ji, takže nepatří mezi nespárované. Že poplatek ještě není
 * pokrytý, nese `partial` a `missing`.
 */
function castecna(type, klic, tx, zaplaceno, potreba) {
  return {
    matched: true,
    partial: true,
    type,
    ...klic,
    amount:    tx.amount,
    paidTotal: zaplaceno,
    missing:   potreba - zaplaceno,
    reason:    `částečná platba (celkem ${zaplaceno} z ${potreba} Kč, chybí ${potreba - zaplaceno})`,
  };
}

/** Přeplatek supervisor uvidí — sám se nevrací, musí ho někdo poslat zpátky. */
async function hlidejPreplatek(co, zaplaceno, potreba, tx) {
  if (zaplaceno <= potreba) return;
  await ohlasSupervisorum(
    'Přeplatek',
    `Na ${co} přišlo celkem ${zaplaceno} Kč místo ${potreba} Kč `
    + `(poslední převod ${tx.amount} Kč, VS ${tx.variableSymbol}). Přeplatek ${zaplaceno - potreba} Kč je potřeba vrátit.`,
  );
}

/** Aktuální sezóna; když ji nejde zjistit, radši nic nepřepočítáváme. */
async function aktualniSezonaBezpecne() {
  try {
    const { currentSeason } = require('./seasonTransition');
    return await currentSeason();
  } catch (_) {
    return null;
  }
}

/** Je platební řádek z jiné (starší) sezóny, než ve které jsme teď? */
function jeZeStareSezony(payment, sezona) {
  return !!sezona && !!payment.season && payment.season !== sezona;
}

/** Oznámení všem supervisorům – používá se u přeplatků a dvojích plateb. */
async function ohlasSupervisorum(title, body) {
  try {
    const supervisori = await prisma.user.findMany({
      where:  { isSupervisor: true },
      select: { id: true },
    });
    for (const u of supervisori) {
      await sendNotification(u.id, title, body, 'payments');
    }
  } catch (err) {
    console.error('Oznámení supervisorům selhalo:', err.message);
  }
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
  const IBAN   = process.env.BANK_IBAN;   // ucet ligy – nastaveny jen v prostredi
  const BIC    = process.env.BANK_BIC;

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
  } else if (type === 'fine') {
    // id = fineId (jedna kontumace = jedna pokuta)
    const fine = await prisma.fine.findUnique({
      where:   { id },
      include: { team: { select: { name: true } } },
    });
    if (!fine) throw new Error('Pokuta nenalezena');
    vs      = await ensureFineVS(id);
    amount  = fine.amount;
    message = `FSL pokuta kontumace ${fine.team.name}`;
  } else if (type === 'match-pack') {
    // id = packId (každý koupený balíček má vlastní VS). Převodem je balíček
    // bez poplatku — u dvacítky za 3 000 Kč to proti kartě dělá 51,50 Kč.
    const pack = await prisma.matchPack.findUnique({
      where:   { id },
      include: { player: { select: { firstName: true, lastName: true } } },
    });
    if (!pack) throw new Error('Balíček nenalezen');
    vs      = await ensurePackVS(id);
    amount  = pack.price;
    message = `FSL balicek ${pack.size} zapasu ${pack.player.firstName} ${pack.player.lastName}`;
  } else if (type === 'cart') {
    // id = cartId. Celý košík má jeden VS a jednu částku — tohle je nejlevnější
    // cesta, jakou liga má: převod nestojí nic, a jde jich přes jeden příkaz víc.
    const cart = await prisma.cart.findUnique({
      where:   { id },
      include: { items: true },
    });
    if (!cart) throw new Error('Košík nenalezen');
    if (cart.items.length === 0) throw new Error('Košík je prázdný');
    const kosik = require('./kosik');
    vs      = await ensureCartVS(id);
    amount  = kosik.soucet(cart.items);
    message = `FSL platba ${cart.items.length} polozek`;
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

  return { spayd, vs, amount, iban: IBAN, bic: BIC || null, message };
}

/**
 * Balíček zápasů zaplacený převodem.
 *
 * Kredit vzniká teprve při plné částce — částečná platba se připíše
 * a čeká na doplatek, stejně jako u ostatních poplatků.
 */
/**
 * Pokuta za kontumaci zaplacená převodem.
 *
 * Dokud není zaplacená celá, tým další zápas nerozehraje — proto se
 * částečná platba připisuje stejně jako u ostatních poplatků a vedoucí
 * se dozví, kolik chybí. Jinak by čekal, že už může hrát.
 */
async function payFine(fine, tx) {
  if (fine.status === 'PAID' || fine.status === 'WAIVED') {
    return { matched: false, reason: 'pokuta už je vyřízená' };
  }

  const zaplaceno = (fine.paidAmount ?? 0) + tx.amount;

  if (zaplaceno < fine.amount) {
    const pripsano = await prisma.fine.updateMany({
      where: { id: fine.id, status: { notIn: ['PAID', 'WAIVED'] } },
      data:  { paidAmount: zaplaceno, method: 'bank' },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'pokuta právě zpracována jiným procesem (race condition)' };
    }
    const chybi = fine.amount - zaplaceno;
    await notifyTeamManagers(
      fine.teamId,
      'Pokuta — chybí doplatek',
      `Přijali jsme ${tx.amount} Kč, celkem evidujeme ${zaplaceno} z ${fine.amount} Kč. `
      + `Chybí ${chybi} Kč — do zaplacení celé částky zápas rozhodčí nespustí.`,
    );
    return castecna('FINE', { fineId: fine.id, teamId: fine.teamId }, tx, zaplaceno, fine.amount);
  }

  const updated = await prisma.fine.updateMany({
    where: { id: fine.id, status: { notIn: ['PAID', 'WAIVED'] } },
    data:  { status: 'PAID', paidAt: new Date(), method: 'bank', paidAmount: zaplaceno },
  });
  if (updated.count === 0) {
    return { matched: false, reason: 'pokuta právě zpracována jiným procesem (race condition)' };
  }

  await notifyTeamManagers(
    fine.teamId,
    'Pokuta je zaplacená',
    `${tx.amount} Kč jsme spárovali. Tým může znovu nastoupit.`,
  );
  await hlidejPreplatek(`pokuta ${fine.team?.abbr ?? ''}`, zaplaceno, fine.amount, tx);

  return { matched: true, type: 'FINE', fineId: fine.id, teamId: fine.teamId, amount: tx.amount };
}

async function payMatchPack(pack, tx) {
  if (pack.status === 'PAID') {
    return { matched: false, reason: 'balíček už evidujeme jako zaplacený' };
  }

  const zaplaceno = (pack.paidAmount ?? 0) + tx.amount;

  if (zaplaceno < pack.price) {
    const pripsano = await prisma.matchPack.updateMany({
      where: { id: pack.id, status: { not: 'PAID' } },
      data:  { paidAmount: zaplaceno, method: 'bank' },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
    }
    const chybi = pack.price - zaplaceno;
    await sendNotification(
      pack.player?.userId,
      'Balíček zápasů — chybí doplatek',
      `Přijali jsme ${tx.amount} Kč. Do zaplacení balíčku (${pack.size} zápasů) chybí ${chybi} Kč.`,
    );
    return { matched: true, partial: true, missing: chybi, type: 'MATCH_PACK' };
  }

  const zaplacen = await prisma.matchPack.updateMany({
    where: { id: pack.id, status: { not: 'PAID' } },
    data:  {
      status: 'PAID', paidAt: new Date(), method: 'bank', paidAmount: zaplaceno,
    },
  });
  if (zaplacen.count === 0) {
    return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
  }

  await sendNotification(
    pack.player?.userId,
    'Balíček zápasů je zaplacený',
    `${pack.size} ${pack.size === 1 ? 'zápas je' : 'zápasů je'} připraveno k použití.`,
  );

  // Kdo tohohle hráče přivedl do ligy, dostane zápas zdarma.
  const { odmenZaDoporuceni } = require('./kredit');
  await odmenZaDoporuceni(pack.playerId, pack);

  if (zaplaceno > pack.price) {
    await ohlasSupervisorum(
      'Přeplatek u balíčku zápasů',
      `${pack.player?.firstName ?? ''} ${pack.player?.lastName ?? ''} poslal `
      + `${zaplaceno} Kč místo ${pack.price} Kč.`,
    );
  }

  return { matched: true, type: 'MATCH_PACK' };
}

/**
 * Převod na košík.
 *
 * Košík je nedělitelný: dokud nepřijde celá částka, **nezaúčtuje se nic**.
 * Rozpouštět částečnou platbu po položkách by znamenalo rozhodovat za
 * plátce, co chtěl zaplatit dřív — a u licence a balíčku to není jedno,
 * protože bez licence hráč stejně nenastoupí.
 */
async function payCart(cart, tx) {
  if (cart.status === 'PAID') {
    return { matched: false, reason: 'košík už evidujeme jako zaplacený' };
  }

  const kosik   = require('./kosik');
  const potreba = kosik.soucet(cart.items);
  const zaplaceno = (cart.paidAmount ?? 0) + tx.amount;

  if (zaplaceno < potreba) {
    const pripsano = await prisma.cart.updateMany({
      where: { id: cart.id, status: { not: 'PAID' } },
      data:  { paidAmount: zaplaceno, method: 'bank' },
    });
    if (pripsano.count === 0) {
      return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
    }
    await sendNotification(
      cart.userId,
      'Platba — chybí doplatek',
      `Přijali jsme ${tx.amount} Kč. Do zaplacení celé objednávky chybí ${potreba - zaplaceno} Kč. `
      + 'Položky se aktivují, až dorazí celá částka.',
    );
    return castecna('CART', { cartId: cart.id }, tx, zaplaceno, potreba);
  }

  const vysledek = await kosik.zauctuj(cart.id, { method: 'bank', castka: zaplaceno });
  if (!vysledek.ok || vysledek.uzBylo) {
    return { matched: false, reason: 'platba právě zpracována jiným procesem (race condition)' };
  }

  await sendNotification(
    cart.userId,
    'Platba je zaplacená',
    `Přijali jsme ${zaplaceno} Kč. ${cart.items.length} ${cart.items.length === 1 ? 'položka je' : 'položky jsou'} vyřízené.`,
  );

  for (const item of vysledek.dvoji ?? []) {
    await ohlasSupervisorum(
      'Dvojí platba',
      `V zaplaceném košíku ${cart.id} byla položka „${kosik.nazev(item)}" (${item.amount} Kč), `
      + 'která už byla zaplacená jinak. Peníze je potřeba vrátit.',
    );
  }

  await hlidejPreplatek(`košík ${cart.id}`, zaplaceno, potreba, tx);
  return { matched: true, type: 'CART', cartId: cart.id };
}

module.exports = {
  bankSync,
  stavParovani,   // nástěnka supervisora — aby tichý výpadek nebyl možný
  jeChybaTokenu,  // exportováno kvůli testům
  ensureCartVS,
  ensurePlayerVS,
  ensureTeamVS,
  ensurePackVS,
  ensureFineVS,
  getPaymentQR,
  ohlasSupervisorum, // dvojí platby hlásí i Stripe webhook
  jeZeStareSezony,   // sdílí ho webhook i endpoint registrace týmu
  matchTransaction,  // exportováno kvůli testům párování
  parseTransaction,  // dtto – hlídá se tvar data z Fio
};
