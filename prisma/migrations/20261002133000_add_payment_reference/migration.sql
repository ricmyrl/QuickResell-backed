ALTER TABLE "PurchaseOrder" ADD COLUMN "paymentReference" TEXT;

CREATE UNIQUE INDEX "PurchaseOrder_paymentReference_key" ON "PurchaseOrder"("paymentReference");