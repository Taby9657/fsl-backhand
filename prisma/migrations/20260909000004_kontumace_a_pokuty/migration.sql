-- Kontumace a pokuty.
--
-- Kontumaci dosud nešlo zaznamenat: `MatchStatus` zná jen UPCOMING, LIVE,
-- DONE a CANCELLED, takže „nedostavil se soupeř" nemělo kam. U otevřených
-- týmů složených z cizích lidí je přitom nedostavení řádově pravděpodobnější
-- než u party kamarádů.
--
-- Kontumovaný zápas zůstává DONE se skóre 5:0 a nese jen značku
-- `forfeitTeamId`. Tabulka se tak dopočítá sama a nemusí o kontumaci vědět;
-- statistiky hráčů si ji naopak musí odfiltrovat, protože se nehrálo.
--
-- Trest má dvě části:
--   1. hráčům viníka propadnou starty (MatchEntry → SPENT), soupeři se vrátí
--   2. tým dostane pokutu 2 200 Kč ve výši ušlého zápasného
--
-- Plochá pokuta je tu schválně. Kdyby se počítala z propadlých startů,
-- tým, kterému se do sestavy nikdo nepřihlásil, by nezaplatil nic — tedy
-- právě ten, kdo zápas zmařil nejvíc.
--
-- REFUNDED ve stavu platby je oddělené od WAIVED: odpuštěná platba se nikdy
-- nevybrala, vrácená ano. Bez toho nešlo v databázi poznat, že balíček
-- zápasů byl proplacen zpátky a kredit z něj musí zmizet.

ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

ALTER TABLE "Match" ADD COLUMN IF NOT EXISTS "forfeitTeamId" TEXT;

CREATE TABLE IF NOT EXISTS "Fine" (
    "id"             TEXT NOT NULL,
    "teamId"         TEXT NOT NULL,
    "matchId"        TEXT NOT NULL,
    "season"         TEXT NOT NULL,
    "amount"         INTEGER NOT NULL DEFAULT 2200,
    "reason"         TEXT NOT NULL,
    "status"         "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAmount"     INTEGER NOT NULL DEFAULT 0,
    "paidAt"         TIMESTAMP(3),
    "method"         TEXT,
    "stripeId"       TEXT,
    "sessionId"      TEXT,
    "variableSymbol" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Fine_matchId_key"        ON "Fine"("matchId");
CREATE UNIQUE INDEX IF NOT EXISTS "Fine_variableSymbol_key" ON "Fine"("variableSymbol");
CREATE INDEX IF NOT EXISTS "Fine_teamId_status_idx"         ON "Fine"("teamId", "status");
CREATE INDEX IF NOT EXISTS "Fine_season_idx"                ON "Fine"("season");

ALTER TABLE "Fine" ADD CONSTRAINT "Fine_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Fine" ADD CONSTRAINT "Fine_matchId_fkey"
    FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
