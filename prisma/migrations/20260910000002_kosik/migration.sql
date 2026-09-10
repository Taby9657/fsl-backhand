-- Košík: víc poplatků, jedna platba.
--
-- Důvod jsou poplatky platební brány. Stripe si u české karty bere
-- 1,5 % + 6,50 Kč, a ta pevná část se platí za každou transakci zvlášť.
-- Licence (300) a balíček šestnácti zápasů (2 600) koupené odděleně stojí
-- ligu 4,50 + 6,50 a 39,00 + 6,50 = 56,50 Kč. Totéž v jedné platbě stojí
-- 43,50 + 6,50 = 50,00 Kč. U převodu se ušetří ještě víc: jeden variabilní
-- symbol se spáruje jednou a nestojí nic.
--
-- Pokuta za kontumaci do košíku schválně nepatří. Blokuje týmu další zápas,
-- takže se musí zaplatit hned a zvlášť — kdyby čekala, až si někdo vybere
-- balíček, stála by ligu zápas.
--
-- Variabilní symboly: 1 licence, 2 superlicence, 3 registrace týmu,
-- 5 pokuta, 7 balíček, **8 košík**. Prefix 4 patřil zrušenému poplatku
-- za domácí zápas a nerecykluje se.

CREATE TYPE "CartItemKind" AS ENUM ('PLAYER_LICENSE', 'SUPER_LICENSE', 'MATCH_PACK', 'TEAM_REG');

CREATE TABLE "Cart" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "season"         TEXT NOT NULL,
    "status"         "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount"         INTEGER NOT NULL DEFAULT 0,
    "paidAmount"     INTEGER NOT NULL DEFAULT 0,
    "paidAt"         TIMESTAMP(3),
    "method"         TEXT,
    "stripeId"       TEXT,
    "sessionId"      TEXT,
    "variableSymbol" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Cart_variableSymbol_key" ON "Cart"("variableSymbol");
CREATE INDEX "Cart_userId_status_idx" ON "Cart"("userId", "status");

ALTER TABLE "Cart" ADD CONSTRAINT "Cart_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CartItem" (
    "id"        TEXT NOT NULL,
    "cartId"    TEXT NOT NULL,
    "kind"      "CartItemKind" NOT NULL,
    "playerId"  TEXT,
    "teamId"    TEXT,
    "packSize"  INTEGER,
    "amount"    INTEGER NOT NULL,
    "season"    TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CartItem_cartId_idx" ON "CartItem"("cartId");

ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey"
  FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
