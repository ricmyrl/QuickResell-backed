import { Router, type Request } from "express";
import type { AuctionRoom, User } from "../generated/prisma/client.js";
import { requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const antiSnipeWindowMs = 10_000;
const antiSnipeExtensionMs = 30_000;
const maxAuctionDurationMs = 30 * 24 * 60 * 60 * 1000;

router.use(requireSupabaseUser);

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function lockAuctionRoom(
  transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  auctionRoomId: string,
): Promise<AuctionRoom | undefined> {
  const rows = await transaction.$queryRaw<AuctionRoom[]>`
    SELECT * FROM "AuctionRoom" WHERE "id" = ${auctionRoomId} FOR UPDATE
  `;
  return rows[0];
}

router.post("/listings/:listingId/auction", async (request, response) => {
  const seller = currentUser(request);
  const endsAtInput = request.body?.endsAt;
  if (typeof endsAtInput !== "string" || !endsAtInput.trim()) {
    response.status(400).json({ error: "endsAt must be a valid ISO-8601 date-time." });
    return;
  }

  const endsAt = new Date(endsAtInput);
  const now = Date.now();
  if (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= now ||
      endsAt.getTime() > now + maxAuctionDurationMs) {
    response.status(400).json({ error: "endsAt must be in the future and no more than 30 days away." });
    return;
  }

  const listing = await prisma.post.findUnique({
    where: { id: request.params.listingId },
    select: { id: true, sellerId: true, price: true, status: true },
  });
  if (!listing) {
    response.status(404).json({ error: "Listing not found." });
    return;
  }
  if (listing.sellerId !== seller.id) {
    response.status(403).json({ error: "Only the listing seller can create its auction." });
    return;
  }
  if (listing.status !== "ACTIVE") {
    response.status(409).json({ error: "Only active listings can be auctioned." });
    return;
  }
  if (!Number.isFinite(listing.price) || listing.price < 0) {
    response.status(409).json({ error: "The listing has an invalid starting price." });
    return;
  }

  try {
    const auctionRoom = await prisma.auctionRoom.create({
      data: {
        postId: listing.id,
        sellerId: seller.id,
        currentHighestBid: listing.price,
        endsAt,
      },
      include: {
        post: { select: { id: true, title: true, price: true, images: { take: 1, orderBy: { sortOrder: "asc" } } } },
      },
    });
    response.status(201).json({ auctionRoom });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
    response.status(409).json({ error: "An auction room already exists for this listing." });
  }
});

router.post("/auctions/:auctionRoomId/bids", async (request, response) => {
  const bidder = currentUser(request);
  const amount = request.body?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    response.status(400).json({ error: "amount must be a finite, non-negative number." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    const room = await lockAuctionRoom(transaction, request.params.auctionRoomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.sellerId === bidder.id) {
      return { error: "Sellers cannot bid in their own auction.", status: 403 as const };
    }

    const now = new Date();
    if (room.status !== "ACTIVE" || room.endsAt <= now) {
      return { error: "This auction is closed or has expired.", status: 409 as const };
    }
    if (amount <= room.currentHighestBid) {
      return {
        error: `Bid must be greater than the current minimum of ${room.currentHighestBid}.`,
        status: 400 as const,
      };
    }

    const shouldExtend = room.endsAt.getTime() - now.getTime() <= antiSnipeWindowMs;
    const endsAt = shouldExtend
      ? new Date(room.endsAt.getTime() + antiSnipeExtensionMs)
      : room.endsAt;
    const bid = await transaction.bid.create({
      data: { auctionRoomId: room.id, bidderId: bidder.id, amount },
      include: { bidder: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: room.id },
      data: {
        currentHighestBid: amount,
        highestBidderId: bidder.id,
        endsAt,
      },
    });

    return { bid, auctionRoom };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  response.status(201).json(result);
});

router.post("/auctions/:auctionRoomId/close", async (request, response) => {
  const actor = currentUser(request);
  const result = await prisma.$transaction(async (transaction) => {
    const room = await lockAuctionRoom(transaction, request.params.auctionRoomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.status === "CLOSED") return { auctionRoom: room, alreadyClosed: true };

    const isSeller = room.sellerId === actor.id;
    if (!isSeller && room.endsAt > new Date()) {
      return { error: "Only the seller can close an auction before its expiration.", status: 403 as const };
    }

    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: room.id },
      data: { status: "CLOSED" },
      include: {
        post: { select: { id: true, title: true, status: true } },
        highestBidder: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    if (room.highestBidderId) {
      await transaction.post.update({
        where: { id: room.postId },
        data: { status: "SOLD" },
      });
    }

    return { auctionRoom, alreadyClosed: false };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  response.json(result);
});

export default router;
