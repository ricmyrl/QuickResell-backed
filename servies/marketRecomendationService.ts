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

export interface MarketplaceScorerOptions {
  buyer: MarketplaceScoreOptions["buyer"];
  buyerEmbedding?: unknown;
  feedType: MarketplaceFeedType;
  now?: number;
}

export interface MarketplaceScoreResult {
  score: number;
  breakdown: {
    semanticSim: number;
    categoryMatch: number;
    dealValue: number;
    proximity: number;
    recency: number;
  };
  feedType: MarketplaceFeedType;
}

function asVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return [];
  }

  return value;
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

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosineWithNorm(a: number[], b: number[], normB: number): number {
  if (!a.length || !b.length) return 0;

  let dot = 0;
  let normASquared = 0;
  for (let index = 0; index < a.length; index += 1) {
    const value = a[index]!;
    dot += value * (b[index] ?? 0);
    normASquared += value * value;
  }

  const denom = Math.sqrt(normASquared) * normB;
  return denom === 0 ? 0 : dot / denom;
}

/* ---------- Main Marketplace Scoring Functions ---------- */
export function createMarketplaceScorer(opts: MarketplaceScorerOptions) {
  const { buyer, feedType } = opts;
  const buyerVector = asVector(opts.buyerEmbedding);
  const buyerVectorNorm = vectorNorm(buyerVector);
  const now = opts.now ?? Date.now();

  let weights = { semantic: 0.3, category: 0.25, deal: 0.2, proximity: 0.15, recency: 0.1 };
  if (feedType === "DEALS") {
    weights = { semantic: 0.1, category: 0.1, deal: 0.5, proximity: 0.1, recency: 0.2 };
  } else if (feedType === "NEARBY") {
    weights = { semantic: 0.15, category: 0.15, deal: 0.1, proximity: 0.5, recency: 0.1 };
  }

  return (listing: MarketplaceScoreOptions["listing"]): MarketplaceScoreResult => {
    const semanticSim = cosineWithNorm(asVector(listing.embedding), buyerVector, buyerVectorNorm);
    const categoryMatch = buyer.savedCategories && listing.categoryId &&
      buyer.savedCategories.includes(listing.categoryId) ? 1.0 : 0.0;
    const dealValue = dealQualityScore(listing.price, listing.originalPrice);
    const proximity = proximityScore(listing.locationCampus, buyer.preferredDormOrCampus);
    const ageHours = (now - listing.createdAt.getTime()) / 36e5;
    const recency = Math.max(0, 1 - ageHours / 72);

    const score =
      weights.semantic * semanticSim +
      weights.category * categoryMatch +
      weights.deal * dealValue +
      weights.proximity * proximity +
      weights.recency * recency;

    return {
      score,
      breakdown: { semanticSim, categoryMatch, dealValue, proximity, recency },
      feedType,
    };
  };
}

export async function computeMarketplaceScore(opts: MarketplaceScoreOptions): Promise<MarketplaceScoreResult> {
  const scoreListing = createMarketplaceScorer(opts);
  return scoreListing(opts.listing);
}