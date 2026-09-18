-- Informativní e-mail "liga ti složila tým", který chodí před telefonátem.
--
-- Sloupec drží jedinou věc: kdy zpráva hráči odešla. Bez něj se nedá
-- rozeslání spustit dvakrát, aniž by část lidí dostala e-mail znovu --
-- a "máme pro tebe tým" podruhé vypadá, jako že liga neví, co dělá.
--
-- Je to čas, ne příznak, schválně: při reklamaci je potřeba vědět, kterého
-- dne zpráva odešla, a prázdná hodnota znamená "ještě neodešla".

ALTER TABLE "Player" ADD COLUMN "teamOfferMailAt" TIMESTAMP(3);
