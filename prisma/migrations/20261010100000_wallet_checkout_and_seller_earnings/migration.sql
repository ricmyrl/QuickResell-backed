CREATE TYPE "WalletTransactionType" AS ENUM (
  'TOP_UP',
  'PURCHASE',
  'SELLER_EARNING',
  'CASHOUT'
);

CREATE TYPE "WalletTransactionDirection" AS ENUM (
  'CREDIT',
  'DEBIT'
);

ALTER TABLE "WalletTransaction"
ALTER COLUMN "paymentAmountKobo" DROP NOT NULL,
ADD COLUMN "type" "WalletTransactionType" NOT NULL DEFAULT 'TOP_UP',
ADD COLUMN "direction" "WalletTransactionDirection" NOT NULL DEFAULT 'CREDIT',
ADD COLUMN "orderId" TEXT,
ADD COLUMN "orderItemId" TEXT;

ALTER TABLE "WalletTransaction"
ADD CONSTRAINT "WalletTransaction_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WalletTransaction"
ADD CONSTRAINT "WalletTransaction_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "PurchaseOrderItem"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WalletTransaction_orderId_type_idx"
ON "WalletTransaction"("orderId", "type");

CREATE INDEX "WalletTransaction_orderItemId_type_idx"
ON "WalletTransaction"("orderItemId", "type");

WITH eligible AS (
  SELECT
    item."sellerId",
    item."orderId",
    item."id" AS "orderItemId",
    item."quantity" * item."unitPriceCents" - item."sellerFeeCents" AS "amountCents"
  FROM "PurchaseOrderItem" item
  INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
  INNER JOIN "SellerPayout" payout ON payout."orderItemId" = item."id"
  WHERE orders."paymentReference" IS NOT NULL
    AND orders."status" <> 'CANCELLED'
    AND item."fulfillmentStatus" IN ('READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
    AND item."quantity" * item."unitPriceCents" - item."sellerFeeCents" > 0
    AND payout."status" IN ('PENDING', 'BLOCKED')
)
INSERT INTO "Wallet" ("id", "userId", "balanceCents", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, eligible."sellerId", SUM(eligible."amountCents"), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM eligible
GROUP BY eligible."sellerId"
ON CONFLICT ("userId") DO UPDATE
SET "balanceCents" = "Wallet"."balanceCents" + EXCLUDED."balanceCents",
    "updatedAt" = CURRENT_TIMESTAMP;

WITH eligible AS (
  SELECT
    item."sellerId",
    item."orderId",
    item."id" AS "orderItemId",
    item."quantity" * item."unitPriceCents" - item."sellerFeeCents" AS "amountCents"
  FROM "PurchaseOrderItem" item
  INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
  INNER JOIN "SellerPayout" payout ON payout."orderItemId" = item."id"
  WHERE orders."paymentReference" IS NOT NULL
    AND orders."status" <> 'CANCELLED'
    AND item."fulfillmentStatus" IN ('READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
    AND item."quantity" * item."unitPriceCents" - item."sellerFeeCents" > 0
    AND payout."status" IN ('PENDING', 'BLOCKED')
)
INSERT INTO "WalletTransaction" (
  "id",
  "walletId",
  "paymentReference",
  "amountCents",
  "paymentAmountKobo",
  "type",
  "direction",
  "orderId",
  "orderItemId",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  wallet."id",
  'QR-SEARN-' || eligible."orderItemId",
  eligible."amountCents",
  NULL,
  'SELLER_EARNING',
  'CREDIT',
  eligible."orderId",
  eligible."orderItemId",
  'COMPLETED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM eligible
INNER JOIN "Wallet" wallet ON wallet."userId" = eligible."sellerId";
