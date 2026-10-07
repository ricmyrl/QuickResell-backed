import assert from "node:assert/strict";
import test from "node:test";
import { calculateProxyBid, isValidManualBidAmount, maxAllowedBid, minimumBidAmount, selectProxyBid, type AutoBidRuleCandidate } from "../src/services/bidLogic.js";

function rule(overrides: Partial<AutoBidRuleCandidate> = {}): AutoBidRuleCandidate {
  return {
    id: "rule-1",
    userId: "bidder-1",
    maxBid: 200,
    bidStep: 5,
    autoBidEnabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("manual bids must be finite, positive, and within the configured ceiling", () => {
  assert.equal(isValidManualBidAmount(0.01), true);
  assert.equal(isValidManualBidAmount(maxAllowedBid), true);
  assert.equal(isValidManualBidAmount(0), false);
  assert.equal(isValidManualBidAmount(-1), false);
  assert.equal(isValidManualBidAmount(maxAllowedBid + 1), false);
  assert.equal(isValidManualBidAmount(Number.NaN), false);
  assert.equal(isValidManualBidAmount(Number.POSITIVE_INFINITY), false);
});

test("minimum manual bids clear both the current bid and the listing price", () => {
  assert.equal(minimumBidAmount(0, 100), 101);
  assert.equal(minimumBidAmount(120, 100), 121);
  assert.equal(minimumBidAmount(80, 100), 101);
});

test("proxy bids exceed a competing cap by one step without exceeding their own cap", () => {
  assert.equal(calculateProxyBid(100, 200, 5, 175), 180);
  assert.equal(calculateProxyBid(100, 175, 10, 175), 175);
  assert.equal(calculateProxyBid(100, 120, 0.5, 100), 101);
  assert.equal(calculateProxyBid(100, 150, 5, 175), null);
});

test("proxy rules below the minimum legal raise are ineligible", () => {
  assert.equal(selectProxyBid(100, null, "seller", [rule({ maxBid: 100.5, bidStep: 0.5 })]), null);
});

test("proxy bids start above the listing price when evaluated from the opening floor", () => {
  assert.deepEqual(
    selectProxyBid(100, null, "seller", [rule({ maxBid: 120, bidStep: 5 })]),
    { bidderId: "bidder-1", amount: 105 },
  );
});

test("the strongest eligible rule responds to a manual bid", () => {
  const decision = selectProxyBid(100, "manual-bidder", "seller", [
    rule({ userId: "proxy-a", maxBid: 200, bidStep: 5 }),
    rule({ id: "rule-2", userId: "proxy-b", maxBid: 175, bidStep: 10 }),
  ]);
  assert.deepEqual(decision, { bidderId: "proxy-a", amount: 180 });
});

test("the current leader wins an equal proxy-cap tie deterministically", () => {
  const decision = selectProxyBid(100, "incumbent", "seller", [
    rule({ id: "older-rule", userId: "challenger", maxBid: 200, createdAt: new Date("2025-01-01T00:00:00Z") }),
    rule({ id: "incumbent-rule", userId: "incumbent", maxBid: 200, createdAt: new Date("2026-01-01T00:00:00Z") }),
  ]);
  assert.deepEqual(decision, { bidderId: "incumbent", amount: 200 });
});

test("a leader with no competing rule is never made to bid against itself", () => {
  assert.equal(selectProxyBid(100, "bidder-1", "seller", [rule()]), null);
});

test("seller rules and disabled rules are ignored", () => {
  assert.equal(selectProxyBid(100, "other", "seller", [
    rule({ userId: "seller", maxBid: 500 }),
    rule({ id: "disabled", userId: "disabled", autoBidEnabled: false }),
  ]), null);
});