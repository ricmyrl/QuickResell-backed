import { Router, type Request } from "express";
import type { AuctionRoom, Bid, Prisma, User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { notifyAuctionResolution, notifyBidActivity } from "../lib/notifications.js";
import { sendAuctionWonEmail } from "../services/mail.js";
import { processAuctionAutoBid } from "../services/autoBidding.js";

const router = Router();
const antiSnipeWindowMs = 10_000;
const antiSnipeExtensionMs = 30_000;
const maxAuctionDurationMs = 30 * 24 * 60 * 60 * 1000;

export type AuctionVerdict = "ACCEPT" | "REJECT";
type AuctionVerdictRequest = { decision: AuctionVerdict };
type RouteError = { error: string; status: 400 | 403 | 404 | 409 };
type BidPlacementResult = RouteError | { bid: Bid; auctionRoom: AuctionRoom };
type CloseAuctionResult = RouteError | { auctionRoom: AuctionRoom; alreadyFinalized: boolean };
type VerdictResult = RouteError | { auctionRoom: AuctionRoom; trustScore: number };
let finalizationInProgress = false;

async function notifyAcceptedWinner(
  auctionRoomId: string,
  highestBidderId: string | null,
  itemTitle: string,
  finalPrice: number,
): Promise<void> {
  if (!highestBidderId) return;

  try {
    const winner = await prisma.user.findUnique({
      where: { id: highestBidderId },
      select: { email: true },
    });

    if (!winner?.email) {
      console.warn("Auction winner email is missing; skipping receipt delivery.", {
        auctionRoomId,
        highestBidderId,
      });
      return;
    }

    await sendAuctionWonEmail(winner.email, itemTitle, finalPrice);
  } catch (error) {
    console.error("Failed to send auction win email after seller verdict.", {
      auctionRoomId,
      highestBidderId,
      itemTitle,
      finalPrice,
      error,
    });
  }
}

function isAuctionVerdictRequest(value: unknown): value is AuctionVerdictRequest {
  if (typeof value !== "object" || value === null || !("decision" in value)) return false;
  return value.decision === "ACCEPT" || value.decision === "REJECT";
}

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function lockAuctionRoom(
  transaction: Prisma.TransactionClient,
  auctionRoomId: string,
): Promise<AuctionRoom | undefined> {
  const rows = await transaction.$queryRaw<AuctionRoom[]>`
    SELECT * FROM "AuctionRoom" WHERE "id" = ${auctionRoomId} FOR UPDATE
  `;
  return rows[0];
}

async function moveExpiredAuctionToApproval(
  transaction: Prisma.TransactionClient,
  room: AuctionRoom,
  now: Date,
  endEarly = false,
): Promise<AuctionRoom> {
  if (room.status !== "ACTIVE" || (!endEarly && room.endsAt > now)) return room;

  const reserveMet = room.highestBidderId !== null &&
    (room.reservePrice === null || room.currentHighestBid >= room.reservePrice);
  return transaction.auctionRoom.update({
    where: { id: room.id },
    data: {
      status: reserveMet ? "PENDING_APPROVAL" : "CLOSED",
      ...(endEarly ? { endsAt: now } : {}),
    },
  });
}

export async function finalizeExpiredAuctions(): Promise<void> {
  if (finalizationInProgress) return;
  finalizationInProgress = true;

  try {
    const now = new Date();
    await prisma.$executeRaw`
      WITH expired AS (
        SELECT "id"
        FROM "AuctionRoom"
        WHERE "status" = 'ACTIVE'::"AuctionRoomStatus"
          AND "endsAt" <= ${now}
        ORDER BY "endsAt" ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AuctionRoom" AS room
      SET "status" = CASE
            WHEN room."highestBidderId" IS NOT NULL
              AND (room."reservePrice" IS NULL OR room."currentHighestBid" >= room."reservePrice")
            THEN 'PENDING_APPROVAL'::"AuctionRoomStatus"
            ELSE 'CLOSED'::"AuctionRoomStatus"
          END,
          "updatedAt" = ${now}
      FROM expired
      WHERE room."id" = expired."id"
    `;
  } finally {
    finalizationInProgress = false;
  }
}

router.use("/listings/:listingId/auction", requireSupabaseUser, requireConfirmedEmail);
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
  const isPublic = request.body?.isPublic ?? true;
  if (typeof isPublic !== "boolean") {
    response.status(400).json({ error: "isPublic must be a boolean." });
    return;
  }
  const reservePrice = request.body?.reservePrice;
  if (reservePrice !== undefined && reservePrice !== null &&
      (typeof reservePrice !== "number" || !Number.isFinite(reservePrice) || reservePrice < listing.price)) {
    response.status(400).json({ error: "reservePrice must be a finite number at least equal to the listing price." });
    return;
  }

  try {
    const auctionRoom = await prisma.auctionRoom.create({
      data: {
        postId: listing.id,
        sellerId: seller.id,
        currentHighestBid: listing.price,
        endsAt,
        isPublic,
        reservePrice: reservePrice ?? null,
      },
      include: {
        post: { select: { id: true, title: true, price: true, locationCampus: true, category: { select: { name: true } }, images: { take: 1, orderBy: { sortOrder: "asc" } } } },
      },
    });
    response.status(201).json({ auctionRoom });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
    response.status(409).json({ error: "An auction room already exists for this listing." });
  }
});

router.use("/auctions/mine", requireSupabaseUser);
router.get("/auctions/mine", async (request, response) => {
  const seller = currentUser(request);
  const [auctionRooms, sellerStats] = await Promise.all([
    prisma.auctionRoom.findMany({
      where: { sellerId: seller.id },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      include: {
        post: {
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            locationCampus: true,
            category: { select: { name: true } },
            images: { take: 1, orderBy: { sortOrder: "asc" } },
          },
        },
        seller: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true } },
        bids: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 50,
          include: { bidder: { select: { id: true, displayName: true, avatarUrl: true } } },
        },
      },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: seller.id },
      select: { trustScore: true, completedAuctions: true },
    }),
  ]);
  response.json({ auctionRooms, seller: sellerStats });
});

router.get("/auctions", async (request, response) => {
  const requestedLimit = Number(request.query.limit ?? 20);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    response.status(400).json({ error: "limit must be an integer between 1 and 50." });
    return;
  }

  const cursorId = request.query.cursor;
  if (cursorId !== undefined && typeof cursorId !== "string") {
    response.status(400).json({ error: "cursor must be a room ID." });
    return;
  }
  if (typeof cursorId === "string") {
    const cursorExists = await prisma.auctionRoom.findFirst({
      where: {
        id: cursorId,
        isPublic: true,
        status: "ACTIVE",
        endsAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!cursorExists) {
      response.status(400).json({ error: "cursor does not match an active public auction room." });
      return;
    }
  }

  const rows = await prisma.auctionRoom.findMany({
    where: { isPublic: true, status: "ACTIVE", endsAt: { gt: new Date() } },
    orderBy: [{ endsAt: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    ...(typeof cursorId === "string" ? { cursor: { id: cursorId }, skip: 1 } : {}),
    take: requestedLimit + 1,
    include: {
      post: {
        select: {
          id: true,
          title: true,
          price: true,
          locationCampus: true,
          category: { select: { name: true } },
          images: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
      seller: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true } },
    },
  });
  const hasMore = rows.length > requestedLimit;
  const auctionRooms = hasMore ? rows.slice(0, requestedLimit) : rows;
  response.json({
    auctionRooms,
    nextCursor: hasMore ? auctionRooms[auctionRooms.length - 1]?.id ?? null : null,
  });
});

router.get("/auctions/:auctionRoomId", async (request, response) => {
  const auctionRoom = await prisma.auctionRoom.findUnique({
    where: { id: request.params.auctionRoomId },
    include: {
      post: {
        select: {
          id: true,
          title: true,
          description: true,
          price: true,
          locationCampus: true,
          category: { select: { name: true } },
          images: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
      seller: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true } },
      highestBidder: { select: { id: true, displayName: true, avatarUrl: true } },
      bids: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        include: { bidder: { select: { id: true, displayName: true, avatarUrl: true } } },
      },
    },
  });

  if (!auctionRoom) {
    response.status(404).json({ error: "Auction room not found." });
    return;
  }
  response.json({ auctionRoom });
});

router.use("/auctions/:auctionRoomId/bids", requireSupabaseUser, requireConfirmedEmail);
router.post("/auctions/:auctionRoomId/bids", async (request, response) => {
  const bidder = currentUser(request);
  const amount = request.body?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    response.status(400).json({ error: "amount must be a finite, non-negative number." });
    return;
  }

  const result = await prisma.$transaction<BidPlacementResult>(async (transaction) => {
    const room = await lockAuctionRoom(transaction, request.params.auctionRoomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.sellerId === bidder.id) {
      return { error: "Sellers cannot bid in their own auction.", status: 403 as const };
    }

    const now = new Date();
    if (room.status !== "ACTIVE" || room.endsAt <= now) {
      if (room.status === "ACTIVE") {
        await moveExpiredAuctionToApproval(transaction, room, now);
      }
      return { error: "This auction is closed or has expired.", status: 409 as const };
    }
    const listing = await transaction.post.findUnique({
      where: { id: room.postId },
      select: { price: true },
    });
    if (!listing) return { error: "Auction listing not found.", status: 404 as const };
    const minimumBid = Math.max(room.currentHighestBid, listing.price);
    if (amount <= minimumBid) {
      return {
        error: `Bid must be greater than the current minimum of ${minimumBid}.`,
        status: 400 as const,
      };
    }

    const shouldExtend = room.endsAt.getTime() - now.getTime() <= antiSnipeWindowMs;
    const endsAt = shouldExtend
      ? new Date(room.endsAt.getTime() + antiSnipeExtensionMs)
      : room.endsAt;
    const bid = await transaction.bid.create({
      data: { auctionRoomId: room.id, bidderId: bidder.id, amount },
    });
    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: room.id },
      data: {
        currentHighestBid: amount,
        highestBidderId: bidder.id,
        endsAt,
      },
    });

    const itemTitle = await transaction.post.findUnique({
      where: { id: room.postId },
      select: { title: true },
    });

    if (itemTitle) {
      await notifyBidActivity({
        auctionRoomId: room.id,
        auctionTitle: itemTitle.title,
        sellerId: room.sellerId,
        previousBidderId: room.highestBidderId,
        bidderId: bidder.id,
        amount,
      });
    }

    return { bid, auctionRoom };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  const automaticBid = await processAuctionAutoBid(result.auctionRoom.id);
  response.status(201).json({
    ...result,
    auctionRoom: automaticBid.auctionRoom ?? result.auctionRoom,
    automaticBid: automaticBid.bid,
  });
});

router.use("/auctions/:auctionRoomId/close", requireSupabaseUser, requireConfirmedEmail);
router.post("/auctions/:auctionRoomId/close", async (request, response) => {
  const actor = currentUser(request);
  const result = await prisma.$transaction<CloseAuctionResult>(async (transaction) => {
    const room = await lockAuctionRoom(transaction, request.params.auctionRoomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.status !== "ACTIVE") return { auctionRoom: room, alreadyFinalized: true };

    const isSeller = room.sellerId === actor.id;
    if (!isSeller && room.endsAt > new Date()) {
      return { error: "Only the seller can close an auction before its expiration.", status: 403 as const };
    }

    const auctionRoom = await moveExpiredAuctionToApproval(
      transaction,
      room,
      new Date(),
      isSeller && room.endsAt > new Date(),
    );
    if (auctionRoom.status === "CLOSED") {
      await transaction.post.update({
        where: { id: room.postId },
        data: { status: "ACTIVE" },
      });
    }
    return { auctionRoom, alreadyFinalized: false };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  response.json(result);
});

router.use("/auctions/:roomId/verdict", requireSupabaseUser, requireConfirmedEmail);
router.post("/auctions/:roomId/verdict", async (request, response) => {
  const seller = currentUser(request);
  const body: unknown = request.body;
  if (!isAuctionVerdictRequest(body)) {
    response.status(400).json({ error: 'decision must be either "ACCEPT" or "REJECT".' });
    return;
  }
  const { decision } = body;

  const result = await prisma.$transaction<VerdictResult>(async (transaction) => {
    const room = await lockAuctionRoom(transaction, request.params.roomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.sellerId !== seller.id) {
      return { error: "Only the auction seller can submit a verdict.", status: 403 as const };
    }

    const now = new Date();
    const currentRoom = await moveExpiredAuctionToApproval(transaction, room, now);
    if (currentRoom.status !== "PENDING_APPROVAL") {
      return {
        error: "This auction is not awaiting seller approval. It may be active, already decided, or below reserve.",
        status: 409 as const,
      };
    }
    if (!currentRoom.highestBidderId) {
      return { error: "There is no winning bidder to approve.", status: 409 as const };
    }

    if (decision === "ACCEPT") {
      const auctionRoom = await transaction.auctionRoom.update({
        where: { id: currentRoom.id },
        data: { status: "SOLD" },
      });
      await transaction.post.update({
        where: { id: currentRoom.postId },
        data: { status: "SOLD" },
      });
      await transaction.$executeRaw`
        UPDATE "User"
        SET "completedAuctions" = "completedAuctions" + 1,
            "trustScore" = LEAST(100.0, "trustScore" + 5.0)
        WHERE "id" = ${seller.id}::uuid
      `;
      const updatedSeller = await transaction.user.findUniqueOrThrow({
        where: { id: seller.id },
        select: { trustScore: true },
      });

      const winningListing = await transaction.post.findUnique({
        where: { id: currentRoom.postId },
        select: { title: true },
      });
      if (winningListing) {
        await notifyAuctionResolution({
          userId: currentRoom.highestBidderId,
          auctionRoomId: currentRoom.id,
          auctionTitle: winningListing.title,
          type: "AUCTION_WON",
          finalPrice: currentRoom.currentHighestBid,
        });
      }

      return { auctionRoom, trustScore: updatedSeller.trustScore };
    }

    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: currentRoom.id },
      data: { status: "REJECTED" },
    });
    await transaction.post.update({
      where: { id: currentRoom.postId },
      data: { status: "RESERVED" },
    });
    await transaction.$executeRaw`
      UPDATE "User"
      SET "backedOutAuctions" = "backedOutAuctions" + 1,
          "trustScore" = GREATEST(0.0, "trustScore" - 20.0)
      WHERE "id" = ${seller.id}::uuid
    `;
    const updatedSeller = await transaction.user.findUniqueOrThrow({
      where: { id: seller.id },
      select: { trustScore: true },
    });
    const rejectedListing = await transaction.post.findUnique({
      where: { id: currentRoom.postId },
      select: { title: true },
    });
    if (rejectedListing && currentRoom.highestBidderId) {
      await notifyAuctionResolution({
        userId: currentRoom.highestBidderId,
        auctionRoomId: currentRoom.id,
        auctionTitle: rejectedListing.title,
        type: "AUCTION_CLOSED",
        finalPrice: currentRoom.currentHighestBid,
        reason: "Seller rejected the winning bid",
      });
    }
    return { auctionRoom, trustScore: updatedSeller.trustScore };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }

  if (decision === "ACCEPT") {
    const roomWithPost = await prisma.auctionRoom.findUnique({
      where: { id: result.auctionRoom.id },
      select: {
        highestBidderId: true,
        currentHighestBid: true,
        post: { select: { title: true } },
      },
    });

    if (roomWithPost?.highestBidderId && roomWithPost.post) {
      void notifyAcceptedWinner(
        result.auctionRoom.id,
        roomWithPost.highestBidderId,
        roomWithPost.post.title,
        roomWithPost.currentHighestBid,
      );
    }
  }

  response.json(result);
});

export default router;
