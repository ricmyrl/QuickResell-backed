import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requirePasskeyVerification, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { cashOutSellerOrderItem, SellerCashoutError } from "../services/sellerPayouts.js";

const router = Router();
const fulfillmentMethods = ["PICKUP", "SHIPPING"] as const;
type FulfillmentMethod = typeof fulfillmentMethods[number];

function isFulfillmentMethod(value: unknown): value is FulfillmentMethod {
  return value === "PICKUP" || value === "SHIPPING";
}

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

router.use("/orders", requireSupabaseUser);
router.get("/orders/mine", async (request, response) => {
  const buyer = currentUser(request);
  const orders = await prisma.purchaseOrder.findMany({
    where: { buyerId: buyer.id },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: { seller: { select: { displayName: true } } },
      },
    },
  });
  response.json({
    orders: orders.map(({ paymentReference, ...order }) => ({
      ...order,
      paymentStatus: paymentReference ? "PAID" : "UNPAID",
    })),
  });
});

router.post("/orders/items/:itemId/complete", requireConfirmedEmail, async (request, response) => {
  const buyer = currentUser(request);
  const itemId = request.params.itemId;
  if (typeof itemId !== "string") {
    response.status(400).json({ error: "A valid order item ID is required." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    const item = await transaction.purchaseOrderItem.findFirst({
      where: { id: itemId, order: { buyerId: buyer.id } },
      include: { order: true },
    });
    if (!item) return { error: "Order item not found.", status: 404 as const };
    if (!["READY_FOR_PICKUP", "SHIPPED"].includes(item.fulfillmentStatus)) {
      return { error: "This item is not ready to be marked received.", status: 409 as const };
    }

    const updated = await transaction.purchaseOrderItem.updateMany({
      where: { id: item.id, order: { buyerId: buyer.id }, fulfillmentStatus: item.fulfillmentStatus },
      data: { fulfillmentStatus: "COMPLETED" },
    });
    if (updated.count !== 1) return { error: "This order item has already changed.", status: 409 as const };

    const items = await transaction.purchaseOrderItem.findMany({
      where: { orderId: item.orderId },
      select: { id: true, fulfillmentStatus: true },
    });
    const completed = items.every((orderItem) => orderItem.id === item.id || orderItem.fulfillmentStatus === "COMPLETED");
    if (completed) {
      await transaction.purchaseOrder.update({ where: { id: item.orderId }, data: { status: "COMPLETED" } });
    }
    await transaction.notification.create({
      data: {
        userId: item.sellerId,
        type: "ORDER_UPDATE",
        title: "Order received",
        message: `${item.title} was marked as received by the buyer.`,
        entityType: "ORDER_ITEM",
        entityId: item.id,
      },
    });
    return { item: { ...item, fulfillmentStatus: "COMPLETED" as const } };
  });

  if ("error" in result) {
    response.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  response.json(result);
});

router.use("/seller/orders", requireSupabaseUser);
router.get("/seller/orders", async (request, response) => {
  const seller = currentUser(request);
  const items = await prisma.purchaseOrderItem.findMany({
    where: { sellerId: seller.id },
    orderBy: { createdAt: "desc" },
    include: {
      sellerPayout: {
        select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
      },
      order: {
        select: {
          id: true,
          createdAt: true,
          paymentReference: true,
          buyer: { select: { displayName: true } },
        },
      },
    },
  });
  const itemsWithPayouts = items.map(({ order, ...item }) => {
    return {
      ...item,
      order: { id: order.id, createdAt: order.createdAt, buyer: order.buyer },
      sellerPayout: item.sellerPayout,
      paymentStatus: order.paymentReference ? "PAID" as const : "UNPAID" as const,
    };
  });
  response.json({ items: itemsWithPayouts });
});

router.post("/seller/orders/:itemId/cashout", requireConfirmedEmail, requirePasskeyVerification, async (request, response) => {
  const seller = currentUser(request);
  const itemId = request.params.itemId;
  if (typeof itemId !== "string" || !itemId.trim()) {
    response.status(400).json({ error: "A valid order item ID is required." });
    return;
  }
  try {
    const payout = await cashOutSellerOrderItem(itemId, seller.id);
    response.json({
      payout: {
        id: payout.id,
        status: payout.status,
        amountKobo: payout.amountKobo,
        updatedAt: payout.updatedAt,
        completedAt: payout.completedAt,
      },
    });
  } catch (error) {
    if (error instanceof SellerCashoutError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/seller/orders/:itemId/fulfillment", requireConfirmedEmail, async (request, response) => {
  const seller = currentUser(request);
  const itemId = request.params.itemId;
  if (typeof itemId !== "string") {
    response.status(400).json({ error: "A valid order item ID is required." });
    return;
  }
  const method = request.body?.method;
  if (!isFulfillmentMethod(method)) {
    response.status(400).json({ error: "Choose pickup or shipping." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    const item = await transaction.purchaseOrderItem.findFirst({
      where: { id: itemId, sellerId: seller.id },
      include: { order: { select: { buyerId: true, paymentReference: true, status: true } } },
    });
    if (!item) return { error: "Order item not found.", status: 404 as const };
    if (!item.order.paymentReference) return { error: "Payment must be confirmed before fulfillment.", status: 409 as const };
    if (item.order.status === "CANCELLED") return { error: "A cancelled order cannot be fulfilled.", status: 409 as const };
    if (item.fulfillmentStatus !== "PENDING_HANDOFF") {
      return { error: "This order item already has a fulfillment update.", status: 409 as const };
    }

    const status = method === "PICKUP" ? "READY_FOR_PICKUP" : "SHIPPED";
    const updated = await transaction.purchaseOrderItem.updateMany({
      where: { id: item.id, sellerId: seller.id, fulfillmentStatus: "PENDING_HANDOFF" },
      data: { fulfillmentMethod: method, fulfillmentStatus: status },
    });
    if (updated.count !== 1) return { error: "This order item has already changed.", status: 409 as const };

    const earningsCents = item.quantity * item.unitPriceCents - item.sellerFeeCents;
    if (earningsCents > 0) {
      const wallet = await transaction.wallet.upsert({
        where: { userId: seller.id },
        create: { userId: seller.id, balanceCents: earningsCents },
        update: { balanceCents: { increment: earningsCents } },
        select: { id: true },
      });
      await transaction.walletTransaction.create({
        data: {
          walletId: wallet.id,
          paymentReference: `QR-SEARN-${item.id}`,
          amountCents: earningsCents,
          type: "SELLER_EARNING",
          direction: "CREDIT",
          orderId: item.orderId,
          orderItemId: item.id,
          status: "COMPLETED",
        },
      });
    }

    const order = await transaction.purchaseOrder.findUniqueOrThrow({
      where: { id: item.orderId },
      select: { buyerId: true },
    });
    await transaction.notification.create({
      data: {
        userId: order.buyerId,
        type: "ORDER_UPDATE",
        title: method === "PICKUP" ? "Ready for pickup" : "Order shipped",
        message: method === "PICKUP"
          ? `${item.title} is ready for pickup. Contact the seller to arrange a public meetup.`
          : `${item.title} has been marked as shipped by the seller.`,
        entityType: "ORDER_ITEM",
        entityId: item.id,
      },
    });
    const updatedItem = await transaction.purchaseOrderItem.findUniqueOrThrow({
      where: { id: item.id },
      include: {
        sellerPayout: {
          select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
        },
        order: {
          select: {
            id: true,
            createdAt: true,
            buyer: { select: { displayName: true } },
          },
        },
      },
    });
    return {
      item: {
        ...updatedItem,
        paymentStatus: "PAID" as const,
      },
    };
  });

  if ("error" in result) {
    response.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  response.json(result);
});

export default router;
