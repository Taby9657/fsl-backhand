-- Chat a Panda AI.
--
-- Zadání: `fsl-panda-ai-zadani-2026-09-21.md`. Migrace je celá aditivní --
-- nic existujícího nemaže ani nepřepisuje, jen přidává tabulky a dva
-- sloupce (`Player.dmPolicy`, `Team.pandaMode`).
--
-- Dvě věci, na kterých to stojí:
--
--   1. `Conversation` NEMÁ sezónu. Týmový chat je trvalý; přechod sezóny
--      maže soupisky, tohle se ho nesmí dotknout.
--   2. Žádné cizí klíče na Player a Team. Zprávy musí přežít smazání účtu
--      (u skupinové konverzace se jen odpojí od totožnosti), takže se tu
--      schválně nic nekaskáduje.

-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('TEAM', 'DIRECT', 'PANDA', 'SUPPORT');
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'SYSTEM', 'CARD');
CREATE TYPE "MessageClass" AS ENUM ('PROVOZNI', 'SPOLECENSKA');
CREATE TYPE "ChatRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');
CREATE TYPE "ReportTarget" AS ENUM ('MESSAGE', 'PROFILE');
CREATE TYPE "ReportState" AS ENUM ('NEW', 'REVIEWED', 'DISMISSED', 'ACTIONED');
CREATE TYPE "SanctionKind" AS ENUM ('MUTE', 'NO_STRANGER_DM', 'TEAM_CHAT_REMOVAL', 'PHOTO_REMOVAL');
CREATE TYPE "PandaEventState" AS ENUM ('SENT', 'SKIPPED');
CREATE TYPE "PandaMode" AS ENUM ('OFF', 'LEADER', 'FULL');
CREATE TYPE "DmPolicy" AS ENUM ('REQUESTS', 'NONE');
CREATE TYPE "PickSource" AS ENUM ('ROTATION', 'DRAW', 'MANUAL');
CREATE TYPE "PreviewState" AS ENUM ('DRAFT', 'APPROVED', 'PUBLISHED', 'DISCARDED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Player" ADD COLUMN "dmPolicy" "DmPolicy" NOT NULL DEFAULT 'REQUESTS';
ALTER TABLE "Team"   ADD COLUMN "pandaMode" "PandaMode" NOT NULL DEFAULT 'LEADER';

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "teamId" TEXT,
    "ownerPlayerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitingSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3),
    "escalCategory" TEXT,
    "escalReason" TEXT,
    "overdueNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_teamId_key" ON "Conversation"("teamId");
CREATE UNIQUE INDEX "Conversation_ownerPlayerId_kind_key" ON "Conversation"("ownerPlayerId", "kind");
CREATE INDEX "Conversation_waitingSupervisor_dueAt_idx" ON "Conversation"("waitingSupervisor", "dueAt");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateTable
CREATE TABLE "ConversationMember" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "isSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "addedById" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "mutedSocial" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationMember_conversationId_playerId_key" ON "ConversationMember"("conversationId", "playerId");
CREATE INDEX "ConversationMember_playerId_idx" ON "ConversationMember"("playerId");

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorPlayerId" TEXT,
    "fromSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "class" "MessageClass" NOT NULL DEFAULT 'SPOLECENSKA',
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "replyToId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbUrl" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateTable
CREATE TABLE "MessageReaction" (
    "messageId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("messageId", "playerId", "emoji")
);

CREATE INDEX "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");

-- CreateTable
CREATE TABLE "ChatRequest" (
    "id" TEXT NOT NULL,
    "fromPlayerId" TEXT NOT NULL,
    "toPlayerId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ChatRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatRequest_fromPlayerId_toPlayerId_key" ON "ChatRequest"("fromPlayerId", "toPlayerId");
CREATE INDEX "ChatRequest_toPlayerId_status_idx" ON "ChatRequest"("toPlayerId", "status");

-- CreateTable
CREATE TABLE "ChatBlock" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatBlock_pkey" PRIMARY KEY ("blockerId", "blockedId")
);

-- CreateTable
CREATE TABLE "ChatReport" (
    "id" TEXT NOT NULL,
    "target" "ReportTarget" NOT NULL DEFAULT 'MESSAGE',
    "messageId" TEXT,
    "reporterId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "ReportState" NOT NULL DEFAULT 'NEW',
    "caseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatReport_messageId_reporterId_key" ON "ChatReport"("messageId", "reporterId");
CREATE INDEX "ChatReport_state_createdAt_idx" ON "ChatReport"("state", "createdAt");

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "state" "ReportState" NOT NULL DEFAULT 'NEW',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModerationCase_state_createdAt_idx" ON "ModerationCase"("state", "createdAt");

-- CreateTable
CREATE TABLE "ChatSanction" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "kind" "SanctionKind" NOT NULL,
    "teamId" TEXT,
    "reason" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSanction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatSanction_playerId_until_idx" ON "ChatSanction"("playerId", "until");

-- CreateTable
CREATE TABLE "PandaEvent" (
    "key" TEXT NOT NULL,
    "teamId" TEXT,
    "state" "PandaEventState" NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PandaEvent_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "PandaEvent_teamId_createdAt_idx" ON "PandaEvent"("teamId", "createdAt");

-- CreateTable
CREATE TABLE "PandaAction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "teamId" TEXT,
    "playerId" TEXT,
    "matchId" TEXT,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PandaAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PandaAction_teamId_createdAt_idx" ON "PandaAction"("teamId", "createdAt");

-- CreateTable
CREATE TABLE "MatchSignup" (
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "playing" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchSignup_pkey" PRIMARY KEY ("matchId", "playerId")
);

CREATE INDEX "MatchSignup_matchId_playing_idx" ON "MatchSignup"("matchId", "playing");

-- CreateTable
CREATE TABLE "MatchScorekeeper" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "source" "PickSource" NOT NULL,
    "drawNo" INTEGER NOT NULL DEFAULT 0,
    "candidates" JSONB NOT NULL,
    "excluded" JSONB,
    "requestedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedAt" TIMESTAMP(3),
    "replaceReason" TEXT,

    CONSTRAINT "MatchScorekeeper_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MatchScorekeeper_matchId_teamId_idx" ON "MatchScorekeeper"("matchId", "teamId");

-- CreateTable
CREATE TABLE "MatchNote" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "usedInId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MatchNote_matchId_createdAt_idx" ON "MatchNote"("matchId", "createdAt");

-- CreateTable
CREATE TABLE "MatchPreview" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "state" "PreviewState" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchPreview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchPreview_matchId_key" ON "MatchPreview"("matchId");
CREATE INDEX "MatchPreview_state_expiresAt_idx" ON "MatchPreview"("state", "expiresAt");
