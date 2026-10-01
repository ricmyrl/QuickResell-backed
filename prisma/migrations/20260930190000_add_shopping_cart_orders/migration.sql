CREATE TYPE "PurchaseOrderStatus" AS ENUM ('PENDING_HANDOFF', 'COMPLETED', 'CANCELLED');

ALTER TABLE "Post"
    ADD COLUMN "quantityAvailable" INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT "Post_quantityAvailable_nonnegative_check"
        CHECK ("quantityAvailable" >= 0);

CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "postId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CartItem_quantity_positive_check" CHECK ("quantity" > 0)
);

CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "buyerId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'PENDING_HANDOFF',
    "subtotalCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrder_subtotalCents_nonnegative_check" CHECK ("subtotalCents" >= 0)
);

CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "sellerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseOrderItem_quantity_positive_check" CHECK ("quantity" > 0),
    CONSTRAINT "PurchaseOrderItem_unitPriceCents_nonnegative_check" CHECK ("unitPriceCents" >= 0)
);

CREATE UNIQUE INDEX "CartItem_userId_postId_key" ON "CartItem"("userId", "postId");
CREATE INDEX "CartItem_userId_createdAt_idx" ON "CartItem"("userId", "createdAt");
CREATE INDEX "PurchaseOrder_buyerId_createdAt_idx" ON "PurchaseOrder"("buyerId", "createdAt");
CREATE INDEX "PurchaseOrder_status_createdAt_idx" ON "PurchaseOrder"("status", "createdAt");
CREATE INDEX "PurchaseOrderItem_sellerId_createdAt_idx" ON "PurchaseOrderItem"("sellerId", "createdAt");
CREATE INDEX "PurchaseOrderItem_postId_idx" ON "PurchaseOrderItem"("postId");

ALTER TABLE "CartItem"
    ADD CONSTRAINT "CartItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem"
    ADD CONSTRAINT "CartItem_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder"
    ADD CONSTRAINT "PurchaseOrder_buyerId_fkey"
    FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem"
    ADD CONSTRAINT "PurchaseOrderItem_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem"
    ADD CONSTRAINT "PurchaseOrderItem_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderItem"
    ADD CONSTRAINT "PurchaseOrderItem_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
