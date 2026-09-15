-- Balík „Virtuální vedoucí" — vstup jednotlivce do soutěže bez týmu.
--
-- 800 Kč = startovné 500 + hráčská licence 300, účtované jako jedna položka.
-- Licence se uvnitř drží zvlášť (entryFee / licFee), aby se nezaplatila
-- dvakrát: kdo ji na sezónu už má, platí 500 a licFee je nula.
--
-- Platí se košíkem jako každý jiný poplatek, tedy variabilním symbolem
-- s prefixem 8. Prefix 6, který návrh otevřených týmů sliboval, zůstává
-- nepoužitý a rezervovaný — samostatná platební cesta mimo košík by šla
-- proti tomu, kvůli čemu košík vznikl (jedna transakce, jeden poplatek
-- bráně, jeden variabilní symbol).
--
-- Zařazení do otevřeného týmu, pořadník a dvojice tahle migrace neřeší.

ALTER TYPE "CartItemKind" ADD VALUE 'OPEN_ENTRY';

CREATE TABLE "OpenEntry" (
    "id"         TEXT NOT NULL,
    "playerId"   TEXT NOT NULL,
    "season"     TEXT NOT NULL,
    "slot"       "RosterSlot" NOT NULL DEFAULT 'FIELD',
    "entryFee"   INTEGER NOT NULL DEFAULT 500,
    "licFee"     INTEGER NOT NULL DEFAULT 300,
    "status"     "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "paidAt"     TIMESTAMP(3),
    "method"     TEXT,
    "stripeId"   TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpenEntry_playerId_season_key" ON "OpenEntry"("playerId", "season");
CREATE INDEX "OpenEntry_season_status_idx" ON "OpenEntry"("season", "status");

ALTER TABLE "OpenEntry" ADD CONSTRAINT "OpenEntry_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
