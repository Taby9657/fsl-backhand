-- Supervisor jako příznak na uživateli.
--
-- Do teď se organizátor ligy určoval dvěma způsoby:
--   1. Player.isSupervisor — funguje jen pro supervisora, který je zároveň hráč
--   2. env SUPERVISOR_USER_IDS — vyžaduje redeploy backendu při každé změně
--
-- Nově má supervisora na sobě přímo User, takže se dá přidávat a odebírat
-- za běhu z aplikace. Env proměnná zůstává funkční jako záchranná brzda
-- pro případ, že by se všichni supervisoři omylem odebrali.

ALTER TABLE "User" ADD COLUMN "isSupervisor" BOOLEAN NOT NULL DEFAULT false;

-- Převzetí stávajících supervisorů z hráčských profilů.
UPDATE "User" u
   SET "isSupervisor" = true
  FROM "Player" p
 WHERE p."userId" = u.id
   AND p."isSupervisor" = true;

-- Bootstrap prvního organizátora ligy (dosud držený v SUPERVISOR_USER_IDS).
-- Bez něj by po nasazení neexistoval nikdo, kdo může supervisory spravovat.
UPDATE "User"
   SET "isSupervisor" = true
 WHERE id = 'b5da41d7-fd52-471a-ac7a-16dfb85a92e6';
