// src/services/marketplaceRecommendationScore.ts
import type { Post, User } from "../src/generated/prisma/client.js";

export type MarketplaceFeedType = "FOR_YOU" | "DEALS" | "NEARBY" | "EXPLORE";

export interface MarketplaceScoreOptions {
  listing: Pick<Post, "embedding" | "categoryId" | "price" | "originalPrice" | "locationCampus" | "createdAt"> & {
    user: Pick<User, "id">;
  };
  buyer: Pick<User, "id" | "savedCategories" | "preferredDormOrCampus" | "budgetPreference">;
  buyerEmbedding?: unknown;
  feedType: MarketplaceFeedType;
}

function asVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return [];
  }

  return value;
}

/* ---------- Helper Math ---------- */
function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  const denom = normA * normB;
  return denom === 0 ? 0 : dot / denom;
}

/* ---------- Marketplace Core Scoring Functions ---------- */

// 1. Price Match Affinity: Rewards listings close to what the user typically views/buys
function priceAffinityScore(listingPrice: number, buyerBudgetPreference?: number): number {
  if (!listingPrice || !buyerBudgetPreference) return 0.5; // neutral fallback
  const diff = Math.abs(listingPrice - buyerBudgetPreference);
  // Scale score down gracefully as price diverges from user preference
  return Math.max(0, 1 - diff / Math.max(listingPrice, buyerBudgetPreference));
}

// 2. Deal Quality / Discount Score: Boosts items marked down significantly
function dealQualityScore(price?: number | null, originalPrice?: number | null): number {
  if (!price || !originalPrice || originalPrice <= price) return 0;
  const discountPercent = (originalPrice - price) / originalPrice;
  return Math.min(1, discountPercent * 1.5); // Cap at 1.0 for deep discounts
}

// 3. Proximity / Campus Match: Prioritizes same dorm, building, or campus zone
function proximityScore(listingLocation?: string | null, buyerLocation?: string | null): number {
  if (!listingLocation || !buyerLocation) return 0.3;
  return listingLocation.toLowerCase() === buyerLocation.toLowerCase() ? 1.0 : 0.2;
}

/* ---------- Main Marketplace Scoring Function ---------- */
export async function computeMarketplaceScore(opts: MarketplaceScoreOptions) {
  const { listing, buyer, buyerEmbedding, feedType } = opts;

  // Extract attributes
  const semanticSim = cosine(asVector(listing.embedding), asVector(buyerEmbedding));
  const categoryMatch = buyer.savedCategories && listing.categoryId && buyer.savedCategories.includes(listing.categoryId) ? 1.0 : 0.0;
  const dealValue = dealQualityScore(listing.price, listing.originalPrice);
  const proximity = proximityScore(listing.locationCampus, buyer.preferredDormOrCampus);
  
  // Recency (Fresh items get a boost on a marketplace)
  const ageHours = (Date.now() - new Date(listing.createdAt).getTime()) / 36e5;
  const recency = Math.max(0, 1 - ageHours / 72); // 72-hour fresh decay window

  // Dynamic weights based on marketplace tab
  let weights = { semantic: 0.3, category: 0.25, deal: 0.2, proximity: 0.15, recency: 0.1 };

  if (feedType === "DEALS") {
    weights = { semantic: 0.1, category: 0.1, deal: 0.5, proximity: 0.1, recency: 0.2 };
  } else if (feedType === "NEARBY") {
    weights = { semantic: 0.15, category: 0.15, deal: 0.1, proximity: 0.5, recency: 0.1 };
  }

  const baseScore =
    weights.semantic * semanticSim +
    weights.category * categoryMatch +
    weights.deal * dealValue +
    weights.proximity * proximity +
    weights.recency * recency;

  return {
    score: baseScore,
    breakdown: { semanticSim, categoryMatch, dealValue, proximity, recency },
    feedType,
  };
}