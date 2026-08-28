-- Druhá sada dresů.
--
-- Týmy v této soutěži nemají vlastní halu, takže nedává smysl mluvit
-- o domácí a venkovní sadě. Rozlišujeme primární a sekundární; sekundární
-- je volitelná a slouží k rozlišení, když se barvy soupeřů kryjí.

ALTER TABLE "Team" ADD COLUMN "colorSecondary" TEXT;
