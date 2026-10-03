CREATE TYPE "OrderItemFulfillmentStatus" AS ENUM (
    'PENDING_HANDOFF',
    'READY_FOR_PICKUP',
    'SHIPPED',
    'COMPLETED'
);

CREATE TYPE "FulfillmentMethod" AS ENUM ('PICKUP', 'SHIPPING');

ALTER TABLE "PurchaseOrderItem"
    ADD COLUMN "fulfillmentStatus" "OrderItemFulfillmentStatus" NOT NULL DEFAULT 'PENDING_HANDOFF',
    ADD COLUMN "fulfillmentMethod" "FulfillmentMethod",
    ADD CONSTRAINT "PurchaseOrderItem_fulfillment_state_check" CHECK (
        ("fulfillmentStatus" = 'PENDING_HANDOFF' AND "fulfillmentMethod" IS NULL)
        OR ("fulfillmentStatus" = 'READY_FOR_PICKUP' AND "fulfillmentMethod" = 'PICKUP')
        OR ("fulfillmentStatus" = 'SHIPPED' AND "fulfillmentMethod" = 'SHIPPING')
        OR ("fulfillmentStatus" = 'COMPLETED' AND "fulfillmentMethod" IS NOT NULL)
    );

CREATE INDEX "PurchaseOrderItem_sellerId_fulfillmentStatus_idx"
    ON "PurchaseOrderItem"("sellerId", "fulfillmentStatus");
