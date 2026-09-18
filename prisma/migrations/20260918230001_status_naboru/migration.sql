-- Kdy naposledy odešel status náboru. Bez tohohle sloupce by se po každém
-- restartu Railway ve slotu poslal další stejný e-mail.
ALTER TABLE "Settings" ADD COLUMN "statusNaboruPoslanoAt" TIMESTAMP(3);
