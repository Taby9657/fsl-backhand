-- Ceník 2026/27 do schématu.
--
-- Výchozí částky zůstaly na cenách z minulého ročníku, zatímco závazný ceník
-- (fsl-pravidla-souteze.md) už počítá s novými. Nový hráč by tak dostal
-- předpis na 250 Kč, i když licence stojí 300 — a nikdo by si toho nevšiml,
-- dokud by neseděly součty.
--
--   hráčská licence   250 → 300 Kč
--   superlicence      250 → 300 Kč
--   registrace týmu 8 000 → 9 700 Kč
--
-- Všechny částky jsou konečné, včetně DPH 21 %.
--
-- Tabulky jsou po resetu dat z 9. 9. 2026 prázdné, takže se nic
-- nepřepočítává. Kdyby v nich něco bylo, tahle migrace by se schválně
-- existujících předpisů nedotkla: co je jednou předepsané, se lidem
-- uprostřed sezóny nemění.

ALTER TABLE "PlayerPayment" ALTER COLUMN "licFee"   SET DEFAULT 300;
ALTER TABLE "PlayerPayment" ALTER COLUMN "superFee" SET DEFAULT 300;
ALTER TABLE "TeamPayment"   ALTER COLUMN "amount"   SET DEFAULT 9700;
