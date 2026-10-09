import { Router, type Request } from "express";
import { createHash } from "node:crypto";
import type { User } from "../generated/prisma/client.js";
import { ListingReactionType, Prisma } from "../generated/prisma/client.js";
import { optionalSupabaseUser, requireConfirmedEmail, requirePasskeyVerification, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { createNotificationsForUsers } from "../lib/notifications.js";
import { createMarketplaceScorer, type MarketplaceFeedType } from "../../servies/marketRecomendationService.js";
import { emptyListingReactionCounts, getListingReactionCounts } from "../services/listingReactions.js";
import { maxAllowedBid } from "../services/bidLogic.js";
import { incrementCurveTypes, type IncrementCurveType } from "../services/bidDynamicIncrements.js";
import { canPublishListings } from "../services/sellerVerification.js";

const router = Router();
const feedTypes: MarketplaceFeedType[] = ["FOR_YOU", "DEALS", "NEARBY", "EXPLORE"];
const maxFeedCandidates = 500;
const maxListingImages = 8;
const maxAuctionDurationHours = 30 * 24;
const maxFeedSeenIds = 100;
const listingCategories = [
  { id: "category_books", name: "Books" },
  { id: "category_clothing", name: "Clothing" },
  { id: "category_electronics", name: "Electronics" },
  { id: "category_furniture", name: "Furniture" },
  { id: "category_dorm_essentials", name: "Dorm Essentials" },
  { id: "category_sports_outdoors", name: "Sports & Outdoors" },
  { id: "category_other", name: "Other" },
];

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

type ProductFeedCursor = {
  version: 1;
  rank: 0 | 1;
  createdAt: string;
  id: string;
  seenHash: string;
};

function parseSeenIds(value: unknown): string[] | null {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const ids = values.flatMap((entry) =>
    typeof entry === "string" ? entry.split(",").filter(Boolean) : [entry],
  );
  if (
    ids.length > maxFeedSeenIds ||
    ids.some((id) => typeof id !== "string" || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id))
  ) return null;
  return [...new Set(ids as string[])];
}

function seenIdsHash(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join("\0")).digest("hex");
}

function parseProductFeedCursor(value: unknown): ProductFeedCursor | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      !("version" in parsed) || parsed.version !== 1 ||
      !("rank" in parsed) || (parsed.rank !== 0 && parsed.rank !== 1) ||
      !("createdAt" in parsed) || typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      !("id" in parsed) || typeof parsed.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id) ||
      !("seenHash" in parsed) || typeof parsed.seenHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.seenHash)
    ) return null;
    return parsed as ProductFeedCursor;
  } catch {
    return null;
  }
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
  await prisma.category.createMany({
    data: listingCategories,
    skipDuplicates: true,
  });
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  response.json({ categories });
});

router.get(["/store", "/feed/products"], optionalSupabaseUser, async (request, response) => {
  const viewerId = (request as AuthenticatedRequest).marketplaceUser?.id;
  const requestedLimit = Number(request.query.limit ?? 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    response.status(400).json({ error: "limit must be an integer between 1 and 50." });
    return;
  }
  const seenIds = parseSeenIds(request.query.seenIds);
  if (!seenIds) {
    response.status(400).json({ error: `seenIds must contain at most ${maxFeedSeenIds} valid item IDs.` });
    return;
  }
  const seenHash = seenIdsHash(seenIds);
  const cursorValue = request.query.cursor;
  const cursor = cursorValue === undefined ? null : parseProductFeedCursor(cursorValue);
  if (cursorValue !== undefined && !cursor) {
    response.status(400).json({ error: "cursor is invalid." });
    return;
  }
  if (cursor && cursor.seenHash !== seenHash) {
    response.status(409).json({
      error: "The seen-item set changed during pagination. Refresh the feed to continue.",
      code: "FEED_CURSOR_STALE",
    });
    return;
  }
  const requestedPage = Number(request.query.page ?? 1);
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 10_000 ||
      (cursor && request.query.page !== undefined)) {
    response.status(400).json({ error: "page must be an integer between 1 and 10000 and cannot be combined with cursor." });
    return;
  }
  const seenIdFilter = seenIds.length
    ? Prisma.sql`p."id" IN (${Prisma.join(seenIds)})`
    : Prisma.sql`FALSE`;
  const rankExpression = Prisma.sql`CASE WHEN ${seenIdFilter} THEN 1 ELSE 0 END`;
  const cursorCondition = cursor
    ? Prisma.sql`AND (
        ${rankExpression} > ${cursor.rank}
        OR (
          ${rankExpression} = ${cursor.rank}
          AND (
            p."createdAt" < ${new Date(cursor.createdAt)}
            OR (p."createdAt" = ${new Date(cursor.createdAt)} AND p."id" > ${cursor.id})
          )
        )
      )`
    : Prisma.empty;
  const offset = cursor ? 0 : (requestedPage - 1) * requestedLimit;
  const { rankedRows, listings } = await prisma.$transaction(async (transaction) => {
    const rankedRows = await transaction.$queryRaw<Array<{ id: string; rank: number; createdAt: Date }>>`
      SELECT p."id", ${rankExpression} AS "rank", p."createdAt"
      FROM "Post" p
      WHERE p."status" = 'ACTIVE'
        AND p."quantityAvailable" > 0
        AND NOT EXISTS (
          SELECT 1 FROM "AuctionRoom" ar WHERE ar."postId" = p."id"
        )
        ${cursorCondition}
      ORDER BY "rank" ASC, p."createdAt" DESC, p."id" ASC
      LIMIT ${requestedLimit + 1}
      OFFSET ${offset}
    `;
    const selectedRows = rankedRows.slice(0, requestedLimit);
    const ids = selectedRows.map(({ id }) => id);
    const posts = ids.length ? await transaction.post.findMany({
      where: { id: { in: ids } },
      include: {
        category: true,
        images: { orderBy: { sortOrder: "asc" } },
        user: { select: { id: true, displayName: true, avatarUrl: true, trustScore: true, completedAuctions: true, isCampusVerified: true } },
        _count: { select: { comments: true, listingReactions: true } },
        listingReactions: viewerId
          ? { where: { userId: viewerId }, select: { type: true } }
          : { take: 0, select: { type: true } },
      },
    }) : [];
    const postsById = new Map(posts.map((post) => [post.id, post]));
    return {
      rankedRows,
      listings: ids.flatMap((id) => {
        const post = postsById.get(id);
        return post ? [post] : [];
      }),
    };
  }, { isolationLevel: "RepeatableRead" });
  const hasMore = rankedRows.length > requestedLimit;
  const reactionCounts = await getListingReactionCounts(listings.map(({ id }) => id));
  response.json({
    items: listings.map((item) => ({
      ...item,
      reactionCounts: reactionCounts.get(item.id) ?? emptyListingReactionCounts(),
    })),
    nextCursor: hasMore && rankedRows[requestedLimit - 1]
      ? Buffer.from(JSON.stringify({
        version: 1,
        rank: rankedRows[requestedLimit - 1].rank === 1 ? 1 : 0,
        createdAt: rankedRows[requestedLimit - 1].createdAt.toISOString(),
        id: rankedRows[requestedLimit - 1].id,
        seenHash,
      } satisfies ProductFeedCursor)).toString("base64url")
      : null,
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

router.post("/listings", requirePasskeyVerification, async (request, response) => {
  const seller = currentUser(request);
  const verification = await prisma.sellerVerification.findUnique({
    where: { userId: seller.id },
    select: { identityStatus: true, payoutStatus: true },
  });
  if (!canPublishListings(verification)) {
    response.status(403).json({
      error: "Complete identity and payout-account verification before publishing as a seller.",
      code: "SELLER_VERIFICATION_REQUIRED",
    });
    return;
  }
  const {
    title,
    description,
    categoryId,
    price,
    originalPrice,
    conditionScore = 1,
    locationCampus,
    latitude,
    longitude,
    imageUrls,
    quantityAvailable = 1,
    auctionDurationHours,
    incrementCurve = "LINEAR_TIERED",
  } = request.body ?? {};

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
  if (typeof conditionScore !== "number" || !Number.isFinite(conditionScore) || conditionScore <= 0.1 || conditionScore > 1) {
    response.status(400).json({ error: "conditionScore must be greater than 0.1 and at most 1." });
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
  if (auctionDurationHours !== undefined &&
      (typeof incrementCurve !== "string" || !incrementCurveTypes.includes(incrementCurve as IncrementCurveType))) {
    response.status(400).json({ error: "incrementCurve must be one of the supported auction increment curves." });
    return;
  }
  if (auctionDurationHours !== undefined && price >= maxAllowedBid) {
    response.status(400).json({ error: `Auction starting price must be below the maximum bid of ${maxAllowedBid}.` });
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
        conditionScore,
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
        platformFeeEnabled: true,
        endsAt: new Date(Date.now() + auctionDurationHours * 60 * 60 * 1000),
        isPublic: true,
        incrementCurve: incrementCurve as IncrementCurveType,
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
  const nextConditionScore = request.body?.conditionScore;
  const nextLatitude = request.body?.latitude;
  const nextLongitude = request.body?.longitude;
  const isUpdatingCoordinates = nextLatitude !== undefined || nextLongitude !== undefined;
  if (nextPrice !== undefined && (typeof nextPrice !== "number" || !Number.isFinite(nextPrice) || nextPrice < 0)) {
    response.status(400).json({ error: "price must be a non-negative number." });
    return;
  }
  if (nextConditionScore !== undefined &&
      (typeof nextConditionScore !== "number" || !Number.isFinite(nextConditionScore) || nextConditionScore <= 0.1 || nextConditionScore > 1)) {
    response.status(400).json({ error: "conditionScore must be greater than 0.1 and at most 1." });
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
      ...(nextConditionScore !== undefined ? { conditionScore: nextConditionScore } : {}),
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