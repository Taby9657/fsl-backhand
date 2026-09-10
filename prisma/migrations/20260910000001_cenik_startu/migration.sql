-- Nový ceník startů (10. 9. 2026).
--
-- Ze startů se platí hala, rozhodčí a zdravotník — proto klesla registrace
-- týmu a zlevnily balíčky: vstup do ligy má být levný a hlavní příjem má růst
-- s počtem lidí, kteří doopravdy hrají.
--
--   registrace týmu   8 000 → 3 000 Kč
--   balíčky           1=200, 3=550, 7=1 200, 12=2 000, 16=2 600, 20=3 000
--
-- Ceny balíčků žijí v kódu (`src/services/kredit.js`), ne v databázi —
-- migrace mění jen výchozí částku registrace. Už předepsané platby zůstávají,
-- co je jednou předepsané, se lidem uprostřed sezóny nemění.
--
-- Kontrola udržitelnosti: i nejtenčí sestava zápas pokryje. Devět hráčů
-- na každé straně po 162,50 Kč (šestnáctka) je 2 925 Kč proti nákladu
-- 2 200 Kč na zápas.

ALTER TABLE "TeamPayment" ALTER COLUMN "amount" SET DEFAULT 3000;
