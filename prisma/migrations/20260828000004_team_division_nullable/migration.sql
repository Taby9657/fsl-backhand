-- Divize týmu je nově volitelná.
--
-- Při registraci ani při schvalování supervisor ještě neví, do jaké divize
-- tým patří — rozhoduje se to až při rozlosování. Do té doby je tým
-- "nezařazený". Existující týmy si svoji divizi ponechají.

ALTER TABLE "Team" ALTER COLUMN "division" DROP NOT NULL;
ALTER TABLE "Team" ALTER COLUMN "division" DROP DEFAULT;
