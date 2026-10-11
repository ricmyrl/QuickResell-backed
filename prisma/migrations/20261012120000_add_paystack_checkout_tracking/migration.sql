CREATE TYPE "PaystackCheckoutStatus" AS ENUM (
  'PENDING',
  'COMPLETED',
  'FAILED',
  'REVIEW_REQUIRED'
);

CREATE TABLE "PaystackCheckout" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "buyerId" UUID NOT NULL,
  "paymentAmountKobo" INTEGER NOT NULL,
  "cartItemIds" TEXT[] NOT NULL,
  "status" "PaystackCheckoutStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaystackCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaystackCheckout_reference_key" ON "PaystackCheckout"("reference");
CREATE INDEX "PaystackCheckout_status_createdAt_idx" ON "PaystackCheckout"("status", "createdAt");
CREATE INDEX "PaystackCheckout_buyerId_createdAt_idx" ON "PaystackCheckout"("buyerId", "createdAt");

ALTER TABLE "PaystackCheckout"
ADD CONSTRAINT "PaystackCheckout_buyerId_fkey"
FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;