-- FSL initial migration
-- Generated from schema.prisma – baseline for existing Railway DB

-- CreateEnum
CREATE TYPE "RefereeLevel" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "RefereeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('UPCOMING', 'LIVE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MatchEventType" AS ENUM ('GOAL', 'PENALTY', 'SHOOTOUT_GOAL', 'SHOOTOUT_MISS', 'PERIOD_END', 'MATCH_END');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "DraftOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('MATCH_TRANSCRIPT', 'PLAYER_DISPUTE', 'LICENSE_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "googleId" TEXT,
    "appleId" TEXT,
    "pushToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbr" VARCHAR(3) NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#C9A140',
    "logoUrl" TEXT,
    "venue" TEXT,
    "division" TEXT NOT NULL DEFAULT 'Divize A',
    "conference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Manager" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Manager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "jersey" INTEGER NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'Útočník',
    "birthdate" TIMESTAMP(3),
    "phone" TEXT,
    "photoUrl" TEXT,
    "licensed" BOOLEAN NOT NULL DEFAULT false,
    "isSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referee" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "photoUrl" TEXT,
    "level" "RefereeLevel" NOT NULL DEFAULT 'C',
    "status" "RefereeStatus" NOT NULL DEFAULT 'PENDING',
    "birthNo" TEXT,
    "address" TEXT,
    "city" TEXT,
    "zip" TEXT,
    "bankAccount" TEXT,
    "bankCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "refereeId" TEXT,
    "competition" TEXT NOT NULL DEFAULT 'FSL Liga',
    "division" TEXT NOT NULL DEFAULT 'Divize A',
    "season" TEXT NOT NULL DEFAULT '2025/26',
    "round" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "venue" TEXT,
    "homeScore" INTEGER NOT NULL DEFAULT 0,
    "awayScore" INTEGER NOT NULL DEFAULT 0,
    "status" "MatchStatus" NOT NULL DEFAULT 'UPCOMING',
    "homeFeePaid" BOOLEAN NOT NULL DEFAULT false,
    "homeFeeStripeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "type" "MatchEventType" NOT NULL,
    "minute" INTEGER NOT NULL,
    "period" INTEGER NOT NULL DEFAULT 1,
    "teamId" TEXT,
    "scorerId" TEXT,
    "assistId" TEXT,
    "penaltyId" TEXT,
    "penaltyType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineupSubmission" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineupSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineupPlayer" (
    "id" TEXT NOT NULL,
    "lineupId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "isGoalkeeper" BOOLEAN NOT NULL DEFAULT false,
    "isCaptain" BOOLEAN NOT NULL DEFAULT false,
    "jerseyOverride" INTEGER,

    CONSTRAINT "LineupPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostmatchData" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "refRating" INTEGER,
    "refNote" TEXT,
    "opponentMvpId" TEXT,
    "actionVideoUrl" TEXT,
    "actionDesc" TEXT,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostmatchData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefRating" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamPayment" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "season" TEXT NOT NULL DEFAULT '2025/26',
    "amount" INTEGER NOT NULL DEFAULT 10000,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "method" TEXT,
    "stripeId" TEXT,
    "variableSymbol" TEXT,

    CONSTRAINT "TeamPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerPayment" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "season" TEXT NOT NULL DEFAULT '2025/26',
    "licFee" INTEGER NOT NULL DEFAULT 300,
    "licStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "licPaidAt" TIMESTAMP(3),
    "licMethod" TEXT,
    "superLic" BOOLEAN NOT NULL DEFAULT false,
    "superFee" INTEGER NOT NULL DEFAULT 300,
    "superStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "superPaidAt" TIMESTAMP(3),
    "stripeId" TEXT,
    "variableSymbol" TEXT,

    CONSTRAINT "PlayerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "variableSymbol" TEXT,
    "senderName" TEXT,
    "senderAccount" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "screen" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundHighlight" (
    "id" TEXT NOT NULL,
    "round" INTEGER,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "videoUrl" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundHighlight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftProfile" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "bio" TEXT,
    "pubSkill" TEXT,
    "position" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftVideo" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftOffer" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "message" TEXT,
    "status" "DraftOfferStatus" NOT NULL DEFAULT 'PENDING',
    "isFirst" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorRequest" (
    "id" TEXT NOT NULL,
    "type" "RequestType" NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "matchId" TEXT,
    "body" TEXT NOT NULL,
    "note" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupervisorRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");
CREATE UNIQUE INDEX "Manager_userId_teamId_key" ON "Manager"("userId", "teamId");
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");
CREATE UNIQUE INDEX "Player_userId_key" ON "Player"("userId");
CREATE UNIQUE INDEX "Referee_userId_key" ON "Referee"("userId");
CREATE UNIQUE INDEX "LineupSubmission_matchId_teamId_key" ON "LineupSubmission"("matchId", "teamId");
CREATE UNIQUE INDEX "LineupPlayer_lineupId_playerId_key" ON "LineupPlayer"("lineupId", "playerId");
CREATE UNIQUE INDEX "PostmatchData_matchId_teamId_key" ON "PostmatchData"("matchId", "teamId");
CREATE UNIQUE INDEX "RefRating_matchId_teamId_key" ON "RefRating"("matchId", "teamId");
CREATE UNIQUE INDEX "TeamPayment_teamId_key" ON "TeamPayment"("teamId");
CREATE UNIQUE INDEX "TeamPayment_variableSymbol_key" ON "TeamPayment"("variableSymbol");
CREATE UNIQUE INDEX "PlayerPayment_playerId_key" ON "PlayerPayment"("playerId");
CREATE UNIQUE INDEX "PlayerPayment_variableSymbol_key" ON "PlayerPayment"("variableSymbol");
CREATE UNIQUE INDEX "BankTransaction_transactionId_key" ON "BankTransaction"("transactionId");
CREATE UNIQUE INDEX "DraftProfile_playerId_key" ON "DraftProfile"("playerId");
CREATE UNIQUE INDEX "DraftOffer_profileId_teamId_key" ON "DraftOffer"("profileId", "teamId");

-- CreateIndex (performance)
CREATE INDEX "Match_season_idx" ON "Match"("season");
CREATE INDEX "Match_status_idx" ON "Match"("status");
CREATE INDEX "Match_season_status_idx" ON "Match"("season", "status");
CREATE INDEX "Match_homeTeamId_idx" ON "Match"("homeTeamId");
CREATE INDEX "Match_awayTeamId_idx" ON "Match"("awayTeamId");
CREATE INDEX "Match_refereeId_idx" ON "Match"("refereeId");
CREATE INDEX "Match_date_idx" ON "Match"("date");
CREATE INDEX "MatchEvent_matchId_idx" ON "MatchEvent"("matchId");
CREATE INDEX "MatchEvent_scorerId_idx" ON "MatchEvent"("scorerId");
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");
CREATE INDEX "DraftOffer_status_idx" ON "DraftOffer"("status");
CREATE INDEX "DraftOffer_expiresAt_idx" ON "DraftOffer"("expiresAt");

-- AddForeignKey
ALTER TABLE "Manager" ADD CONSTRAINT "Manager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Manager" ADD CONSTRAINT "Manager_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Referee" ADD CONSTRAINT "Referee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_scorerId_fkey" FOREIGN KEY ("scorerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_assistId_fkey" FOREIGN KEY ("assistId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_penaltyId_fkey" FOREIGN KEY ("penaltyId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LineupSubmission" ADD CONSTRAINT "LineupSubmission_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LineupPlayer" ADD CONSTRAINT "LineupPlayer_lineupId_fkey" FOREIGN KEY ("lineupId") REFERENCES "LineupSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LineupPlayer" ADD CONSTRAINT "LineupPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PostmatchData" ADD CONSTRAINT "PostmatchData_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostmatchData" ADD CONSTRAINT "PostmatchData_opponentMvpId_fkey" FOREIGN KEY ("opponentMvpId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RefRating" ADD CONSTRAINT "RefRating_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RefRating" ADD CONSTRAINT "RefRating_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TeamPayment" ADD CONSTRAINT "TeamPayment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerPayment" ADD CONSTRAINT "PlayerPayment_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftProfile" ADD CONSTRAINT "DraftProfile_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftVideo" ADD CONSTRAINT "DraftVideo_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "DraftProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftOffer" ADD CONSTRAINT "DraftOffer_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "DraftProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftOffer" ADD CONSTRAINT "DraftOffer_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupervisorRequest" ADD CONSTRAINT "SupervisorRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
