-- Čas na kroku přihlášky: rozliší nechtěný proklik z reklamy od člověka,
-- který si obrazovku přečetl a stejně odešel.
--
-- 16. 9. 2026 došlo na výběr role 167 lidí a roli si vybralo 21. Oprava
-- prázdné obrazovky (server ji od 16:37 vykresluje sám) poměr nezlepšila --
-- za tři hodiny po ní 65 průchodů a 4 dál. Pomalé načtení to tedy nebylo:
-- ping do trychtýře odchází až ve chvíli, kdy je stránka živá, takže kdo
-- odešel během načítání, se do těch 167 vůbec nezapočítal.
--
-- Zbyla dvě vysvětlení -- "je to nechtěný proklik z reklamy" a "obrazovka
-- nefunguje jako rozcestník" -- a rozliší je jediné číslo: jak dlouho tam
-- lidé byli. Do 3 sekund je proklik, přes 10 sekund je čtení.
--
-- Pořád nic osobního: id průchodu vzniká v paměti stránky, do prohlížeče se
-- neukládá a zavřením karty zaniká.

ALTER TABLE "OnboardingStep" ADD COLUMN "sekundy"   INTEGER;
ALTER TABLE "OnboardingStep" ADD COLUMN "odchod"    TEXT;
ALTER TABLE "OnboardingStep" ADD COLUMN "scroll"    INTEGER;
ALTER TABLE "OnboardingStep" ADD COLUMN "vyskaOkna" INTEGER;
