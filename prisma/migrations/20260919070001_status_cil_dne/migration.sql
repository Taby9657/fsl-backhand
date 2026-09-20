-- Cíl registrací na den a den, na který platí. Bez uloženého dne by
-- nedotažený včerejší cíl tiše platil i ráno pro nový den.
ALTER TABLE "Settings" ADD COLUMN "statusNaboruCil" INTEGER;
ALTER TABLE "Settings" ADD COLUMN "statusNaboruCilDen" TEXT;
