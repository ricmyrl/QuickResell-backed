import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { computeMarketplaceScore, type MarketplaceFeedType } from "../../servies/marketRecomendationService.js";

const router = Router();
const feedTypes: MarketplaceFeedType[] = ["FOR_YOU", "DEALS", "NEARBY", "EXPLORE"];
const maxFeedCandidates = 500;
const maxListingImages = 8;

router.use(requireSupabaseUser);

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

  const ranked = await Promise.all(candidates.map(async (listing) => {
    const result = await computeMarketplaceScore({
      listing,
      buyer,
      buyerEmbedding: buyer.embedding,
      feedType: feedType as MarketplaceFeedType,
    });
    return { ...listing, score: result.score, scoreBreakdown: result.breakdown };
  }));

  ranked.sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime());
  response.json({ feedType, candidateCount: candidates.length, items: ranked.slice(0, requestedLimit) });
});

router.post("/listings", async (request, response) => {
  const seller = currentUser(request);
  const { title, description, categoryId, price, originalPrice, locationCampus, imageUrls } = request.body ?? {};

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
      originalPrice: originalPrice ?? null,
      locationCampus: typeof locationCampus === "string" ? locationCampus.trim() || null : null,
      images: {
        create: imageUrls.map((url: string, sortOrder: number) => ({ url, sortOrder })),
      },
    },
    include: {
      category: true,
      images: { orderBy: { sortOrder: "asc" } },
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });

  response.status(201).json({ listing });
});

export default router;