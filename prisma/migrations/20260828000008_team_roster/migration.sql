-- Soupiska týmu na sezónu.
--
-- Dosud měl hráč jediný tým (`Player.teamId`), takže „hráč se superlicencí je
-- na soupiskách až tří týmů" nešlo vůbec zapsat. Nově je členství samostatný
-- záznam vázaný na sezónu: kmenový tým má isHome = true, hostování false.
--
-- Migrace nic nemaže — `Player.teamId` zůstává jako kmenový tým a překlopí se
-- do soupisky aktuální sezóny.

CREATE TABLE "TeamRoster" (
    "id"        TEXT NOT NULL,
    "playerId"  TEXT NOT NULL,
    "teamId"    TEXT NOT NULL,
    "season"    TEXT NOT NULL,
    "isHome"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamRoster_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamRoster_playerId_teamId_season_key" ON "TeamRoster"("playerId", "teamId", "season");
CREATE INDEX "TeamRoster_teamId_season_idx"   ON "TeamRoster"("teamId", "season");
CREATE INDEX "TeamRoster_playerId_season_idx" ON "TeamRoster"("playerId", "season");

ALTER TABLE "TeamRoster" ADD CONSTRAINT "TeamRoster_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamRoster" ADD CONSTRAINT "TeamRoster_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Převod stávajících dat ──────────────────────────────────────────────
-- Každý hráč, který má tým, dostane kmenový řádek v aktuální sezóně.

DO $$
DECLARE
  akt_sezona TEXT;
BEGIN
  SELECT COALESCE(
    (SELECT "season" FROM "Match" ORDER BY "createdAt" DESC LIMIT 1),
    '2025/26'
  ) INTO akt_sezona;

  INSERT INTO "TeamRoster" ("id", "playerId", "teamId", "season", "isHome")
  SELECT gen_random_uuid()::text, p."id", p."teamId", akt_sezona, true
    FROM "Player" p
   WHERE p."teamId" IS NOT NULL;
END $$;
