ALTER TYPE "AuctionRoomStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "AuctionRoomStatus" ADD VALUE IF NOT EXISTS 'SOLD';
ALTER TYPE "AuctionRoomStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "User"
    ADD COLUMN "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    ADD COLUMN "completedAuctions" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "backedOutAuctions" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuctionRoom"
    ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reservePrice" DOUBLE PRECISION;

CREATE INDEX "AuctionRoom_isPublic_status_endsAt_idx"
    ON "AuctionRoom"("isPublic", "status", "endsAt");

ALTER TABLE "AuctionRoom"
    ADD CONSTRAINT "AuctionRoom_reservePrice_nonnegative_check"
    CHECK ("reservePrice" IS NULL OR "reservePrice" >= 0);
