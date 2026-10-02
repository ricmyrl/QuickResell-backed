import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { createNotificationsForUsers } from "../lib/notifications.js";
import { createMarketplaceScorer, type MarketplaceFeedType } from "../../servies/marketRecomendationService.js";

const router = Router();
const feedTypes: MarketplaceFeedType[] = ["FOR_YOU", "DEALS", "NEARBY", "EXPLORE"];
const maxFeedCandidates = 500;
const maxListingImages = 8;

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

router.get("/store", async (_request, response) => {
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
    },
  });
  response.json({ items });
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
  const { title, description, categoryId, price, originalPrice, locationCampus, imageUrls, quantityAvailable = 1 } = request.body ?? {};

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

  const listing = await prisma.post.create({
    data: {
      sellerId: seller.id,
      categoryId,
      title: title.trim(),
      description: typeof description === "string" ? description.trim() || null : null,
      price,
      quantityAvailable,
      originalPrice: originalPrice ?? null,
      locationCampus: typeof locationCampus === "string" ? locationCampus.trim() || null : null,
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

  response.status(201).json({ listing });
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
  if (nextPrice !== undefined && (typeof nextPrice !== "number" || !Number.isFinite(nextPrice) || nextPrice < 0)) {
    response.status(400).json({ error: "price must be a non-negative number." });
    return;
  }
  if (nextOriginalPrice !== undefined && nextOriginalPrice !== null &&
      (typeof nextOriginalPrice !== "number" || !Number.isFinite(nextOriginalPrice) || nextOriginalPrice < (nextPrice ?? listing.price))) {
    response.status(400).json({ error: "originalPrice must be a number greater than or equal to price." });
    return;
  }

  const updatedListing = await prisma.post.update({
    where: { id: listing.id },
    data: {
      ...(nextPrice !== undefined ? { price: nextPrice } : {}),
      ...(nextOriginalPrice !== undefined ? { originalPrice: nextOriginalPrice ?? null } : {}),
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