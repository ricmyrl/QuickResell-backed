CREATE TYPE "BidStrategy" AS ENUM (
  'STANDARD',
  'JUMP_BID',
  'SNIPER',
  'RESERVE_TARGET',
  'ANALYST'
);

ALTER TABLE "AuctionWatchlistItem"
ADD COLUMN "strategy" "BidStrategy" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "jumpMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2,
ADD COLUMN "sniperWindowSeconds" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN "marginOfSafety" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "Bid"
ADD COLUMN "strategyMetadata" JSONB;

ALTER TABLE "Post"
ADD COLUMN "conditionScore" DOUBLE PRECISION NOT NULL DEFAULT 1;

CREATE INDEX "AuctionWatchlistItem_autoBidEnabled_strategy_idx"
ON "AuctionWatchlistItem"("autoBidEnabled", "strategy");

CREATE INDEX "PurchaseOrder_status_updatedAt_idx"
ON "PurchaseOrder"("status", "updatedAt");
