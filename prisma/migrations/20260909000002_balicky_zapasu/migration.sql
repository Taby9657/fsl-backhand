-- Balíčky zápasů: zápasy si platí hráč, ne tým.
--
-- Dosud platil poplatek za zápas tým (2 200 Kč za domácí zápas, `Match.homeFee*`)
-- a vedoucí to po hráčích sháněl. Nově si každý kupuje balíček startů a odehraný
-- zápas z něj jeden odečte — v klubovém i v otevřeném týmu stejně.
--
-- Balíček patří hráči, ne týmu: kdo hostuje ve třech týmech, čerpá pořád
-- z jednoho pytle.
--
-- Odečítá se dvoufázově, jako u platební karty:
--   zařazení do sestavy start REZERVUJE  (MatchEntry.status = RESERVED)
--   odehraný zápas ho ZÚČTUJE           (SPENT)
--   zrušený nebo kontumovaný ho VRÁTÍ   (RELEASED)
-- Bez rezervace by hráč s jedním zaplaceným zápasem mohl být naráz
-- v sestavě tří.
--
-- Nevyužité starty se přenášejí do playoff i do dalších sezón. `validUntil`
-- je tu proto, aby šlo platnost omezit bez další migrace — prodaný a
-- nevyčerpaný balíček je závazek, který jinak z účetnictví nikdy nezmizí.
--
-- Migrace nic neruší: `Match.homeFee*` zůstává, dokud nedoběhne rozehraná
-- sezóna. Vypnutí starého poplatku je samostatný krok.

CREATE TYPE "EntryStatus" AS ENUM ('RESERVED', 'SPENT', 'RELEASED');

-- Otevřený tým — jednotlivci bez živého vedoucího.
ALTER TABLE "Team" ADD COLUMN "isOpen" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MatchPack" (
    "id"             TEXT NOT NULL,
    "playerId"       TEXT NOT NULL,
    "season"         TEXT NOT NULL,
    "size"           INTEGER NOT NULL,
    "remaining"      INTEGER NOT NULL,
    "validUntil"     TEXT,
    "isReward"       BOOLEAN NOT NULL DEFAULT false,
    "price"          INTEGER NOT NULL,
    "status"         "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAmount"     INTEGER NOT NULL DEFAULT 0,
    "paidAt"         TIMESTAMP(3),
    "method"         TEXT,
    "stripeId"       TEXT,
    "sessionId"      TEXT,
    "variableSymbol" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchPack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchPack_variableSymbol_key" ON "MatchPack"("variableSymbol");
CREATE INDEX "MatchPack_playerId_season_idx"        ON "MatchPack"("playerId", "season");
CREATE INDEX "MatchPack_playerId_season_status_idx" ON "MatchPack"("playerId", "season", "status");

ALTER TABLE "MatchPack" ADD CONSTRAINT "MatchPack_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MatchEntry" (
    "id"        TEXT NOT NULL,
    "playerId"  TEXT NOT NULL,
    "matchId"   TEXT NOT NULL,
    "teamId"    TEXT NOT NULL,
    "packId"    TEXT,
    "status"    "EntryStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "MatchEntry_pkey" PRIMARY KEY ("id")
);

-- Za jeden zápas se hráči nesmí strhnout dvakrát.
CREATE UNIQUE INDEX "MatchEntry_playerId_matchId_key" ON "MatchEntry"("playerId", "matchId");
CREATE INDEX "MatchEntry_matchId_status_idx"  ON "MatchEntry"("matchId", "status");
CREATE INDEX "MatchEntry_playerId_status_idx" ON "MatchEntry"("playerId", "status");

ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchEntry" ADD CONSTRAINT "MatchEntry_packId_fkey"
  FOREIGN KEY ("packId") REFERENCES "MatchPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Doporučovací kódy ───────────────────────────────────────────────────
-- Kdo přivede nového hráče, dostane jeden zápas zdarma. Odměna se vyplácí
-- teprve tehdy, když si nový hráč koupí balíček od tří zápasů výš.

CREATE TABLE "ReferralCode" (
    "id"        TEXT NOT NULL,
    "code"      TEXT NOT NULL,
    "playerId"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralCode_code_key"     ON "ReferralCode"("code");
CREATE UNIQUE INDEX "ReferralCode_playerId_key" ON "ReferralCode"("playerId");
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReferralUse" (
    "id"           TEXT NOT NULL,
    "codeId"       TEXT NOT NULL,
    "newPlayerId"  TEXT NOT NULL,
    "rewardPackId" TEXT,
    "rewardedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralUse_pkey" PRIMARY KEY ("id")
);
-- Jeden člověk může být „přivedený" jen jednou.
CREATE UNIQUE INDEX "ReferralUse_newPlayerId_key"  ON "ReferralUse"("newPlayerId");
CREATE UNIQUE INDEX "ReferralUse_rewardPackId_key" ON "ReferralUse"("rewardPackId");
CREATE INDEX        "ReferralUse_codeId_idx"       ON "ReferralUse"("codeId");
ALTER TABLE "ReferralUse" ADD CONSTRAINT "ReferralUse_codeId_fkey"
  FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralUse" ADD CONSTRAINT "ReferralUse_newPlayerId_fkey"
  FOREIGN KEY ("newPlayerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralUse" ADD CONSTRAINT "ReferralUse_rewardPackId_fkey"
  FOREIGN KEY ("rewardPackId") REFERENCES "MatchPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;
