-- Zdraví párování bankovních převodů.
--
-- Do 10. 9. 2026 se selhání párování jen zalogovalo do konzole Railway.
-- Když `FIO_API_TOKEN` chyběl, převody se od 28. 8. nepárovaly jedenáct dní
-- a nikdo se to nedozvěděl: lidem peníze odešly, licence zůstaly nezaplacené
-- a jediná stopa byla řádka v logu, kam se nikdo nedívá.
--
-- Tichý výpadek je u peněz horší než hlasitá chyba. Tyhle sloupce drží
-- poslední úspěch, poslední chybu a délku série selhání — supervisor to vidí
-- na nástěnce a při každém selhání mu přijde oznámení.

ALTER TABLE "Settings" ADD COLUMN "bankSyncLastOkAt"    TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "bankSyncLastErrorAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "bankSyncLastError"   TEXT;
ALTER TABLE "Settings" ADD COLUMN "bankSyncFailStreak"  INTEGER NOT NULL DEFAULT 0;
