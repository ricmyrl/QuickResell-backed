import { Router, type Request } from "express";
import type { Post, User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { CartPaymentError, finalizeCartCheckout } from "../services/cartCheckout.js";

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
    order = await finalizeCartCheckout(normalizedPaymentReference, buyer.id);
  } catch (error) {
    if (error instanceof CartError || error instanceof CartPaymentError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  if (!order) {
    response.status(400).json({ error: "Your cart is empty." });
    return;
  }
  response.status(200).json({ order });
});

export default router;
