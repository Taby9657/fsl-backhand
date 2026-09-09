-- Brankář vs. hráč do pole na soupisce týmu.
--
-- Dosud se to nikde neevidovalo. Jediné, co k postu existuje, je volný text
-- `Player.position` s výchozí hodnotou „Útočník" — a ten je nejednotný:
-- registrační formuláře do něj zapisují česká slova (Brankář / Obránce /
-- Útočník), zatímco mapy v appce a ve webu počítají s kódy (GK / F / D),
-- draft navíc přidává „Univerzál". Zjistit z databáze, kdo je brankář,
-- tedy spolehlivě nešlo.
--
-- Příznak patří na soupisku, ne na hráče: tentýž člověk může být v jednom
-- týmu gólman a ve druhém hráč do pole, a strop „12 do pole + 2 brankáři"
-- se hlídá právě na téhle tabulce.
--
-- Migrace nic nemaže. Nový sloupec je NOT NULL DEFAULT 'FIELD', takže
-- staré řádky projdou beze změny; brankáři se dopočítají z `Player.position`
-- podle obou slovníků najednou.

CREATE TYPE "RosterSlot" AS ENUM ('GOALKEEPER', 'FIELD');

ALTER TABLE "TeamRoster"
  ADD COLUMN "slot" "RosterSlot" NOT NULL DEFAULT 'FIELD';

CREATE INDEX "TeamRoster_teamId_season_slot_idx"
  ON "TeamRoster"("teamId", "season", "slot");

-- ── Dopočet stávajících dat ─────────────────────────────────────────────
-- `unaccent` nemusí být v databázi nainstalovaný, proto se diakritika
-- neřeší rozšířením, ale výčtem tvarů, které se v datech reálně vyskytují.

UPDATE "TeamRoster" tr
   SET "slot" = 'GOALKEEPER'
  FROM "Player" p
 WHERE p."id" = tr."playerId"
   AND lower(btrim(p."position")) IN ('gk', 'g', 'b', 'brankář', 'brankar', 'goalkeeper', 'goalie');
