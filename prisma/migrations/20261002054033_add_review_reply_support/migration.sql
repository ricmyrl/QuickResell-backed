-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('GENERAL', 'REVIEW', 'REPLY');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "replyToId" TEXT,
ADD COLUMN     "type" "MessageType" NOT NULL DEFAULT 'GENERAL';

-- CreateIndex
CREATE INDEX "Message_conversationId_type_idx" ON "Message"("conversationId", "type");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
