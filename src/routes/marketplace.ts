import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { ListingReactionType } from "../generated/prisma/client.js";
import { optionalSupabaseUser, requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { createNotificationsForUsers } from "../lib/notifications.js";
import { createMarketplaceScorer, type MarketplaceFeedType } from "../../servies/marketRecomendationService.js";
import { emptyListingReactionCounts, getListingReactionCounts } from "../services/listingReactions.js";

const router = Router();
const feedTypes: MarketplaceFeedType[] = ["FOR_YOU", "DEALS", "NEARBY", "EXPLORE"];
const maxFeedCandidates = 500;
const maxListingImages = 8;
const maxAuctionDurationHours = 30 * 24;

function publicDiscussionPostWhere() {
  return {
    status: "ACTIVE" as const,
    quantityAvailable: { gt: 0 },
    OR: [
      { auctionRoom: { is: null } },
      { auctionRoom: { is: { status: "ACTIVE" as const, isPublic: true, endsAt: { gt: new Date() } } } },
    ],
  };
}

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function isOwnedStorageUrl(value: unknown, ownerId: string): value is string {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (typeof value !== "string" || !supabaseUrl) return false;

  try {
    const url = new URL(value);
    const projectOrigin = new URL(supabaseUrl).origin;
    const bucket = process.env.SUPABASE_LISTING_BUCKET ?? "listing-images";
    const ownedPath = `/storage/v1/object/public/${bucket}/${ownerId}/`;
    return url.origin === projectOrigin && url.pathname.startsWith(ownedPath);
  } catch {
    return false;
  }
}

router.get("/categories", async (_request, response) => {
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  response.json({ categories });
});

router.get("/store", optionalSupabaseUser, async (request, response) => {
  const viewerId = (request as AuthenticatedRequest).marketplaceUser?.id;
  const items = await prisma.post.findMany({
    where: {
      status: "ACTIVE",
      quantityAvailable: { gt: 0 },
      auctionRoom: { is: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 50,
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true, isCampusVerified: true } },
      _count: { select: { comments: true, listingReactions: true } },
      listingReactions: viewerId
        ? { where: { userId: viewerId }, select: { type: true } }
        : { take: 0, select: { type: true } },
    },
  });
  const reactionCounts = await getListingReactionCounts(items.map(({ id }) => id));
  response.json({
    items: items.map((item) => ({
      ...item,
      reactionCounts: reactionCounts.get(item.id) ?? emptyListingReactionCounts(),
    })),
  });
});

router.post("/listings/:listingId/reaction", requireSupabaseUser, requireConfirmedEmail, async (request, response) => {
  const user = currentUser(request);
  const listingId = request.params.listingId;
  const type = request.body?.type;
  if (typeof listingId !== "string" || typeof type !== "string" ||
      !Object.values(ListingReactionType).includes(type as ListingReactionType)) {
    response.status(400).json({ error: "type must be one of LIKE, LOVE, HAHA, WOW, SAD, or ANGRY." });
    return;
  }
  const post = await prisma.post.findFirst({
    where: { id: listingId, ...publicDiscussionPostWhere() },
    select: { id: true },
  });
  if (!post) {
    response.status(404).json({ error: "Product not found." });
    return;
  }

  const reaction = await prisma.listingReaction.upsert({
    where: { postId_userId: { postId: post.id, userId: user.id } },
    create: { postId: post.id, userId: user.id, type: type as ListingReactionType },
    update: { type: type as ListingReactionType },
  });
  const reactionCounts = (await getListingReactionCounts([post.id])).get(post.id) ?? emptyListingReactionCounts();
  const reactionCount = Object.values(reactionCounts).reduce((total, count) => total + count, 0);
  response.json({ reaction: reaction.type, reactionCount, reactionCounts });
});

router.delete("/listings/:listingId/reaction", requireSupabaseUser, requireConfirmedEmail, async (request, response) => {
  const user = currentUser(request);
  const listingId = request.params.listingId;
  if (typeof listingId !== "string") {
    response.status(400).json({ error: "A valid product ID is required." });
    return;
  }
  const post = await prisma.post.findFirst({
    where: { id: listingId, ...publicDiscussionPostWhere() },
    select: { id: true },
  });
  if (!post) {
    response.status(404).json({ error: "Product not found." });
    return;
  }

  await prisma.listingReaction.deleteMany({ where: { postId: post.id, userId: user.id } });
  const reactionCounts = (await getListingReactionCounts([post.id])).get(post.id) ?? emptyListingReactionCounts();
  const reactionCount = Object.values(reactionCounts).reduce((total, count) => total + count, 0);
  response.json({ reaction: null, reactionCount, reactionCounts });
});

router.get("/listings/:listingId/comments", optionalSupabaseUser, async (request, response) => {
  const listingId = request.params.listingId;
  if (typeof listingId !== "string") {
    response.status(400).json({ error: "A valid product ID is required." });
    return;
  }
  const viewerId = (request as AuthenticatedRequest).marketplaceUser?.id;
  const listing = await prisma.post.findFirst({
    where: {
      id: listingId,
      ...publicDiscussionPostWhere(),
    },
    include: {
      _count: { select: { comments: true } },
      comments: {
        where: { parentId: null },
        orderBy: { createdAt: "asc" },
        take: 100,
        include: {
          user: { select: { id: true, displayName: true, avatarUrl: true } },
          _count: { select: { reactions: true } },
          reactions: viewerId ? { where: { userId: viewerId }, select: { id: true } } : { take: 0, select: { id: true } },
          replies: {
            orderBy: { createdAt: "asc" },
            include: {
              user: { select: { id: true, displayName: true, avatarUrl: true } },
              _count: { select: { reactions: true } },
              reactions: viewerId ? { where: { userId: viewerId }, select: { id: true } } : { take: 0, select: { id: true } },
            },
          },
        },
      },
    },
  });

  if (!listing) {
    response.status(404).json({ error: "Product not found." });
    return;
  }

  const formatComment = (comment: typeof listing.comments[number]) => ({
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt,
    user: comment.user,
    likeCount: comment._count.reactions,
    likedByMe: comment.reactions.length > 0,
    replies: comment.replies.map((reply) => ({
        id: reply.id,
        content: reply.content,
        createdAt: reply.createdAt,
        user: reply.user,
        likeCount: reply._count.reactions,
        likedByMe: reply.reactions.length > 0,
        replies: [],
      })),
  });
  response.json({ items: listing.comments.map(formatComment), commentsCount: listing._count.comments });
});

router.use("/feed", requireSupabaseUser);
router.get("/feed", async (request, response) => {
  const requestedType = request.query.type;
  const feedType = typeof requestedType === "string" ? requestedType : "FOR_YOU";
  if (!feedTypes.includes(feedType as MarketplaceFeedType)) {
    response.status(400).json({ error: "type must be FOR_YOU, DEALS, NEARBY, or EXPLORE." });
    return;
  }

  const requestedLimit = Number(request.query.limit ?? 20);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    response.status(400).json({ error: "limit must be an integer between 1 and 50." });
    return;
  }

  const buyer = currentUser(request);
  const posts = await prisma.post.findMany({
    where: {
      status: "ACTIVE",
      sellerId: { not: buyer.id },
      ...(feedType === "DEALS" ? { originalPrice: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: maxFeedCandidates,
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });

  const candidates = feedType === "DEALS"
    ? posts.filter((post) => post.originalPrice !== null && post.originalPrice > post.price)
    : posts;

  const scoreListing = createMarketplaceScorer({
    buyer,
    buyerEmbedding: buyer.embedding,
    feedType: feedType as MarketplaceFeedType,
  });
  const ranked = candidates.map((listing) => {
    const result = scoreListing(listing);
    return { ...listing, score: result.score, scoreBreakdown: result.breakdown };
  });

  ranked.sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime());
  response.json({ feedType, candidateCount: candidates.length, items: ranked.slice(0, requestedLimit) });
});

router.use("/listings", requireSupabaseUser, requireConfirmedEmail);
router.post("/listings/:listingId/comments", async (request, response) => {
  const user = currentUser(request);
  const listingId = request.params.listingId;
  if (typeof listingId !== "string") {
    response.status(400).json({ error: "A valid product ID is required." });
    return;
  }
  const content = request.body?.content;
  const parentId = request.body?.parentId;
  if (typeof content !== "string" || !content.trim() || content.trim().length > 1000) {
    response.status(400).json({ error: "Comment is required and must be at most 1000 characters." });
    return;
  }

  const listing = await prisma.post.findFirst({
    where: {
      id: listingId,
      ...publicDiscussionPostWhere(),
    },
    select: { id: true },
  });
  if (!listing) {
    response.status(404).json({ error: "Product not found." });
    return;
  }

  if (parentId !== undefined && (typeof parentId !== "string" || !await prisma.productComment.findFirst({
    where: { id: parentId, postId: listing.id, parentId: null },
    select: { id: true },
  }))) {
    response.status(400).json({ error: "Replies must reference a top-level comment on this product." });
    return;
  }

  const comment = await prisma.productComment.create({
    data: { postId: listing.id, userId: user.id, content: content.trim(), ...(parentId ? { parentId } : {}) },
    include: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  const commentsCount = await prisma.productComment.count({ where: { postId: listing.id } });
  response.status(201).json({
    comment: { ...comment, likeCount: 0, likedByMe: false, replies: [] },
    commentsCount,
  });
});

router.post("/listings/:listingId/comments/:commentId/reaction", async (request, response) => {
  const user = currentUser(request);
  const { listingId, commentId } = request.params;
  if (typeof listingId !== "string" || typeof commentId !== "string") {
    response.status(400).json({ error: "Valid product and comment IDs are required." });
    return;
  }
  const comment = await prisma.productComment.findFirst({
    where: {
      id: commentId,
      postId: listingId,
      post: publicDiscussionPostWhere(),
    },
    select: { id: true },
  });
  if (!comment) {
    response.status(404).json({ error: "Comment not found." });
    return;
  }

  await prisma.productCommentReaction.upsert({
    where: { commentId_userId: { commentId: comment.id, userId: user.id } },
    create: { commentId: comment.id, userId: user.id, type: "LIKE" },
    update: { type: "LIKE" },
  });
  const likeCount = await prisma.productCommentReaction.count({ where: { commentId: comment.id } });
  response.json({ liked: true, likeCount });
});

router.delete("/listings/:listingId/comments/:commentId/reaction", async (request, response) => {
  const user = currentUser(request);
  const { listingId, commentId } = request.params;
  if (typeof listingId !== "string" || typeof commentId !== "string") {
    response.status(400).json({ error: "Valid product and comment IDs are required." });
    return;
  }
  const comment = await prisma.productComment.findFirst({
    where: { id: commentId, postId: listingId },
    select: { id: true },
  });
  if (!comment) {
    response.status(404).json({ error: "Comment not found." });
    return;
  }

  await prisma.productCommentReaction.deleteMany({
    where: { commentId: comment.id, userId: user.id },
  });
  const likeCount = await prisma.productCommentReaction.count({ where: { commentId: comment.id } });
  response.json({ liked: false, likeCount });
});

router.get("/listings/mine", async (request, response) => {
  const seller = currentUser(request);
  const items = await prisma.post.findMany({
    where: { sellerId: seller.id },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 100,
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, isCampusVerified: true } },
    },
  });
  response.json({ items });
});

router.use("/watchlist", requireSupabaseUser);
router.get("/watchlist", async (request, response) => {
  const user = currentUser(request);
  const rows = await prisma.watchlistItem.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      post: { select: { id: true } },
    },
  });

  response.json({ items: rows.map((row) => row.postId) });
});

router.post("/watchlist/:listingId", async (request, response) => {
  const user = currentUser(request);
  const listing = await prisma.post.findUnique({ where: { id: request.params.listingId }, select: { id: true, title: true } });
  if (!listing) {
    response.status(404).json({ error: "Listing not found." });
    return;
  }

  const saved = await prisma.watchlistItem.upsert({
    where: { userId_postId: { userId: user.id, postId: listing.id } },
    update: {},
    create: { userId: user.id, postId: listing.id },
  });

  response.status(201).json({ item: saved });
});

router.delete("/watchlist/:listingId", async (request, response) => {
  const user = currentUser(request);
  const removed = await prisma.watchlistItem.deleteMany({
    where: { userId: user.id, postId: request.params.listingId },
  });

  response.json({ removed: removed.count });
});

router.post("/listings", async (request, response) => {
  const seller = currentUser(request);
  const { title, description, categoryId, price, originalPrice, locationCampus, latitude, longitude, imageUrls, quantityAvailable = 1, auctionDurationHours } = request.body ?? {};

  if (typeof title !== "string" || !title.trim() || title.trim().length > 120) {
    response.status(400).json({ error: "title is required and must be at most 120 characters." });
    return;
  }
  if (typeof categoryId !== "string" || !categoryId.trim()) {
    response.status(400).json({ error: "categoryId is required." });
    return;
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    response.status(400).json({ error: "price must be a non-negative number." });
    return;
  }
  if (typeof quantityAvailable !== "number" || !Number.isInteger(quantityAvailable) || quantityAvailable < 1 || quantityAvailable > 1000) {
    response.status(400).json({ error: "quantityAvailable must be an integer between 1 and 1000." });
    return;
  }
  if (auctionDurationHours !== undefined &&
      (typeof auctionDurationHours !== "number" || !Number.isInteger(auctionDurationHours) || auctionDurationHours < 1 || auctionDurationHours > maxAuctionDurationHours)) {
    response.status(400).json({ error: `auctionDurationHours must be an integer between 1 and ${maxAuctionDurationHours}.` });
    return;
  }
  if (originalPrice !== undefined && originalPrice !== null &&
      (typeof originalPrice !== "number" || !Number.isFinite(originalPrice) || originalPrice < price)) {
    response.status(400).json({ error: "originalPrice must be a number greater than or equal to price." });
    return;
  }
  if (description !== undefined && description !== null &&
      (typeof description !== "string" || description.length > 4000)) {
    response.status(400).json({ error: "description must be at most 4000 characters." });
    return;
  }
  if (locationCampus !== undefined && locationCampus !== null &&
      (typeof locationCampus !== "string" || locationCampus.length > 120)) {
    response.status(400).json({ error: "locationCampus must be at most 120 characters." });
    return;
  }
  const hasNoCoordinates = (latitude === undefined || latitude === null) &&
    (longitude === undefined || longitude === null);
  const hasValidCoordinates = typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (!hasNoCoordinates && !hasValidCoordinates) {
    response.status(400).json({ error: "latitude and longitude must be valid coordinates supplied together." });
    return;
  }
  if (!Array.isArray(imageUrls) || imageUrls.length < 1 || imageUrls.length > maxListingImages ||
      !imageUrls.every((url) => isOwnedStorageUrl(url, seller.id))) {
    response.status(400).json({
      error: `imageUrls must contain 1-${maxListingImages} public listing-image URLs uploaded by this user.`,
    });
    return;
  }

  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) {
    response.status(400).json({ error: "categoryId does not match an existing category." });
    return;
  }

  const result = await prisma.$transaction(async (transaction) => {
    const listing = await transaction.post.create({
      data: {
        sellerId: seller.id,
        categoryId,
        title: title.trim(),
        description: typeof description === "string" ? description.trim() || null : null,
        price,
        quantityAvailable,
        originalPrice: originalPrice ?? null,
        locationCampus: typeof locationCampus === "string" ? locationCampus.trim() || null : null,
        latitude: hasValidCoordinates ? Number(latitude.toFixed(3)) : null,
        longitude: hasValidCoordinates ? Number(longitude.toFixed(3)) : null,
        images: {
          create: imageUrls.map((url: string, sortOrder: number) => ({ url, sortOrder })),
        },
      },
      include: {
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, isCampusVerified: true } },
      },
    });
    const auctionRoom = auctionDurationHours === undefined ? null : await transaction.auctionRoom.create({
      data: {
        postId: listing.id,
        sellerId: seller.id,
        currentHighestBid: price,
        endsAt: new Date(Date.now() + auctionDurationHours * 60 * 60 * 1000),
        isPublic: true,
      },
    });
    return { listing, auctionRoom };
  });

  response.status(201).json(result);
});

router.put("/listings/:listingId", async (request, response) => {
  const seller = currentUser(request);
  const listing = await prisma.post.findUnique({
    where: { id: request.params.listingId },
    include: {
      user: { select: { id: true, isCampusVerified: true } },
      watchlistItems: { select: { userId: true } },
    },
  });

  if (!listing) {
    response.status(404).json({ error: "Listing not found." });
    return;
  }
  if (listing.sellerId !== seller.id) {
    response.status(403).json({ error: "Only the seller can update this listing." });
    return;
  }

  const nextPrice = request.body?.price;
  const nextOriginalPrice = request.body?.originalPrice;
  const nextLatitude = request.body?.latitude;
  const nextLongitude = request.body?.longitude;
  const isUpdatingCoordinates = nextLatitude !== undefined || nextLongitude !== undefined;
  if (nextPrice !== undefined && (typeof nextPrice !== "number" || !Number.isFinite(nextPrice) || nextPrice < 0)) {
    response.status(400).json({ error: "price must be a non-negative number." });
    return;
  }
  if (nextOriginalPrice !== undefined && nextOriginalPrice !== null &&
      (typeof nextOriginalPrice !== "number" || !Number.isFinite(nextOriginalPrice) || nextOriginalPrice < (nextPrice ?? listing.price))) {
    response.status(400).json({ error: "originalPrice must be a number greater than or equal to price." });
    return;
  }
  if (isUpdatingCoordinates &&
      (typeof nextLatitude !== "number" || !Number.isFinite(nextLatitude) || nextLatitude < -90 || nextLatitude > 90 ||
       typeof nextLongitude !== "number" || !Number.isFinite(nextLongitude) || nextLongitude < -180 || nextLongitude > 180)) {
    response.status(400).json({ error: "latitude and longitude must be valid coordinates supplied together." });
    return;
  }

  const updatedListing = await prisma.post.update({
    where: { id: listing.id },
    data: {
      ...(nextPrice !== undefined ? { price: nextPrice } : {}),
      ...(nextOriginalPrice !== undefined ? { originalPrice: nextOriginalPrice ?? null } : {}),
      ...(isUpdatingCoordinates ? {
        latitude: Number(nextLatitude.toFixed(3)),
        longitude: Number(nextLongitude.toFixed(3)),
      } : {}),
    },
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, isCampusVerified: true } },
    },
  });

  const oldPrice = listing.price;
  const newPrice = updatedListing.price;
  if (nextPrice !== undefined && newPrice !== oldPrice && listing.watchlistItems.length > 0) {
    const priceChange = Number((newPrice - oldPrice).toFixed(2));
    const watchers = listing.watchlistItems.map((entry) => entry.userId);
    await createNotificationsForUsers(watchers.map((userId) => ({
      userId,
      type: "PRICE_UPDATED",
      title: "Price updated",
      message: `${updatedListing.title} changed by ${priceChange >= 0 ? "+" : ""}$${Math.abs(priceChange).toFixed(2)}.`,
      entityType: "listing",
      entityId: updatedListing.id,
    })));
  }

  response.json({ listing: updatedListing });
});

export default router;