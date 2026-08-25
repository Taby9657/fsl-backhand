-- AlterTable: Player.userId → nullable
ALTER TABLE "Player" ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable: Referee.userId → nullable
ALTER TABLE "Referee" ALTER COLUMN "userId" DROP NOT NULL;

-- DropForeignKey (stará CASCADE)
ALTER TABLE "Player" DROP CONSTRAINT "Player_userId_fkey";
ALTER TABLE "Referee" DROP CONSTRAINT "Referee_userId_fkey";

-- AddForeignKey (nová SET NULL – při smazání User se Player/Referee odpojí, data zůstanou)
ALTER TABLE "Player" ADD CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Referee" ADD CONSTRAINT "Referee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
