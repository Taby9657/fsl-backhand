-- Aktualizace výše poplatků pro sezónu 2025/26.
--
--   hráčská licence   300 Kč -> 250 Kč
--   super licence     300 Kč -> 250 Kč
--   registrace týmu 10 000 Kč -> 8 000 Kč
--
-- Poplatek za domácí zápas (2 200 Kč) se nemění.
--
-- Mění se jak DEFAULT pro nově zakládané platby, tak částky u dosud
-- nezaplacených záznamů. Už zaplacené (PAID) a odpuštěné (WAIVED) platby
-- zůstávají beze změny — jsou to historická data a musí dál sedět
-- s tím, co reálně přišlo na účet.

ALTER TABLE "PlayerPayment" ALTER COLUMN "licFee"   SET DEFAULT 250;
ALTER TABLE "PlayerPayment" ALTER COLUMN "superFee" SET DEFAULT 250;
ALTER TABLE "TeamPayment"   ALTER COLUMN "amount"   SET DEFAULT 8000;

UPDATE "PlayerPayment"
   SET "licFee" = 250
 WHERE "licFee" = 300
   AND "licStatus" IN ('PENDING', 'OVERDUE');

UPDATE "PlayerPayment"
   SET "superFee" = 250
 WHERE "superFee" = 300
   AND "superStatus" IN ('PENDING', 'OVERDUE');

UPDATE "TeamPayment"
   SET "amount" = 8000
 WHERE "amount" = 10000
   AND "status" IN ('PENDING', 'OVERDUE');
