CREATE TABLE "AuctionWatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "auctionRoomId" TEXT NOT NULL,
    "maxBid" DOUBLE PRECISION NOT NULL,
    "bidStep" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "autoBidEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuctionWatchlistItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuctionWatchlistItem_maxBid_positive_check" CHECK ("maxBid" > 0),
    CONSTRAINT "AuctionWatchlistItem_bidStep_positive_check" CHECK ("bidStep" > 0)
);

CREATE UNIQUE INDEX "AuctionWatchlistItem_userId_auctionRoomId_key"
    ON "AuctionWatchlistItem"("userId", "auctionRoomId");
CREATE INDEX "AuctionWatchlistItem_autoBidEnabled_updatedAt_idx"
    ON "AuctionWatchlistItem"("autoBidEnabled", "updatedAt");

ALTER TABLE "AuctionWatchlistItem"
    ADD CONSTRAINT "AuctionWatchlistItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuctionWatchlistItem"
    ADD CONSTRAINT "AuctionWatchlistItem_auctionRoomId_fkey"
    FOREIGN KEY ("auctionRoomId") REFERENCES "AuctionRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;