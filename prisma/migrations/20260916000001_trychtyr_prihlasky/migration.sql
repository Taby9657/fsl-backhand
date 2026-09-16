-- Trychtýř přihlášky: kde lidé v registraci odpadávají.
--
-- 16. 9. 2026 otevřelo /registrace za 24 hodin 192 lidí a neodeslal ji nikdo.
-- Na registrační cesty nepřišel ani jeden POST, takže to nebyla chyba serveru
-- ani validace — lidé odcházeli uvnitř formuláře a nešlo zjistit kde.
--
-- Tabulka drží jen náhodné id průchodu, roli, krok a čas. Nic z formuláře.
-- Unikátní dvojice (navsteva, krok) znamená, že návrat na už viděný krok
-- nezaloží další řádek — počet řádků na krok je rovnou trychtýř.

CREATE TABLE "OnboardingStep" (
    "id"        TEXT         NOT NULL,
    "navsteva"  TEXT         NOT NULL,
    "role"      TEXT,
    "krok"      TEXT         NOT NULL,
    "bezTymu"   BOOLEAN      NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OnboardingStep_navsteva_krok_key" ON "OnboardingStep"("navsteva", "krok");
CREATE INDEX "OnboardingStep_createdAt_idx" ON "OnboardingStep"("createdAt");
