-- Rozdělení variabilních symbolů podle typu platby.
--
-- Do teď sdílela superlicence VS s hráčskou licencí a poplatek za domácí zápas
-- s registrací týmu, takže příchozí převod nešlo spolehlivě spárovat.
--
-- Nově má:
--   * superlicence vlastní sloupec PlayerPayment.superVariableSymbol (prefix 2)
--   * každý domácí zápas vlastní Match.homeFeeVS (prefix 4)

ALTER TABLE "PlayerPayment" ADD COLUMN "superVariableSymbol" TEXT;
ALTER TABLE "Match" ADD COLUMN "homeFeeVS" TEXT;

CREATE UNIQUE INDEX "PlayerPayment_superVariableSymbol_key"
  ON "PlayerPayment"("superVariableSymbol");
CREATE UNIQUE INDEX "Match_homeFeeVS_key"
  ON "Match"("homeFeeVS");

-- Migrace historických dat: pokud hráč dostal VS s prefixem 2 (tzn. jako první
-- si vyžádal QR na superlicenci), patří tento symbol superlicenci, ne licenci.
UPDATE "PlayerPayment"
   SET "superVariableSymbol" = "variableSymbol",
       "variableSymbol"      = NULL
 WHERE "variableSymbol" LIKE '2%';
