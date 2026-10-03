ALTER TABLE "CartItem"
    ADD COLUMN "auctionRoomId" TEXT;

CREATE INDEX "CartItem_auctionRoomId_idx" ON "CartItem"("auctionRoomId");

ALTER TABLE "CartItem"
    ADD CONSTRAINT "CartItem_auctionRoomId_fkey"
    FOREIGN KEY ("auctionRoomId") REFERENCES "AuctionRoom"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
