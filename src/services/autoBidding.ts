import type { AuctionRoom, Bid, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { sendScoutWatchlistEmail } from "./mail.js";

const antiSnipeWindowMs = 10_000;
const antiSnipeExtensionMs = 30_000;

export type AutoBidResult = {
  auctionRoom: AuctionRoom | null;
  bid: Bid | null;
};

export function calculateProxyBid(
  currentHighestBid: number,
  maxBid: number,
  bidStep: number,
  competingMaxBid = currentHighestBid,
): number | null {
  if (![currentHighestBid, maxBid, bidStep, competingMaxBid].every(Number.isFinite) ||
      currentHighestBid < 0 || bidStep <= 0 || maxBid <= currentHighestBid || competingMaxBid > maxBid) {
    return null;
  }

  const nextAmount = Math.max(currentHighestBid + bidStep, competingMaxBid + bidStep);
  const cappedAmount = Math.min(maxBid, nextAmount);
  return cappedAmount > currentHighestBid ? cappedAmount : null;
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

export async function processAuctionAutoBid(auctionRoomId: string): Promise<AutoBidResult> {
  return prisma.$transaction(async (transaction) => {
    const room = await lockAuctionRoom(transaction, auctionRoomId);
    if (!room) return { auctionRoom: null, bid: null };
    if (room.status !== "ACTIVE" || room.endsAt <= new Date()) {
      return { auctionRoom: room, bid: null };
    }

    await transaction.auctionWatchlistItem.updateMany({
      where: { auctionRoomId, autoBidEnabled: true, maxBid: { lte: room.currentHighestBid } },
      data: { autoBidEnabled: false },
    });

    const rules = await transaction.auctionWatchlistItem.findMany({
      where: {
        auctionRoomId,
        autoBidEnabled: true,
        maxBid: { gt: room.currentHighestBid },
        userId: { not: room.sellerId },
      },
      orderBy: [{ maxBid: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (rules.length === 0) return { auctionRoom: room, bid: null };

    const highestRule = rules[0];
    const competingRule = rules.find((rule) => rule.userId !== highestRule.userId);
    const nextBidder = highestRule;

    if (highestRule.userId === room.highestBidderId && !competingRule) {
      return { auctionRoom: room, bid: null };
    }

    const proposedAmount = calculateProxyBid(
      room.currentHighestBid,
      nextBidder.maxBid,
      nextBidder.bidStep,
      competingRule?.maxBid ?? room.currentHighestBid,
    );
    if (proposedAmount === null) {
      return { auctionRoom: room, bid: null };
    }

    const now = new Date();
    const endsAt = room.endsAt.getTime() - now.getTime() <= antiSnipeWindowMs
      ? new Date(room.endsAt.getTime() + antiSnipeExtensionMs)
      : room.endsAt;
    const bid = await transaction.bid.create({
      data: { auctionRoomId, bidderId: nextBidder.userId, amount: proposedAmount },
    });
    const auctionRoom = await transaction.auctionRoom.update({
      where: { id: auctionRoomId },
      data: {
        currentHighestBid: proposedAmount,
        highestBidderId: nextBidder.userId,
        endsAt,
      },
    });
    await transaction.cartItem.upsert({
      where: { userId_postId: { userId: nextBidder.userId, postId: room.postId } },
      create: { userId: nextBidder.userId, postId: room.postId, auctionRoomId },
      update: { auctionRoomId, quantity: 1 },
    });
    const auctionTitle = await transaction.post.findUnique({
      where: { id: room.postId },
      select: { title: true },
    });
    const title = auctionTitle?.title ?? "auction";

    const bidder = await transaction.user.findUnique({
      where: { id: nextBidder.userId },
      select: { email: true },
    });

    if (bidder?.email) {
      await sendScoutWatchlistEmail({
        recipientEmail: bidder.email,
        itemTitle: title,
        maxBid: nextBidder.maxBid,
        bidStep: nextBidder.bidStep,
        note: `Scout just placed a bid of $${proposedAmount.toFixed(2)} on your watched item. Your watchlist rule remains active until your maximum is reached.`,
      });
    }

    const notifications = [
      ...(room.highestBidderId && room.highestBidderId !== nextBidder.userId
        ? [{
          userId: room.highestBidderId,
          type: "OUTBID" as const,
          title: "Scout raised the bid",
          message: `A watchlist bidder raised “${title}” to $${proposedAmount.toFixed(2)}. If bidding is still active, reopen the auction and place a higher bid to get back in the lead.`,
          entityType: "auction",
          entityId: auctionRoomId,
        }]
        : []),
      {
        userId: nextBidder.userId,
        type: "BID_PLACED" as const,
        title: "Scout placed a bid for you",
        message: `Scout bid $${proposedAmount.toFixed(2)} on “${title}” using your watchlist rule. Your maximum is $${nextBidder.maxBid.toFixed(2)}.`,
        entityType: "auction",
        entityId: auctionRoomId,
      },
      ...(room.sellerId !== nextBidder.userId
        ? [{
          userId: room.sellerId,
          type: "BID_PLACED" as const,
          title: "New bid received",
          message: `“${title}” received an automatic bid at $${proposedAmount.toFixed(2)}.`,
          entityType: "auction",
          entityId: auctionRoomId,
        }]
        : []),
    ];
    await transaction.notification.createMany({ data: notifications });
    await transaction.auctionWatchlistItem.updateMany({
      where: { auctionRoomId, autoBidEnabled: true, maxBid: { lte: proposedAmount } },
      data: { autoBidEnabled: false },
    });

    return { auctionRoom, bid };
  });
}