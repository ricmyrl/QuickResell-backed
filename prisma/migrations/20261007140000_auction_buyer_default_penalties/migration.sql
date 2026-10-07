ALTER TABLE "User"
ADD COLUMN "biddingSuspendedUntil" TIMESTAMP(3);

ALTER TABLE "AuctionRoom"
ADD COLUMN "paymentDueAt" TIMESTAMP(3),
ADD COLUMN "paymentGraceUntil" TIMESTAMP(3),
ADD COLUMN "paymentGraceUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "buyerDefaultedAt" TIMESTAMP(3);

CREATE INDEX "AuctionRoom_status_paymentDueAt_idx"
ON "AuctionRoom"("status", "paymentDueAt");
