-- Zprávy supervisorovi jdou nově i od nepřihlášených lidí z webu.
-- Proto se ke každé ukládá kontaktní e-mail a stránka, ze které přišla.
ALTER TABLE "SupervisorRequest" ADD COLUMN "email" TEXT;
ALTER TABLE "SupervisorRequest" ADD COLUMN "page" TEXT;

-- Kategorie podle toho, co člověk řeší. Staré hodnoty zůstávají — zprávy,
-- které už v databázi jsou, se nesmí rozbít.
ALTER TYPE "RequestType" ADD VALUE 'WEB_BUG';
ALTER TYPE "RequestType" ADD VALUE 'REGISTRATION';
ALTER TYPE "RequestType" ADD VALUE 'PAYMENT';
ALTER TYPE "RequestType" ADD VALUE 'ROSTER';
