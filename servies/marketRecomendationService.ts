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

function normalizeCampusKey(value?: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}

// 1. Budget fit: Rewards listings that fit the student's budget without forcing them to overspend.
function priceAffinityScore(listingPrice: number, buyerBudgetPreference?: number | null): number {
  if (!listingPrice || !buyerBudgetPreference || buyerBudgetPreference <= 0) return 0.55;

  const ratio = listingPrice / buyerBudgetPreference;
  if (ratio <= 0.5) return 1;
  if (ratio <= 1) return 1 - (ratio - 0.5) / 0.5;
  return Math.max(0.1, 1 - (ratio - 1) / 2);
}

// 2. Deal quality: Rewards good discounts, but not at the expense of campus fit or affordability.
function dealQualityScore(price?: number | null, originalPrice?: number | null, buyerBudgetPreference?: number | null): number {
  if (typeof price !== "number" || price <= 0) return 0;

  const budgetFit = priceAffinityScore(price, buyerBudgetPreference);

  if (typeof originalPrice !== "number" || originalPrice <= price) {
    return Math.min(1, 0.25 + budgetFit * 0.75);
  }

  const discountPercent = (originalPrice - price) / originalPrice;
  return Math.min(1, 0.2 + discountPercent * 1.2 + budgetFit * 0.5);
}

// 3. Campus match: Prioritizes same dorm, building, or campus zone over broad interest matching.
function proximityScore(listingLocation?: string | null, buyerLocation?: string | null): number {
  const listingKey = normalizeCampusKey(listingLocation);
  const buyerKey = normalizeCampusKey(buyerLocation);

  if (!listingKey || !buyerKey) return 0.25;
  if (listingKey === buyerKey) return 1;

  const listingSegments = listingKey.split(" ").filter(Boolean);
  const buyerSegments = buyerKey.split(" ").filter(Boolean);
  const overlap = listingSegments.filter((segment) => buyerSegments.includes(segment)).length;

  if (overlap > 0) return 0.8;
  if (listingKey.includes(buyerKey) || buyerKey.includes(listingKey)) return 0.7;
  return 0.15;
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

  let weights = { semantic: 0.18, category: 0.28, deal: 0.24, proximity: 0.22, recency: 0.08 };
  if (feedType === "DEALS") {
    weights = { semantic: 0.08, category: 0.12, deal: 0.48, proximity: 0.12, recency: 0.2 };
  } else if (feedType === "NEARBY") {
    weights = { semantic: 0.12, category: 0.15, deal: 0.08, proximity: 0.5, recency: 0.15 };
  } else if (feedType === "EXPLORE") {
    weights = { semantic: 0.2, category: 0.18, deal: 0.16, proximity: 0.12, recency: 0.2 };
  }

  return (listing: MarketplaceScoreOptions["listing"]): MarketplaceScoreResult => {
    const semanticSim = buyerVectorNorm > 0 ? cosineWithNorm(asVector(listing.embedding), buyerVector, buyerVectorNorm) : 0.2;
    const savedCategories = buyer.savedCategories ?? [];
    const categoryMatch = savedCategories.length === 0 ? 0.2 : savedCategories.includes(listing.categoryId) ? 1.0 : 0.1;
    const dealValue = dealQualityScore(listing.price, listing.originalPrice, buyer.budgetPreference);
    const proximity = proximityScore(listing.locationCampus, buyer.preferredDormOrCampus);
    const ageHours = (now - listing.createdAt.getTime()) / 36e5;
    const recency = Math.max(0, 1 - ageHours / 72);

    const score = Math.min(1, Math.max(0,
      weights.semantic * semanticSim +
      weights.category * categoryMatch +
      weights.deal * dealValue +
      weights.proximity * proximity +
      weights.recency * recency
    ));

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