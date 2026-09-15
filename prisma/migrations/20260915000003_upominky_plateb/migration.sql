-- Připomínka nezaplaceného poplatku, hodinu po registraci.
--
-- Sloupec drží čas odeslání, ne příznak: podle něj se pozná, že druhý
-- průchod cronu už tomutéž člověku psát nemá, a zároveň je vidět kdy.
--
-- Připomínka se posílá jen tomu, kdo doopravdy platit má: hráči v týmu
-- s nezaplacenou licencí a týmu s nezaplacenou registrací. Hráč bez týmu
-- v draftu neplatí nic, dokud si tým nenajde, takže mu nic nechodí.

ALTER TABLE "PlayerPayment" ADD COLUMN "upominkaAt" TIMESTAMP(3);
ALTER TABLE "TeamPayment"   ADD COLUMN "upominkaAt" TIMESTAMP(3);
