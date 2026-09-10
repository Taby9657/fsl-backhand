-- Pokuta za kontumaci: 2 200 → 3 000 Kč.
--
-- Sazba je v `pokuty.js` (POKUTA_KONTUMACE) a default ve schématu je jen
-- pojistka pro ruční zápis. Obojí se musí měnit spolu, jinak by pokuta
-- založená mimo službu byla za starou cenu.
--
-- Už předepsané pokuty se **nepřepočítávají**: tým dostal do ruky VS a
-- částku, na kterou se zavázal, a měnit ji zpětně by rozbilo párování
-- převodů — přišla by přesně stará částka a systém by ji vyhodnotil jako
-- částečnou platbu. Nové kontumace jsou za 3 000 Kč.

ALTER TABLE "Fine" ALTER COLUMN "amount" SET DEFAULT 3000;
