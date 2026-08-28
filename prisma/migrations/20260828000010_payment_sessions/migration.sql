-- Rozpracovaná Stripe Checkout session u každé platby.
--
-- Bez tohohle sloupce vznikala při každém kliknutí na „Zaplatit" nová session.
-- Kdo si otevřel platbu dvakrát, mohl obě dokončit a zaplatit dvakrát —
-- webhook druhou platbu jen znovu označil jako PAID a peníze zůstaly u Stripe.
--
-- Teď si otevřenou session pamatujeme a při dalším pokusu ji vrátíme znovu
-- místo zakládání nové. Slouží zároveň k rekonciliaci ztracených webhooků:
-- noční úloha se Stripe doptá, jestli uložená session mezitím neproběhla.

ALTER TABLE "PlayerPayment" ADD COLUMN "licSessionId"   TEXT;
ALTER TABLE "PlayerPayment" ADD COLUMN "superSessionId" TEXT;
ALTER TABLE "TeamPayment"   ADD COLUMN "sessionId"      TEXT;
ALTER TABLE "Match"         ADD COLUMN "homeFeeSessionId" TEXT;

-- Kdy jsme vedoucimu naposledy pripomneli neuhrazeny poplatek za domaci zapas.
-- Bez toho by upominka chodila pri kazdem behu ulohy dokola.
ALTER TABLE "Match" ADD COLUMN "homeFeeReminderAt" TIMESTAMP(3);
