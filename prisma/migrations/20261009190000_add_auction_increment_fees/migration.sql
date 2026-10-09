ALTER TABLE "AuctionRoom"
ADD COLUMN "platformFeeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "platformFeeEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "Bid"
ADD COLUMN "sequence" INTEGER,
ADD COLUMN "incrementAmountCents" INTEGER;

WITH ordered_bids AS (
  SELECT
    bid."id",
    ROW_NUMBER() OVER (
      PARTITION BY bid."auctionRoomId"
      ORDER BY bid."amount" ASC, bid."createdAt" ASC, bid."id" ASC
    )::INTEGER AS sequence,
    ROUND((
      bid."amount" - COALESCE(
        LAG(bid."amount") OVER (
          PARTITION BY bid."auctionRoomId"
          ORDER BY bid."amount" ASC, bid."createdAt" ASC, bid."id" ASC
        ),
        post."price"
      )
    ) * 100)::INTEGER AS "incrementAmountCents"
  FROM "Bid" bid
  INNER JOIN "AuctionRoom" room ON room."id" = bid."auctionRoomId"
  INNER JOIN "Post" post ON post."id" = room."postId"
)
UPDATE "Bid" bid
SET
  "sequence" = ordered_bids.sequence,
  "incrementAmountCents" = ordered_bids."incrementAmountCents"
FROM ordered_bids
WHERE bid."id" = ordered_bids."id";

ALTER TABLE "Bid"
ALTER COLUMN "sequence" SET NOT NULL,
ALTER COLUMN "incrementAmountCents" SET NOT NULL;

CREATE UNIQUE INDEX "Bid_auctionRoomId_sequence_key"
ON "Bid"("auctionRoomId", "sequence");

ALTER TABLE "PurchaseOrderItem"
ADD COLUMN "sellerFeeCents" INTEGER NOT NULL DEFAULT 0;
