-- Pravidla superlicence: fáze zápasu + volba týmů pro playoff.
--
-- Dosud nebylo v datech poznat, jestli je zápas ze základní části nebo z playoff,
-- takže „pavouk" jen seskupoval zápasy podle čísla kola. Bez toho rozdílu nejde
-- vynutit, že hráč smí v playoff nastupovat jen za vybrané týmy.

CREATE TYPE "MatchPhase" AS ENUM ('REGULAR', 'PLAYOFF');

ALTER TABLE "Match" ADD COLUMN "phase" "MatchPhase" NOT NULL DEFAULT 'REGULAR';
CREATE INDEX "Match_season_phase_idx" ON "Match"("season", "phase");

-- Volba primárního a sekundárního týmu pro playoff
CREATE TABLE "PlayoffChoice" (
    "id"              TEXT NOT NULL,
    "playerId"        TEXT NOT NULL,
    "season"          TEXT NOT NULL,
    "primaryTeamId"   TEXT NOT NULL,
    "secondaryTeamId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlayoffChoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayoffChoice_playerId_season_key" ON "PlayoffChoice"("playerId", "season");
CREATE INDEX "PlayoffChoice_season_idx" ON "PlayoffChoice"("season");

ALTER TABLE "PlayoffChoice" ADD CONSTRAINT "PlayoffChoice_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayoffChoice" ADD CONSTRAINT "PlayoffChoice_primaryTeamId_fkey"
  FOREIGN KEY ("primaryTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlayoffChoice" ADD CONSTRAINT "PlayoffChoice_secondaryTeamId_fkey"
  FOREIGN KEY ("secondaryTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Pozdní příchody: hráč doplněný do sestavy až za běhu zápasu zůstane označený
ALTER TABLE "LineupPlayer" ADD COLUMN "addedLate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LineupPlayer" ADD COLUMN "addedAt"   TIMESTAMP(3);
