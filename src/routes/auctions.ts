import { Router, type Request } from "express";
import type { AuctionRoom, Bid, Prisma, User } from "../generated/prisma/client.js";
import { optionalSupabaseUser, requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { notifyAuctionResolution, notifyBidActivity } from "../lib/notifications.js";
import { sendAuctionWonEmail } from "../services/mail.js";
import { processAuctionAutoBid } from "../services/autoBidding.js";
import { isValidManualBidAmount, minimumBidAmount } from "../services/bidLogic.js";
import { auctionPaymentWindowMs, buyerBidSuspensionMonths, buyerDefaultPenaltyPoints } from "../services/auctionPaymentPolicy.js";
import { emptyListingReactionCounts, getListingReactionCounts } from "../services/listingReactions.js";

const router = Router();
const antiSnipeWindowMs = 10_000;
const antiSnipeExtensionMs = 30_000;
export type AuctionVerdict = "ACCEPT" | "REJECT";
type AuctionVerdictRequest = { decision: AuctionVerdict };
type RouteError = { error: string; status: 400 | 403 | 404 | 409 };
type BidPlacementResult = RouteError | { bid: Bid; auctionRoom: AuctionRoom; previousBidderId: string | null; auctionTitle: string };
type CloseAuctionResult = RouteError | { auctionRoom: AuctionRoom; alreadyFinalized: boolean };
type VerdictResult = RouteError | { auctionRoom: AuctionRoom; trustScore: number };
let finalizationInProgress = false;
let unpaidAuctionFinalizationInProgress = false;

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

function hideReservePrice<T extends { reservePrice: number | null }>(room: T) {
  const { reservePrice, ...publicRoom } = room;
  return { ...publicRoom, noReserve: reservePrice === null || reservePrice <= 0 };
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
  const auctionRoom = await transaction.auctionRoom.update({
    where: { id: room.id },
    data: {
      status: reserveMet ? "PENDING_APPROVAL" : "CLOSED",
      ...(endEarly ? { endsAt: now } : {}),
    },
  });
  if (reserveMet && room.highestBidderId) {
    await transaction.cartItem.deleteMany({
      where: { auctionRoomId: room.id, userId: { not: room.highestBidderId } },
    });
  } else {
    await transaction.cartItem.deleteMany({ where: { auctionRoomId: room.id } });
  }
  return auctionRoom;
}

export async function finalizeExpiredAuctions(): Promise<void> {
  if (finalizationInProgress) return;
  finalizationInProgress = true;

  try {
    const now = new Date();
    await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
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
        await transaction.$executeRaw`
          DELETE FROM "CartItem" AS cart
          USING "AuctionRoom" AS room
          WHERE cart."auctionRoomId" = room."id"
            AND (
              room."status" = 'CLOSED'::"AuctionRoomStatus"
              OR (
                room."status" = 'PENDING_APPROVAL'::"AuctionRoomStatus"
                AND room."highestBidderId" IS DISTINCT FROM cart."userId"
              )
            )
        `;
      },
      { maxWait: 2_000, timeout: 5_000 },
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "P2028") {
      console.warn("Skipping expired-auction finalization because the database transaction timed out.");
      return;
    }
    throw error;
  } finally {
    finalizationInProgress = false;
  }
}

export async function finalizeUnpaidAuctionWins(): Promise<void> {
  if (unpaidAuctionFinalizationInProgress) return;
  unpaidAuctionFinalizationInProgress = true;

  try {
    const now = new Date();
    const overdueRooms = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT room."id"
      FROM "AuctionRoom" AS room
      WHERE room."status" = 'SOLD'::"AuctionRoomStatus"
        AND room."buyerDefaultedAt" IS NULL
        AND room."highestBidderId" IS NOT NULL
        AND room."paymentDueAt" <= ${now}
        AND (room."paymentGraceUntil" IS NULL OR room."paymentGraceUntil" <= ${now})
        AND NOT EXISTS (
          SELECT 1
          FROM "PurchaseOrderItem" AS item
          INNER JOIN "PurchaseOrder" AS purchase ON purchase."id" = item."orderId"
          WHERE item."postId" = room."postId"
            AND purchase."buyerId" = room."highestBidderId"
            AND purchase."status" <> 'CANCELLED'::"PurchaseOrderStatus"
        )
      ORDER BY room."paymentDueAt" ASC
      LIMIT 100
    `;

    for (const { id } of overdueRooms) {
      await prisma.$transaction(async (transaction) => {
        const candidate = await transaction.auctionRoom.findUnique({
          where: { id },
          select: { highestBidderId: true },
        });
        if (!candidate?.highestBidderId) return;

        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User" WHERE "id" = ${candidate.highestBidderId}::uuid FOR UPDATE
        `;
        const room = await lockAuctionRoom(transaction, id);
        if (!room?.highestBidderId || room.status !== "SOLD" || room.buyerDefaultedAt) return;
        if (!room.paymentDueAt || room.paymentDueAt > now || (room.paymentGraceUntil && room.paymentGraceUntil > now)) return;

        const paidOrders = await transaction.$queryRaw<Array<{ paid: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM "PurchaseOrderItem" AS item
            INNER JOIN "PurchaseOrder" AS purchase ON purchase."id" = item."orderId"
            WHERE item."postId" = ${room.postId}
              AND purchase."buyerId" = ${room.highestBidderId}::uuid
              AND purchase."status" <> 'CANCELLED'::"PurchaseOrderStatus"
          ) AS paid
        `;
        if (paidOrders[0]?.paid) return;

        await transaction.auctionRoom.update({
          where: { id: room.id },
          data: { status: "CLOSED", buyerDefaultedAt: now },
        });
        const listing = await transaction.post.update({
          where: { id: room.postId },
          data: { status: "ACTIVE" },
          select: { title: true },
        });
        await transaction.$executeRaw`
          UPDATE "User"
          SET "backedOutAuctions" = "backedOutAuctions" + 1,
              "trustScore" = GREATEST(0.0, "trustScore" - ${buyerDefaultPenaltyPoints}),
              "biddingSuspendedUntil" = GREATEST(COALESCE("biddingSuspendedUntil", ${now}), ${now}) + (${buyerBidSuspensionMonths} * INTERVAL '1 month')
          WHERE "id" = ${room.highestBidderId}::uuid
        `;
        await transaction.auctionWatchlistItem.updateMany({
          where: { userId: room.highestBidderId, autoBidEnabled: true },
          data: { autoBidEnabled: false },
        });
        await transaction.cartItem.deleteMany({ where: { auctionRoomId: room.id } });
        await transaction.notification.createMany({
          data: [
            {
              userId: room.highestBidderId,
              type: "ORDER_UPDATE",
              title: "Auction payment deadline missed",
              message: `You did not pay for “${listing.title}” within 24 hours of the seller accepting your bid. Your trust score was reduced by ${buyerDefaultPenaltyPoints} points and bidding is suspended for six months.`,
              entityType: "auction",
              entityId: room.id,
            },
            {
              userId: room.sellerId,
              type: "ORDER_UPDATE",
              title: "Winning buyer did not pay",
              message: `The winning buyer did not pay for “${listing.title}” before the deadline. The listing is active again and available to sell.`,
              entityType: "auction",
              entityId: room.id,
            },
          ],
        });
      });
    }
  } finally {
    unpaidAuctionFinalizationInProgress = false;
  }
}

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

router.get("/auctions", optionalSupabaseUser, async (request, response) => {
  const viewerId = (request as AuthenticatedRequest).marketplaceUser?.id;
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
          _count: { select: { comments: true, listingReactions: true } },
          listingReactions: viewerId
            ? { where: { userId: viewerId }, select: { type: true } }
            : { take: 0, select: { type: true } },
        },
      },
      seller: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true } },
    },
  });
  const hasMore = rows.length > requestedLimit;
  const auctionRooms = hasMore ? rows.slice(0, requestedLimit) : rows;
  const reactionCounts = await getListingReactionCounts(
    auctionRooms.flatMap((room) => room.post ? [room.post.id] : []),
  );
  response.json({
    auctionRooms: auctionRooms.map((room) => ({
      ...hideReservePrice(room),
      post: room.post ? {
        ...room.post,
        reactionCounts: reactionCounts.get(room.post.id) ?? emptyListingReactionCounts(),
      } : room.post,
    })),
    nextCursor: hasMore ? auctionRooms[auctionRooms.length - 1]?.id ?? null : null,
  });
});

router.get("/auctions/:auctionRoomId", optionalSupabaseUser, async (request, response) => {
  const viewerId = (request as AuthenticatedRequest).marketplaceUser?.id;
  const auctionRoomId = request.params.auctionRoomId;
  if (typeof auctionRoomId !== "string") {
    response.status(400).json({ error: "A valid auction room ID is required." });
    return;
  }
  const auctionRoom = await prisma.auctionRoom.findUnique({
    where: { id: auctionRoomId },
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
          _count: { select: { comments: true, listingReactions: true } },
          listingReactions: viewerId
            ? { where: { userId: viewerId }, select: { type: true } }
            : { take: 0, select: { type: true } },
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
  const reactionCounts = auctionRoom.post
    ? (await getListingReactionCounts([auctionRoom.post.id])).get(auctionRoom.post.id) ?? emptyListingReactionCounts()
    : emptyListingReactionCounts();
  response.json({
    auctionRoom: {
      ...(viewerId === auctionRoom.sellerId ? auctionRoom : hideReservePrice(auctionRoom)),
      post: auctionRoom.post ? { ...auctionRoom.post, reactionCounts } : auctionRoom.post,
    },
  });
});

router.use("/auctions/:auctionRoomId/bids", requireSupabaseUser, requireConfirmedEmail);
router.post("/auctions/:auctionRoomId/bids", async (request, response) => {
  const bidder = currentUser(request);
  const amount = request.body?.amount;
  if (!isValidManualBidAmount(amount)) {
    response.status(400).json({ error: "amount must be a finite number greater than zero and within the allowed bid limit." });
    return;
  }

  const result = await prisma.$transaction<BidPlacementResult>(async (transaction) => {
    const now = new Date();
    const bidderRows = await transaction.$queryRaw<Array<{ biddingSuspendedUntil: Date | null }>>`
      SELECT "biddingSuspendedUntil" FROM "User" WHERE "id" = ${bidder.id}::uuid FOR UPDATE
    `;
    const biddingSuspendedUntil = bidderRows[0]?.biddingSuspendedUntil;
    if (biddingSuspendedUntil && biddingSuspendedUntil > now) {
      return {
        error: `Your bidding privileges are suspended until ${biddingSuspendedUntil.toISOString()} because of an unpaid winning bid.`,
        status: 403 as const,
      };
    }
    const room = await lockAuctionRoom(transaction, request.params.auctionRoomId);
    if (!room) return { error: "Auction room not found.", status: 404 as const };
    if (room.sellerId === bidder.id) {
      return { error: "Sellers cannot bid in their own auction.", status: 403 as const };
    }
    if (room.status !== "ACTIVE" || room.endsAt <= now) {
      if (room.status === "ACTIVE") {
        await moveExpiredAuctionToApproval(transaction, room, now);
      }
      return { error: "This auction is closed or has expired.", status: 409 as const };
    }
    const listing = await transaction.post.findUnique({
      where: { id: room.postId },
      select: { price: true, title: true },
    });
    if (!listing) return { error: "Auction listing not found.", status: 404 as const };
    const minimumBid = minimumBidAmount(room.currentHighestBid, listing.price);
    if (amount < minimumBid) {
      return {
        error: `Bid must be at least ${minimumBid}.`,
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
    await transaction.cartItem.upsert({
      where: { userId_postId: { userId: bidder.id, postId: room.postId } },
      create: { userId: bidder.id, postId: room.postId, auctionRoomId: room.id },
      update: { auctionRoomId: room.id, quantity: 1 },
    });

    return { bid, auctionRoom, previousBidderId: room.highestBidderId, auctionTitle: listing.title };
  });

  if ("error" in result) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  try {
    await notifyBidActivity({
      auctionRoomId: result.auctionRoom.id,
      auctionTitle: result.auctionTitle,
      sellerId: result.auctionRoom.sellerId,
      previousBidderId: result.previousBidderId,
      bidderId: bidder.id,
      amount,
    });
  } catch (error) {
    console.error("Bid was recorded, but bid notifications could not be created.", {
      auctionRoomId: result.auctionRoom.id,
      bidId: result.bid.id,
      error,
    });
  }

  let automaticBid: Awaited<ReturnType<typeof processAuctionAutoBid>> = {
    success: false,
    auctionRoom: null,
    bid: null,
  };
  try {
    automaticBid = await processAuctionAutoBid(result.auctionRoom.id);
  } catch (error) {
    console.error("Bid was recorded, but automatic bidding could not be processed.", {
      auctionRoomId: result.auctionRoom.id,
      bidId: result.bid.id,
      error,
    });
  }
  const auctionRoom = await prisma.auctionRoom.findUnique({
    where: { id: result.auctionRoom.id },
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
  if (!auctionRoom) throw new Error("Auction room disappeared after a bid was recorded.");
  response.status(201).json({
    bid: result.bid,
    auctionRoom,
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
      const paymentDueAt = new Date(now.getTime() + auctionPaymentWindowMs);
      const auctionRoom = await transaction.auctionRoom.update({
        where: { id: currentRoom.id },
        data: { status: "SOLD", paymentDueAt, paymentGraceUntil: null, paymentGraceUsed: false },
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
      await transaction.cartItem.deleteMany({
        where: { auctionRoomId: currentRoom.id, userId: { not: currentRoom.highestBidderId } },
      });

      return { auctionRoom, trustScore: updatedSeller.trustScore };
    }

    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: currentRoom.id },
      data: { status: "REJECTED" },
    });
    await transaction.cartItem.deleteMany({ where: { auctionRoomId: currentRoom.id } });
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
