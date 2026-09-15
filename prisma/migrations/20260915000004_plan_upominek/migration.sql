-- Plán upomínek: hodina, den, týden — a pak ticho.
--
-- Jedna připomínka nestačila: kdo si ji přečte v práci a odloží, druhou
-- šanci od nás nedostal. Počet odeslaných drží, která fáze plánu je na
-- řadě; `upominkaAt` zůstává časem té poslední.
--
-- Mazat se pořád nic nebude. Po třetí zprávě se přestane psát a nezaplacené
-- přihlášky uvidí supervisor ve Správě hráčů a v Týmech.

ALTER TABLE "PlayerPayment" ADD COLUMN "upominekPoslano" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TeamPayment"   ADD COLUMN "upominekPoslano" INTEGER NOT NULL DEFAULT 0;
