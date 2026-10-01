CREATE TYPE "AuctionRoomStatus" AS ENUM ('ACTIVE', 'CLOSED');

CREATE TABLE "AuctionRoom" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "currentHighestBid" DOUBLE PRECISION NOT NULL,
    "highestBidderId" UUID,
    "status" "AuctionRoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuctionRoom_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "auctionRoomId" TEXT NOT NULL,
    "bidderId" UUID NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuctionRoom_postId_key" ON "AuctionRoom"("postId");
CREATE INDEX "AuctionRoom_status_endsAt_idx" ON "AuctionRoom"("status", "endsAt");
CREATE INDEX "AuctionRoom_sellerId_createdAt_idx" ON "AuctionRoom"("sellerId", "createdAt");
CREATE INDEX "Bid_auctionRoomId_createdAt_idx" ON "Bid"("auctionRoomId", "createdAt");
CREATE INDEX "Bid_bidderId_createdAt_idx" ON "Bid"("bidderId", "createdAt");

ALTER TABLE "AuctionRoom"
    ADD CONSTRAINT "AuctionRoom_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuctionRoom"
    ADD CONSTRAINT "AuctionRoom_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuctionRoom"
    ADD CONSTRAINT "AuctionRoom_highestBidderId_fkey"
    FOREIGN KEY ("highestBidderId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Bid"
    ADD CONSTRAINT "Bid_auctionRoomId_fkey"
    FOREIGN KEY ("auctionRoomId") REFERENCES "AuctionRoom"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bid"
    ADD CONSTRAINT "Bid_bidderId_fkey"
    FOREIGN KEY ("bidderId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
