-- Log třídění a historie eskalací.
-- Čistě přírůstkové: dvě nové tabulky, nic se nemění ani nemaže.

CREATE TABLE "TriageLog" (
    "id" TEXT NOT NULL,
    "playerId" TEXT,
    "messageId" TEXT,
    "category" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "ruleHit" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TriageLog_createdAt_idx" ON "TriageLog"("createdAt");
CREATE INDEX "TriageLog_category_createdAt_idx" ON "TriageLog"("category", "createdAt");

CREATE TABLE "SupportEscalation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "playerId" TEXT,
    "messageId" TEXT,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "overdue" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportEscalation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportEscalation_answeredAt_dueAt_idx" ON "SupportEscalation"("answeredAt", "dueAt");
CREATE INDEX "SupportEscalation_conversationId_createdAt_idx" ON "SupportEscalation"("conversationId", "createdAt");
