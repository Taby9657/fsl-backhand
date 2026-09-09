-- Registrace týmu zpátky na 8 000 Kč.
--
-- Migrace `20260909000005_cenik_2026_27` ji zvedla na 9 700 podle tehdejší
-- podoby ceníku. Taby ji vrátil na 8 000 — licence a superlicence po 300 Kč
-- zůstávají, mění se jen registrace.
--
-- Souvisí to i s tím, že liga není plátce DPH: 9 700 vznikalo jako částka
-- s daní, kterou by bylo potřeba odvést. Bez odvodu není důvod ji držet.
--
-- Jen výchozí hodnota, existující předpisy se nemění.

ALTER TABLE "TeamPayment" ALTER COLUMN "amount" SET DEFAULT 8000;
