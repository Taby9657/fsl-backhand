/**
 * Košík — víc poplatků, jedna platba.
 *
 * ── Proč vůbec ──────────────────────────────────────────────────────────
 * Stripe si u české karty bere **1,5 % + 6,50 Kč**. Ta pevná část se platí
 * za každou transakci zvlášť, takže licence a balíček koupené odděleně stojí
 * ligu o 6,50 Kč víc než totéž najednou. U převodu je úspora ještě větší:
 * jeden variabilní symbol se spáruje jednou a nestojí nic.
 *
 * ── Co do košíku patří ──────────────────────────────────────────────────
 * Licence, superlicence, balíček startů a registrace týmu. **Pokuta za
 * kontumaci ne** — ta týmu blokuje další zápas, takže se řeší hned a zvlášť.
 *
 * ── Kdo za koho platí ───────────────────────────────────────────────────
 * Vlastník košíku platí. Koho se položka týká, říká `playerId` / `teamId`,
 * takže vedoucí může zaplatit licenci i balíček svým hráčům. Kontrolu
 * oprávnění dělá routa, ne tenhle soubor.
 *
 * ── Zaúčtování ──────────────────────────────────────────────────────────
 * Zápis je všude přes `updateMany` s podmínkou „ještě není zaplaceno".
 * Když podmínka neprojde, je to dvojí platba — položka se přeskočí a vrátí
 * se v `dvoji`, aby to viděl supervisor. Stejné pravidlo jako u jednotlivých
 * plateb; kdyby se tady odpustilo, druhá platba by tiše přepsala první.
 */

const prisma = require('../lib/prisma');
const kredit = require('./kredit');

/** Položky, které se v jednom košíku nesmí opakovat (dvakrát licence nedává smysl). */
const JEDNOU = ['PLAYER_LICENSE', 'SUPER_LICENSE', 'TEAM_REG'];

/** Lidsky čitelný název položky — do Stripe, do QR i do přehledu. */
function nazev(item) {
  switch (item.kind) {
    case 'PLAYER_LICENSE': return 'Hráčská licence';
    case 'SUPER_LICENSE':  return 'Superlicence';
    case 'TEAM_REG':       return 'Registrace týmu';
    case 'MATCH_PACK':     return `Balíček ${item.packSize} ${sklonuj(item.packSize)}`;
    default:               return 'Poplatek';
  }
}

function sklonuj(n) {
  if (n === 1) return 'zápas';
  if (n >= 2 && n <= 4) return 'zápasy';
  return 'zápasů';
}

/** Otevřený košík uživatele, nebo null. */
async function otevreny(userId, tx = prisma) {
  return tx.cart.findFirst({
    where:   { userId, status: 'PENDING' },
    include: { items: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Otevřený košík, a když žádný není, tak nový. */
async function zaloz(userId, season, tx = prisma) {
  const uz = await otevreny(userId, tx);
  if (uz) return uz;
  const novy = await tx.cart.create({ data: { userId, season } });
  return { ...novy, items: [] };
}

/** Součet položek. Cena se drží na položce, ne v ceníku — viz schema. */
function soucet(items) {
  return (items ?? []).reduce((s, i) => s + i.amount, 0);
}

/**
 * Přidá položku. Vrací `{ ok, code, item }`; `ok: false` znamená, že se
 * položka nepřidala a `code` říká proč.
 */
async function pridej(userId, season, data, tx = prisma) {
  const cart = await zaloz(userId, season, tx);

  if (JEDNOU.includes(data.kind)) {
    const uz = (cart.items ?? []).find(
      i => i.kind === data.kind
        && (i.playerId ?? null) === (data.playerId ?? null)
        && (i.teamId ?? null) === (data.teamId ?? null),
    );
    if (uz) return { ok: false, code: 'ALREADY_IN_CART', item: uz };
  }

  const item = await tx.cartItem.create({
    data: {
      cartId:   cart.id,
      kind:     data.kind,
      playerId: data.playerId ?? null,
      teamId:   data.teamId ?? null,
      packSize: data.packSize ?? null,
      amount:   data.amount,
      season:   data.season ?? season ?? null,
    },
  });

  return { ok: true, item, cartId: cart.id };
}

/** Odebere položku z otevřeného košíku. Zaplacený košík se nemění. */
async function odeber(userId, itemId, tx = prisma) {
  const item = await tx.cartItem.findUnique({
    where:   { id: itemId },
    include: { cart: true },
  });
  if (!item) return { ok: false, code: 'NOT_FOUND' };
  if (item.cart.userId !== userId) return { ok: false, code: 'FORBIDDEN' };
  if (item.cart.status !== 'PENDING') return { ok: false, code: 'ALREADY_PAID' };

  await tx.cartItem.delete({ where: { id: itemId } });
  return { ok: true };
}

// ==================== ZAÚČTOVÁNÍ ====================

/**
 * Zaúčtuje jednu položku. Vrací `true`, když se zapsala, `false`, když už
 * bylo zaplaceno (dvojí platba).
 */
async function zauctujPolozku(item, { method, stripeId }, tx = prisma) {
  const spolecne = { method, ...(stripeId ? { stripeId } : {}) };

  if (item.kind === 'PLAYER_LICENSE') {
    const zapis = await tx.playerPayment.updateMany({
      where: { playerId: item.playerId, licStatus: { not: 'PAID' } },
      data:  { licStatus: 'PAID', licPaidAt: new Date(), licPaidAmount: item.amount, ...spolecne },
    });
    if (zapis.count === 0) return false;
    await tx.player.update({ where: { id: item.playerId }, data: { licensed: true } });
    return true;
  }

  if (item.kind === 'SUPER_LICENSE') {
    const zapis = await tx.playerPayment.updateMany({
      where: { playerId: item.playerId, superStatus: { not: 'PAID' } },
      data:  {
        superStatus: 'PAID', superPaidAt: new Date(), superLic: true,
        superPaidAmount: item.amount, ...spolecne,
      },
    });
    return zapis.count > 0;
  }

  if (item.kind === 'TEAM_REG') {
    // Registrace se platí každou sezónu znovu, takže starý zaplacený řádek
    // z minulého ročníku se přepisuje — jinak by nová sezóna zůstala
    // navždycky „zaplacená" z té předchozí.
    const soucasna = await tx.teamPayment.findUnique({ where: { teamId: item.teamId } });
    const sezona   = item.season || soucasna?.season || null;
    const zeStare  = !!soucasna && sezona && soucasna.season !== sezona;
    const kde      = zeStare
      ? { teamId: item.teamId, season: soucasna.season }
      : { teamId: item.teamId, status: { not: 'PAID' } };

    const zapis = await tx.teamPayment.updateMany({
      where: kde,
      data:  {
        status: 'PAID', paidAt: new Date(), paidAmount: item.amount,
        ...(sezona ? { season: sezona } : {}), ...spolecne,
      },
    });
    return zapis.count > 0;
  }

  if (item.kind === 'MATCH_PACK') {
    // Balíček vzniká až tady, ne při vložení do košíku. Kdyby vznikal dřív,
    // musel by se při vyhození z košíku zase mazat — a kdyby se to nepovedlo,
    // zůstal by v přehledu nezaplacený balíček, který si nikdo neobjednal.
    const pack = await tx.matchPack.create({
      data: {
        playerId:   item.playerId,
        season:     item.season,
        size:       item.packSize,
        remaining:  item.packSize,
        price:      item.amount,
        status:     'PAID',
        paidAt:     new Date(),
        paidAmount: item.amount,
        ...spolecne,
      },
    });
    await kredit.odmenZaDoporuceni(pack.playerId, pack, tx);
    return true;
  }

  return false;
}

/**
 * Zaúčtuje celý košík. Idempotentní: druhé zavolání na zaplacený košík
 * neudělá nic a vrátí `uzBylo: true`.
 */
async function zauctuj(cartId, { method, stripeId, castka }) {
  return prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({
      where:   { id: cartId },
      include: { items: true },
    });
    if (!cart) return { ok: false, code: 'NOT_FOUND' };
    if (cart.status === 'PAID') return { ok: true, uzBylo: true, cart };

    const dvoji = [];
    for (const item of cart.items) {
      const zapsano = await zauctujPolozku(item, { method, stripeId }, tx);
      if (!zapsano) dvoji.push(item);
    }

    const hotovy = await tx.cart.update({
      where: { id: cartId },
      data:  {
        status:     'PAID',
        paidAt:     new Date(),
        paidAmount: castka ?? soucet(cart.items),
        amount:     soucet(cart.items),
        method,
        ...(stripeId ? { stripeId } : {}),
      },
    });

    return { ok: true, uzBylo: false, cart: hotovy, items: cart.items, dvoji };
  });
}

/**
 * Vrácení celého košíku. Volá se z `charge.refunded`.
 *
 * Vrátit se dá jen celá platba, protože Stripe refunduje charge, ne řádek —
 * a košík je jedna charge. Každá položka se proto vrací do nezaplaceného
 * stavu. U balíčku se ruší zbytek startů, ale **odehrané zápasy se nevracejí**:
 * kdyby se vracely, kontroloval by kredit sestavu zpětně a zápasy odehrané
 * „na dluh" by nešlo srovnat.
 *
 * Vrací seznam balíčků, ze kterých se už stihlo hrát — na to musí supervisor
 * vidět.
 */
async function vrat(cartId) {
  return prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({
      where:   { id: cartId },
      include: { items: true },
    });
    if (!cart || cart.status === 'REFUNDED') return { ok: false, code: 'NOT_FOUND' };

    const vycerpane = [];

    for (const item of cart.items) {
      if (item.kind === 'PLAYER_LICENSE') {
        await tx.playerPayment.updateMany({
          where: { playerId: item.playerId },
          data:  {
            licStatus: 'PENDING', licPaidAt: null, licMethod: null,
            licPaidAmount: 0, stripeId: null, licSessionId: null,
          },
        });
        await tx.player.update({ where: { id: item.playerId }, data: { licensed: false } });
      } else if (item.kind === 'SUPER_LICENSE') {
        await tx.playerPayment.updateMany({
          where: { playerId: item.playerId },
          data:  {
            superStatus: 'PENDING', superPaidAt: null, superLic: false,
            superPaidAmount: 0, superSessionId: null,
          },
        });
      } else if (item.kind === 'TEAM_REG') {
        await tx.teamPayment.updateMany({
          where: { teamId: item.teamId },
          data:  {
            status: 'PENDING', paidAt: null, method: null,
            paidAmount: 0, stripeId: null, sessionId: null,
          },
        });
      } else if (item.kind === 'MATCH_PACK') {
        // Balíček vznikl až při zaúčtování, takže ho hledáme podle košíku.
        const packs = await tx.matchPack.findMany({
          where: { playerId: item.playerId, stripeId: cart.stripeId, size: item.packSize },
        });
        for (const pack of packs) {
          // Spočítat dřív, než se `remaining` vynuluje — po zápisu už není
          // z čeho poznat, kolik startů se stihlo odehrát.
          const vycerpano = pack.size - pack.remaining;
          await tx.matchPack.update({
            where: { id: pack.id },
            data:  { status: 'REFUNDED', remaining: 0, paidAmount: 0, sessionId: null },
          });
          if (vycerpano > 0) {
            vycerpane.push({ packId: pack.id, playerId: pack.playerId, vycerpano });
          }
        }
      }
    }

    await tx.cart.update({
      where: { id: cartId },
      data:  { status: 'REFUNDED', paidAmount: 0, sessionId: null },
    });

    return { ok: true, vycerpane };
  });
}

module.exports = {
  JEDNOU, nazev, sklonuj, otevreny, zaloz, soucet, pridej, odeber,
  zauctuj, zauctujPolozku, vrat,
};
