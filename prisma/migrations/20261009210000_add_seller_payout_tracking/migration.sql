CREATE TYPE "SellerPayoutStatus" AS ENUM (
  'BLOCKED',
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'REVERSED',
  'REVIEW_REQUIRED'
);

CREATE TABLE "SellerPayout" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sellerId" UUID NOT NULL,
  "amountUsdCents" INTEGER NOT NULL,
  "amountKobo" INTEGER,
  "recipientCode" TEXT,
  "transferReference" TEXT,
  "transferCode" TEXT,
  "status" "SellerPayoutStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "SellerPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerPayout_orderId_sellerId_key"
ON "SellerPayout"("orderId", "sellerId");

CREATE UNIQUE INDEX "SellerPayout_transferReference_key"
ON "SellerPayout"("transferReference");

CREATE INDEX "SellerPayout_sellerId_status_createdAt_idx"
ON "SellerPayout"("sellerId", "status", "createdAt");

CREATE INDEX "SellerPayout_status_updatedAt_idx"
ON "SellerPayout"("status", "updatedAt");

ALTER TABLE "SellerPayout"
ADD CONSTRAINT "SellerPayout_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellerPayout"
ADD CONSTRAINT "SellerPayout_sellerId_fkey"
FOREIGN KEY ("sellerId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
