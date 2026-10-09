ALTER TABLE "SellerPayout"
ADD COLUMN "orderItemId" TEXT;

DROP INDEX "SellerPayout_orderId_sellerId_key";

CREATE UNIQUE INDEX "SellerPayout_orderItemId_key"
ON "SellerPayout"("orderItemId");

ALTER TABLE "SellerPayout"
ADD CONSTRAINT "SellerPayout_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "PurchaseOrderItem"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
