-- Naplánovaný přechod na novou sezónu.
--
-- Supervisor přechod naplánuje na datum, ve druhém kroku ho potvrdí opsáním
-- názvu sezóny, a server ho pak provede sám. Neprovede ho, dokud ve staré
-- sezóně zbývají neodehrané zápasy — místo toho přechod odloží a upozorní.

CREATE TYPE "SeasonTransitionStatus" AS ENUM (
  'PENDING_CONFIRM',
  'CONFIRMED',
  'EXECUTED',
  'CANCELLED',
  'FAILED'
);

CREATE TABLE "SeasonTransition" (
    "id"                TEXT NOT NULL,
    "newSeason"         TEXT NOT NULL,
    "scheduledAt"       TIMESTAMP(3) NOT NULL,
    "status"            "SeasonTransitionStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
    "createdById"       TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt"       TIMESTAMP(3),
    "executedAt"        TIMESTAMP(3),
    "blockedNotifiedAt" TIMESTAMP(3),
    "result"            TEXT,

    CONSTRAINT "SeasonTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SeasonTransition_status_scheduledAt_idx"
  ON "SeasonTransition"("status", "scheduledAt");
