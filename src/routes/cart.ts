import axios from "axios";
import { Router, type Request } from "express";
import type { Post, User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const maxQuantity = 50;
class CartError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CartError";
  }
}

const cartInclude = {
  post: {
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" as const } },
      user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true } },
      auctionRoom: { select: { id: true, status: true, highestBidderId: true, currentHighestBid: true, endsAt: true } },
    },
  },
};

router.use("/cart", requireSupabaseUser);

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxQuantity;
}

function isAvailable(post: Post & { auctionRoom?: { status: string } | null }, userId: string, quantity: number): boolean {
  const roomUnavailable = post.auctionRoom && post.auctionRoom.status !== "CLOSED";
  return post.status === "ACTIVE" && post.sellerId !== userId && !roomUnavailable && post.quantityAvailable >= quantity;
}

function isAuctionCartItemAvailable(
  item: { auctionRoomId: string | null; post: { auctionRoom?: { id: string; status: string; highestBidderId: string | null } | null } },
  userId: string,
): boolean {
  const room = item.post.auctionRoom;
  return Boolean(item.auctionRoomId && room
    && item.auctionRoomId === room.id
    && room.status === "SOLD"
    && room.highestBidderId === userId);
}

async function verifyPaystackReference(reference: string, buyerId: string): Promise<{ subtotalUsdCents: number; cartItemIds: string[] }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new CartError("PAYSTACK_SECRET_KEY is not configured.", 500);

  try {
    const response = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const transaction = response.data?.data;

    if (!transaction || transaction.status !== "success" || transaction.reference !== reference || transaction.currency !== "NGN" || transaction.metadata?.userId !== buyerId) {
      throw new CartError("Payment verification failed or the transaction is not complete.", 402);
    }

    const subtotalUsdCents = Number(transaction.metadata?.cartSubtotalUsdCents);
    const cartItemIds: unknown = transaction.metadata?.cartItemIds;
    const initializedAmountKobo = Number(transaction.metadata?.paymentAmountKobo);
    if (!Number.isSafeInteger(subtotalUsdCents)
      || subtotalUsdCents <= 0
      || !Array.isArray(cartItemIds)
      || cartItemIds.length === 0
      || cartItemIds.length > 100
      || !cartItemIds.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
      || new Set(cartItemIds).size !== cartItemIds.length
      || !Number.isSafeInteger(initializedAmountKobo)
      || Number(transaction.amount) !== initializedAmountKobo) {
      throw new CartError("The payment amount does not match the order total.", 402);
    }
    return { subtotalUsdCents, cartItemIds };
  } catch (error) {
    if (error instanceof CartError) throw error;
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Payment verification failed.";
    throw new CartError(message, 402);
  }
}

router.get("/cart", async (request, response) => {
  const buyer = currentUser(request);
  const items = await prisma.cartItem.findMany({
    where: { userId: buyer.id },
    orderBy: { createdAt: "asc" },
    include: cartInclude,
  });
  response.json({ items: items.map((item) => ({
    ...item,
    available: item.auctionRoomId
      ? isAuctionCartItemAvailable(item, buyer.id)
      : isAvailable(item.post, buyer.id, item.quantity),
    unitPriceCents: Math.round((item.auctionRoomId && item.post.auctionRoom
      ? item.post.auctionRoom.currentHighestBid
      : item.post.price) * 100),
    auction: item.auctionRoomId && item.post.auctionRoom ? {
      roomId: item.post.auctionRoom.id,
      status: item.post.auctionRoom.status,
      endsAt: item.post.auctionRoom.endsAt,
      isHighestBidder: item.post.auctionRoom.highestBidderId === buyer.id,
      currentHighestBid: item.post.auctionRoom.currentHighestBid,
    } : null,
  })) });
});

router.use("/cart/items", requireConfirmedEmail);
router.post("/cart/items", async (request, response) => {
  const buyer = currentUser(request);
  const { postId, quantity = 1 } = request.body ?? {};
  if (typeof postId !== "string" || !postId.trim() || !validQuantity(quantity)) {
    response.status(400).json({ error: "postId and an integer quantity between 1 and 50 are required." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${buyer.id}::uuid FOR UPDATE
    `;
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Post" WHERE "id" = ${postId} FOR UPDATE
    `;
    if (!locked.length) return { error: "Listing not found.", status: 404 as const };

    const post = await transaction.post.findUnique({ where: { id: postId }, include: { auctionRoom: { select: { status: true } } } });
    if (!post) return { error: "Listing not found.", status: 404 as const };
    const existing = await transaction.cartItem.findUnique({ where: { userId_postId: { userId: buyer.id, postId } } });
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (!isAvailable(post, buyer.id, nextQuantity)) {
      return { error: "This item is unavailable, is part of a live auction, or exceeds available stock.", status: 409 as const };
    }

    const item = await transaction.cartItem.upsert({
      where: { userId_postId: { userId: buyer.id, postId } },
      create: { userId: buyer.id, postId, quantity },
      update: { quantity: nextQuantity },
      include: cartInclude,
    });
    return { item: { ...item, available: true, unitPriceCents: Math.round(item.post.price * 100) } };
  });

  if ("error" in result) {
    response.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  response.status(200).json(result);
});

router.use("/cart/items/:postId", requireConfirmedEmail);
router.patch("/cart/items/:postId", async (request, response) => {
  const buyer = currentUser(request);
  const postId = request.params.postId;
  const quantity = request.body?.quantity;
  if (!validQuantity(quantity)) {
    response.status(400).json({ error: "quantity must be an integer between 1 and 50." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${buyer.id}::uuid FOR UPDATE
    `;
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Post" WHERE "id" = ${postId} FOR UPDATE
    `;
    if (!locked.length) return { error: "Listing not found.", status: 404 as const };
    const [item, post] = await Promise.all([
      transaction.cartItem.findUnique({ where: { userId_postId: { userId: buyer.id, postId } } }),
      transaction.post.findUnique({ where: { id: postId }, include: { auctionRoom: { select: { status: true } } } }),
    ]);
    if (!item || !post) return { error: "Cart item not found.", status: 404 as const };
    if (item.auctionRoomId) {
      return { error: "Auction cart items have a fixed quantity and cannot be changed.", status: 409 as const };
    }
    if (!isAvailable(post, buyer.id, quantity)) {
      return { error: "Requested quantity is no longer available.", status: 409 as const };
    }
    const updated = await transaction.cartItem.update({
      where: { userId_postId: { userId: buyer.id, postId } },
      data: { quantity },
      include: cartInclude,
    });
    return { item: { ...updated, available: true, unitPriceCents: Math.round(updated.post.price * 100) } };
  });

  if ("error" in result) {
    response.status(result.status ?? 500).json({ error: result.error });
    return;
  }
  response.json(result);
});

router.use("/cart/items/:postId", requireConfirmedEmail);
router.delete("/cart/items/:postId", async (request, response) => {
  const buyer = currentUser(request);
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${buyer.id}::uuid FOR UPDATE
    `;
    await transaction.cartItem.deleteMany({ where: { userId: buyer.id, postId: request.params.postId } });
  });
  response.status(204).end();
});

router.use("/cart/checkout", requireConfirmedEmail);
router.post("/cart/checkout", async (request, response) => {
  const buyer = currentUser(request);
  const paymentReference = request.body?.paymentReference;
  if (typeof paymentReference !== "string" || paymentReference.trim().length < 8 || paymentReference.length > 100) {
    response.status(400).json({ error: "A valid payment reference is required to check out." });
    return;
  }
  const normalizedPaymentReference = paymentReference.trim();
  let order;
  try {
    order = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${buyer.id}::uuid FOR UPDATE
      `;
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CartItem" WHERE "userId" = ${buyer.id}::uuid ORDER BY "postId" FOR UPDATE
      `;
      const existingOrder = await transaction.purchaseOrder.findUnique({ where: { paymentReference: normalizedPaymentReference } });
      if (existingOrder) throw new CartError("This payment has already been used.", 409);
      const cartItems = await transaction.cartItem.findMany({
        where: { userId: buyer.id },
        orderBy: { postId: "asc" },
      });
      if (cartItems.length === 0) return null;
      const verifiedPayment = await verifyPaystackReference(normalizedPaymentReference, buyer.id);
      const payableCartItemIds = new Set(verifiedPayment.cartItemIds);
      if (verifiedPayment.cartItemIds.some((id) => !cartItems.some((item) => item.id === id))) {
        throw new CartError("Your cart changed after payment started. Contact support with your payment reference.", 409);
      }

      const purchaseLines: Array<{ post: Post; quantity: number; unitPriceCents: number; isAuction: boolean }> = [];
      for (const item of cartItems) {
        if (!payableCartItemIds.has(item.id)) continue;
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Post" WHERE "id" = ${item.postId} FOR UPDATE
        `;
        if (!locked.length) throw new CartError("A listing in your cart no longer exists. Refresh the cart and try again.", 409);
        const post = await transaction.post.findUnique({
          where: { id: item.postId },
          include: { auctionRoom: { select: { id: true, status: true, highestBidderId: true, currentHighestBid: true } } },
        });
        if (!post) {
          throw new CartError("An item in your cart is no longer available. Refresh the cart and try again.", 409);
        }
        if (item.auctionRoomId) {
          if (item.auctionRoomId !== post.auctionRoom?.id) {
            throw new CartError(`“${post.title}” is no longer available in the requested quantity.`, 409);
          }
          if (!isAuctionCartItemAvailable({ auctionRoomId: item.auctionRoomId, post }, buyer.id)) continue;
        } else if (!isAvailable(post, buyer.id, item.quantity)) {
          throw new CartError(`“${post.title}” is no longer available in the requested quantity.`, 409);
        }
        const unitPriceCents = Math.round((item.auctionRoomId && post.auctionRoom
          ? post.auctionRoom.currentHighestBid
          : post.price) * 100);
        if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
          throw new CartError(`“${post.title}” has an invalid asking price.`, 409);
        }
        purchaseLines.push({ post, quantity: item.quantity, unitPriceCents, isAuction: Boolean(item.auctionRoomId) });
      }

      if (purchaseLines.length === 0) return null;
      const subtotalCents = purchaseLines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
      if (!Number.isSafeInteger(subtotalCents)) throw new CartError("The order total is too large to process.", 400);
      if (subtotalCents !== verifiedPayment.subtotalUsdCents) {
        throw new CartError("The payable items changed after payment started. Contact support with your payment reference.", 409);
      }

      const createdOrder = await transaction.purchaseOrder.create({
        data: {
          buyerId: buyer.id,
          paymentReference: normalizedPaymentReference,
          subtotalCents,
          items: { create: purchaseLines.map(({ post, quantity, unitPriceCents }) => ({
            postId: post.id,
            sellerId: post.sellerId,
            title: post.title,
            quantity,
            unitPriceCents,
          })) },
        },
        include: { items: true },
      });

      const sellerOrderLines = new Map<string, string[]>();
      for (const line of purchaseLines) {
        const titles = sellerOrderLines.get(line.post.sellerId) ?? [];
        titles.push(line.post.title);
        sellerOrderLines.set(line.post.sellerId, titles);
      }
      await transaction.notification.createMany({
        data: [
          {
            userId: buyer.id,
            type: "ORDER_UPDATE",
            title: "Order placed",
            message: `Your payment was confirmed and your order for ${purchaseLines.length === 1 ? "1 item" : `${purchaseLines.length} items`} is recorded. You can track it in My Orders.`,
            entityType: "ORDER",
            entityId: createdOrder.id,
          },
          ...Array.from(sellerOrderLines, ([sellerId, titles]) => ({
            userId: sellerId,
            type: "ORDER_UPDATE" as const,
            title: "New order received",
            message: `A buyer placed an order for ${titles.join(", ")}. Review it in Seller Studio and arrange fulfillment.`,
            entityType: "ORDER",
            entityId: createdOrder.id,
          })),
        ],
      });

      for (const line of purchaseLines.filter((purchaseLine) => !purchaseLine.isAuction)) {
        const quantityAvailable = line.post.quantityAvailable - line.quantity;
        await transaction.post.update({
          where: { id: line.post.id },
          data: { quantityAvailable, ...(quantityAvailable === 0 ? { status: "SOLD" } : {}) },
        });
      }
      await transaction.cartItem.deleteMany({
        where: { userId: buyer.id, postId: { in: purchaseLines.map((line) => line.post.id) } },
      });
      return createdOrder;
    });
  } catch (error) {
    if (error instanceof CartError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  if (!order) {
    response.status(400).json({ error: "Your cart is empty." });
    return;
  }
  response.status(201).json({ order });
});

export default router;
