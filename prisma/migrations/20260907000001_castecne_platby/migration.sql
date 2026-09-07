-- Kolik už na danou platbu doopravdy přišlo.
--
-- Do teď se párovala jen platba v plné výši: kdo poslal 200 Kč místo 250,
-- dostal `nedostatečná částka` a jeho převod se nikde nezapsal. Doplatek
-- 50 Kč pak dopadl stejně, protože se pořád porovnával proti celé částce.
-- Takový člověk zůstal napořád nezaplacený a peníze ležely na účtu ligy
-- bez majitele.
--
-- Nově se každá příchozí částka připíše sem a teprve součet se porovnává
-- s předepsaným poplatkem. Platba se označí za zaplacenou ve chvíli, kdy
-- součet poplatek pokryje.
--
-- Sloupce jsou NOT NULL DEFAULT 0, takže migrace nic nepřepisuje a starým
-- řádkům jen doplní nulu. U už zaplacených řádků se dopočítá předepsaná
-- částka, ať součet odpovídá skutečnosti.

ALTER TABLE "PlayerPayment" ADD COLUMN "licPaidAmount"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlayerPayment" ADD COLUMN "superPaidAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TeamPayment"   ADD COLUMN "paidAmount"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Match"         ADD COLUMN "homeFeePaidAmount" INTEGER NOT NULL DEFAULT 0;

UPDATE "PlayerPayment" SET "licPaidAmount"   = "licFee"   WHERE "licStatus"   = 'PAID';
UPDATE "PlayerPayment" SET "superPaidAmount" = "superFee" WHERE "superStatus" = 'PAID';
UPDATE "TeamPayment"   SET "paidAmount"      = "amount"   WHERE "status"      = 'PAID';
UPDATE "Match"         SET "homeFeePaidAmount" = 2200     WHERE "homeFeePaid" = true;
