-- Klasické přihlášení e-mailem a heslem vedle Google a Apple.
--
-- Sloupec je nullable: účty založené přes Google nebo Apple heslo nemají
-- a přihlašují se dál svým poskytovatelem.

ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
