-- Přihláška týmu do sezóny + explicitní aktuální sezóna.
--
-- Dvě věci, které spolu souvisí:
--
-- 1. Aktuální sezóna se dosud odvozovala ze sezóny posledního založeného zápasu.
--    Určovala ji tedy testovací data a přepnout se dala jen přechodem sezóny.
--    Nově je uložená v tabulce Settings a supervisor ji umí nastavit.
--
-- 2. TeamSeason vznikal až při zařazení do ligy, takže „tým je přihlášený do
--    sezóny, ale ještě nemá ligu" nešlo zapsat. leagueId je proto volitelné
--    a přihláška vzniká rovnou při registraci týmu.

-- ── Nastavení ligy ──────────────────────────────────────────────────────
CREATE TABLE "Settings" (
    "id"            TEXT NOT NULL,
    "currentSeason" TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- ── Přihláška bez ligy ──────────────────────────────────────────────────
ALTER TABLE "TeamSeason" DROP CONSTRAINT "TeamSeason_leagueId_fkey";
ALTER TABLE "TeamSeason" ALTER COLUMN "leagueId" DROP NOT NULL;
ALTER TABLE "TeamSeason" ADD CONSTRAINT "TeamSeason_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Převod stávajících dat ──────────────────────────────────────────────
-- Aktuální sezónu zapíšeme podle dosavadní logiky, ať se nic nezmění pod rukama.
-- Zároveň přihlásíme do téhle sezóny každý tým, který v ní ještě přihlášku nemá —
-- jinak by po nasazení týmy z ligy zmizely.

DO $$
DECLARE
  akt_sezona TEXT;
BEGIN
  SELECT COALESCE(
    (SELECT "season" FROM "Match" ORDER BY "createdAt" DESC LIMIT 1),
    '2025/26'
  ) INTO akt_sezona;

  INSERT INTO "Settings" ("id", "currentSeason", "updatedAt")
  VALUES ('singleton', akt_sezona, CURRENT_TIMESTAMP);

  INSERT INTO "TeamSeason" ("id", "teamId", "season", "leagueId", "createdAt")
  SELECT gen_random_uuid()::text, t."id", akt_sezona, NULL, CURRENT_TIMESTAMP
    FROM "Team" t
   WHERE NOT EXISTS (
     SELECT 1 FROM "TeamSeason" ts
      WHERE ts."teamId" = t."id" AND ts."season" = akt_sezona
   );
END $$;
