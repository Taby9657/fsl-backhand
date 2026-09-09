-- Konec poplatku za domácí zápas.
--
-- Do 9. 9. 2026 platil za odehraný zápas domácí tým: 2 200 Kč splatných
-- 48 h před výkopem, evidovaných přímo na zápase. Od přechodu na balíčky
-- startů platí zápas každý hráč sám (MatchPack, MatchEntry), takže tenhle
-- poplatek nemá koho účtovat — a rozhodčí místo „zaplatil domácí tým"
-- kontroluje, že start má každý v sestavě.
--
-- Sloupce se schválně nenechávají viset prázdné: dokud ve schématu jsou,
-- vypadá to, že se poplatek jen dočasně nevybírá, a někdo je za rok zase
-- zapojí. Tabulka Match je po resetu dat z 9. 9. 2026 prázdná, takže
-- se ničeho nezbavujeme.
--
-- Variabilní symbol s prefixem 4 se nerecykluje: kdyby přišel starý převod,
-- skončí mezi nespárovanými a podívá se na něj supervisor.

ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeePaid";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeePaidAmount";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeeStripeId";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeeSessionId";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeeReminderAt";
ALTER TABLE "Match" DROP COLUMN IF EXISTS "homeFeeVS";
