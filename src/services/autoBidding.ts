import type { AuctionRoom, Bid, Prisma } from "../generated/prisma/client.js";
import { createNotificationsForUsers } from "../lib/notifications.js";
import { prisma } from "../lib/prisma.js";
import { sendScoutWatchlistEmail } from "./mail.js";
import { selectProxyBid } from "./bidLogic.js";

const antiSnipeWindowMs = 10_000;
const antiSnipeExtensionMs = 30_000;

export type AutoBidResult = {
  auctionRoom: AuctionRoom | null;
  bid: Bid | null;
};

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
  const result = await prisma.$transaction(async (transaction) => {
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
    });
    const decision = selectProxyBid(
      room.currentHighestBid,
      room.highestBidderId,
      room.sellerId,
      rules,
    );
    if (!decision) return { auctionRoom: room, bid: null };
    const nextBidder = rules.find((rule) => rule.userId === decision.bidderId);
    if (!nextBidder) return { auctionRoom: room, bid: null };
    const proposedAmount = decision.amount;

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
    await transaction.auctionWatchlistItem.updateMany({
      where: { auctionRoomId, autoBidEnabled: true, maxBid: { lte: proposedAmount } },
      data: { autoBidEnabled: false },
    });

    return {
      auctionRoom,
      bid,
      sideEffects: {
        bidderEmail: bidder?.email ?? null,
        itemTitle: title,
        maxBid: nextBidder.maxBid,
        bidStep: nextBidder.bidStep,
        proposedAmount,
        notifications,
      },
    };
  });

  if (result.sideEffects) {
    const { bidderEmail, itemTitle, maxBid, bidStep, proposedAmount, notifications } = result.sideEffects;
    const sideEffects: Promise<unknown>[] = [createNotificationsForUsers(notifications)];
    if (bidderEmail) {
      sideEffects.push(sendScoutWatchlistEmail({
        recipientEmail: bidderEmail,
        itemTitle,
        maxBid,
        bidStep,
        note: `Scout just placed a bid of $${proposedAmount.toFixed(2)} on your watched item. Your watchlist rule remains active until your maximum is reached.`,
      }));
    }
    const settled = await Promise.allSettled(sideEffects);
    settled.forEach((effect) => {
      if (effect.status === "rejected") {
        console.error("Automatic bid was recorded, but a notification could not be delivered.", {
          auctionRoomId,
          error: effect.reason,
        });
      }
    });
  }

  return { auctionRoom: result.auctionRoom, bid: result.bid };
}