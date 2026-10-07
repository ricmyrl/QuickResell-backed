import { Router, type Request } from "express";
import type { AuctionWatchlistItem, User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { processAuctionAutoBid } from "../services/autoBidding.js";
import { maxAllowedBid, minimumBidAmount } from "../services/bidLogic.js";
import { sendScoutWatchlistEmail } from "../services/mail.js";

const router = Router();

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

async function includeAuction(item: AuctionWatchlistItem) {
  const auctionRoom = await prisma.auctionRoom.findUnique({
    where: { id: item.auctionRoomId },
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
        take: 1,
        include: { bidder: { select: { id: true, displayName: true, avatarUrl: true } } },
      },
    },
  });
  return { ...item, auctionRoom };
}

router.use("/watchlist/auctions", requireSupabaseUser, requireConfirmedEmail);

router.get("/watchlist/auctions", async (request, response) => {
  const user = currentUser(request);
  const items = await prisma.auctionWatchlistItem.findMany({
    where: { userId: user.id },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  response.json({ items: await Promise.all(items.map(includeAuction)) });
});

router.put("/watchlist/auctions/:auctionRoomId", async (request, response) => {
  const user = currentUser(request);
  const { maxBid, bidStep, autoBidEnabled, authorizationConfirmed } = request.body ?? {};
  if (typeof maxBid !== "number" || !Number.isFinite(maxBid) || maxBid <= 0 || maxBid > maxAllowedBid) {
    response.status(400).json({ error: `maxBid must be a number greater than zero and at most ${maxAllowedBid}.` });
    return;
  }
  if (typeof bidStep !== "number" || !Number.isFinite(bidStep) || bidStep <= 0 || bidStep > maxBid) {
    response.status(400).json({ error: "bidStep must be greater than zero and no greater than maxBid." });
    return;
  }
  if (typeof autoBidEnabled !== "boolean") {
    response.status(400).json({ error: "autoBidEnabled must be explicitly true or false." });
    return;
  }
  if (typeof authorizationConfirmed !== "boolean") {
    response.status(400).json({ error: "authorizationConfirmed must be explicitly true or false." });
    return;
  }
  if (autoBidEnabled && !authorizationConfirmed) {
    response.status(403).json({ error: "Confirm authorization before enabling Scout bidding." });
    return;
  }
  if (autoBidEnabled) {
    const account = await prisma.user.findUnique({
      where: { id: user.id },
      select: { biddingSuspendedUntil: true },
    });
    if (account?.biddingSuspendedUntil && account.biddingSuspendedUntil > new Date()) {
      response.status(403).json({
        error: "Your bidding privileges are suspended until the active restriction ends.",
        biddingSuspendedUntil: account.biddingSuspendedUntil,
      });
      return;
    }
  }

  const auctionRoom = await prisma.auctionRoom.findUnique({
    where: { id: request.params.auctionRoomId },
    select: { id: true, sellerId: true, status: true, endsAt: true, currentHighestBid: true, post: { select: { price: true } } },
  });
  if (!auctionRoom) {
    response.status(404).json({ error: "Auction room not found." });
    return;
  }
  if (auctionRoom.sellerId === user.id) {
    response.status(403).json({ error: "You cannot add your own auction to your bid watchlist." });
    return;
  }
  if (auctionRoom.status !== "ACTIVE" || auctionRoom.endsAt <= new Date()) {
    response.status(409).json({ error: "Only live auctions can have an active bid rule." });
    return;
  }
  const minimumBid = minimumBidAmount(auctionRoom.currentHighestBid, auctionRoom.post.price);
  if (autoBidEnabled && maxBid < minimumBid) {
    response.status(409).json({ error: `Your maximum must be at least ${minimumBid} to enable Scout bidding.` });
    return;
  }

  const item = await prisma.auctionWatchlistItem.upsert({
    where: { userId_auctionRoomId: { userId: user.id, auctionRoomId: auctionRoom.id } },
    update: { maxBid, bidStep, autoBidEnabled },
    create: { userId: user.id, auctionRoomId: auctionRoom.id, maxBid, bidStep, autoBidEnabled },
  });

  const emailNotified = user.email && autoBidEnabled
    ? await sendScoutWatchlistEmail({
      recipientEmail: user.email,
      itemTitle: auctionRoom.id ? (await prisma.auctionRoom.findUnique({
        where: { id: auctionRoom.id },
        select: { post: { select: { title: true } } },
      }))?.post.title ?? "your watched item" : "your watched item",
      maxBid,
      bidStep,
      note: `Scout is now watching this auction and will bid on your behalf up to ${maxBid}. Review the rule in the Watchlist anytime.`,
    })
    : false;

  const result = autoBidEnabled ? await processAuctionAutoBid(auctionRoom.id) : null;
  const currentItem = await prisma.auctionWatchlistItem.findUniqueOrThrow({ where: { id: item.id } });
  response.status(200).json({ item: await includeAuction(currentItem), autoBidPlaced: Boolean(result?.bid), emailNotified });
});

router.delete("/watchlist/auctions/:auctionRoomId", async (request, response) => {
  const user = currentUser(request);
  const removed = await prisma.auctionWatchlistItem.deleteMany({
    where: { userId: user.id, auctionRoomId: request.params.auctionRoomId },
  });
  response.json({ removed: removed.count });
});

export default router;