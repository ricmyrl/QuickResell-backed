import assert from "node:assert/strict";
import test from "node:test";

import { createMarketplaceScorer } from "../servies/marketRecomendationService.js";

const buyer = {
  id: "buyer-1",
  savedCategories: [],
  preferredDormOrCampus: "North Hall",
  budgetPreference: 100,
};

test("FOR_YOU prioritizes campus fit and affordability over a semantically strong but mismatched listing", () => {
  const now = Date.now();
  const scorer = createMarketplaceScorer({
    buyer,
    buyerEmbedding: [1, 0],
    feedType: "FOR_YOU",
    now,
  });

  const campusFitItem = {
    categoryId: "books",
    price: 60,
    originalPrice: null,
    locationCampus: "North Hall",
    createdAt: new Date(now - 2 * 60 * 60 * 1000),
    user: { id: "seller-1" },
    embedding: [0, 1],
  };

  const semanticallyStrongMismatch = {
    categoryId: "home",
    price: 140,
    originalPrice: 160,
    locationCampus: "South Dorms",
    createdAt: new Date(now - 30 * 60 * 60 * 1000),
    user: { id: "seller-2" },
    embedding: [1, 0],
  };

  const campusFitScore = scorer(campusFitItem).score;
  const mismatchScore = scorer(semanticallyStrongMismatch).score;

  assert.ok(campusFitScore > mismatchScore, "same-campus, affordable listings should beat a generic semantically strong mismatch");
});
