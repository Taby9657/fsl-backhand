-- Soutěžní struktura: liga → konference → divize, zařazení týmu na sezónu.
--
-- Dosud byly divize a konference jen textová pole na týmu, takže nešlo mít
-- víc lig, ani držet historii po postupu. Nově jsou to entity vázané na sezónu.
--
-- Migrace nic nemaže: existující týmy se převedou do jedné ligy aktuální
-- sezóny a jejich dosavadní textové divize se stanou skutečnými divizemi.

CREATE TABLE "League" (
    "id"        TEXT NOT NULL,
    "season"    TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "level"     INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "League_season_name_key" ON "League"("season", "name");
CREATE INDEX "League_season_level_idx" ON "League"("season", "level");

CREATE TABLE "Conference" (
    "id"       TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    CONSTRAINT "Conference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conference_leagueId_name_key" ON "Conference"("leagueId", "name");
ALTER TABLE "Conference" ADD CONSTRAINT "Conference_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Division" (
    "id"           TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Division_conferenceId_name_key" ON "Division"("conferenceId", "name");
ALTER TABLE "Division" ADD CONSTRAINT "Division_conferenceId_fkey"
  FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TeamSeason" (
    "id"           TEXT NOT NULL,
    "teamId"       TEXT NOT NULL,
    "season"       TEXT NOT NULL,
    "leagueId"     TEXT NOT NULL,
    "conferenceId" TEXT,
    "divisionId"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamSeason_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamSeason_teamId_season_key" ON "TeamSeason"("teamId", "season");
CREATE INDEX "TeamSeason_season_leagueId_idx" ON "TeamSeason"("season", "leagueId");
ALTER TABLE "TeamSeason" ADD CONSTRAINT "TeamSeason_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamSeason" ADD CONSTRAINT "TeamSeason_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamSeason" ADD CONSTRAINT "TeamSeason_conferenceId_fkey"
  FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamSeason" ADD CONSTRAINT "TeamSeason_divisionId_fkey"
  FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Zápasy se nově vážou na strukturu; textová divize zůstává pro staré záznamy
ALTER TABLE "Match" ADD COLUMN "leagueId"     TEXT;
ALTER TABLE "Match" ADD COLUMN "conferenceId" TEXT;
ALTER TABLE "Match" ADD COLUMN "divisionId"   TEXT;
ALTER TABLE "Match" ADD CONSTRAINT "Match_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_conferenceId_fkey"
  FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_divisionId_fkey"
  FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Převod stávajících dat ──────────────────────────────────────────────
-- Vezmeme sezónu z posledního zápasu (jinak 2025/26), založíme v ní jednu
-- ligu a do ní překlopíme týmy i s jejich dosavadními textovými divizemi.

DO $$
DECLARE
  akt_sezona   TEXT;
  liga_id      TEXT;
  konference_id TEXT;
  r            RECORD;
  divize_id    TEXT;
BEGIN
  SELECT COALESCE(
    (SELECT "season" FROM "Match" ORDER BY "createdAt" DESC LIMIT 1),
    '2025/26'
  ) INTO akt_sezona;

  -- Nemá smysl zakládat ligu, když v systému není jediný tým
  IF NOT EXISTS (SELECT 1 FROM "Team") THEN
    RETURN;
  END IF;

  liga_id := gen_random_uuid()::text;
  INSERT INTO "League" ("id", "season", "name", "level")
  VALUES (liga_id, akt_sezona, 'FSL Liga', 1);

  -- Konference vzniká jen tehdy, měl-li nějaký tým vyplněnou divizi
  IF EXISTS (SELECT 1 FROM "Team" WHERE "division" IS NOT NULL AND "division" <> '') THEN
    konference_id := gen_random_uuid()::text;
    INSERT INTO "Conference" ("id", "leagueId", "name")
    VALUES (konference_id, liga_id, 'Hlavní');

    FOR r IN
      SELECT DISTINCT "division" AS nazev
        FROM "Team"
       WHERE "division" IS NOT NULL AND "division" <> ''
    LOOP
      INSERT INTO "Division" ("id", "conferenceId", "name")
      VALUES (gen_random_uuid()::text, konference_id, r.nazev);
    END LOOP;
  END IF;

  FOR r IN SELECT "id", "division" FROM "Team" LOOP
    divize_id := NULL;
    IF r."division" IS NOT NULL AND r."division" <> '' THEN
      SELECT d."id" INTO divize_id
        FROM "Division" d
       WHERE d."conferenceId" = konference_id AND d."name" = r."division";
    END IF;

    INSERT INTO "TeamSeason" ("id", "teamId", "season", "leagueId", "conferenceId", "divisionId")
    VALUES (
      gen_random_uuid()::text, r."id", akt_sezona, liga_id,
      CASE WHEN divize_id IS NULL THEN NULL ELSE konference_id END,
      divize_id
    );
  END LOOP;

  -- Staré zápasy přiřadíme do té jedné ligy, ať filtry fungují i zpětně
  UPDATE "Match" SET "leagueId" = liga_id WHERE "season" = akt_sezona;
END $$;

-- Indexy pro filtrování zápasů podle struktury
CREATE INDEX "Match_leagueId_idx"     ON "Match"("leagueId");
CREATE INDEX "Match_conferenceId_idx" ON "Match"("conferenceId");
CREATE INDEX "Match_divisionId_idx"   ON "Match"("divisionId");
