import assert from "node:assert/strict";
import test from "node:test";
import { calculateProxyBid, isValidManualBidAmount, maxAllowedBid, minimumBidAmount, selectProxyBid, type AutoBidRuleCandidate } from "../src/services/bidLogic.js";

const ngn = (usd: number) => Math.round(usd * 1_331.267014 * 100) / 100;

function rule(overrides: Partial<AutoBidRuleCandidate> = {}): AutoBidRuleCandidate {
  return {
    id: "rule-1",
    userId: "bidder-1",
    maxBid: ngn(200),
    bidStep: ngn(5),
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
  assert.equal(minimumBidAmount(0, ngn(100)), ngn(101));
  assert.equal(minimumBidAmount(ngn(120), ngn(100)), ngn(121));
  assert.equal(minimumBidAmount(ngn(80), ngn(100)), ngn(101));
});

test("proxy bids exceed a competing cap by one step without exceeding their own cap", () => {
  const proxyBid = calculateProxyBid(ngn(100), ngn(200), ngn(5), ngn(175));
  assert.ok(proxyBid !== null && Math.abs(proxyBid - ngn(180)) <= 0.02);
  assert.equal(calculateProxyBid(ngn(100), ngn(175), ngn(10), ngn(175)), ngn(175));
  assert.equal(calculateProxyBid(ngn(100), ngn(120), ngn(0.5), ngn(100)), ngn(101));
  assert.equal(calculateProxyBid(ngn(100), ngn(150), ngn(5), ngn(175)), null);
});

test("proxy rules below the minimum legal raise are ineligible", () => {
  assert.equal(selectProxyBid(ngn(100), null, "seller", [rule({ maxBid: ngn(100.5), bidStep: ngn(0.5) })]), null);
});

test("proxy bids start above the listing price when evaluated from the opening floor", () => {
  assert.deepEqual(
    selectProxyBid(ngn(100), null, "seller", [rule({ maxBid: ngn(120), bidStep: ngn(5) })]),
    { bidderId: "bidder-1", amount: ngn(105) },
  );
});

test("the strongest eligible rule responds to a manual bid", () => {
  const decision = selectProxyBid(ngn(100), "manual-bidder", "seller", [
    rule({ userId: "proxy-a", maxBid: ngn(200), bidStep: ngn(5) }),
    rule({ id: "rule-2", userId: "proxy-b", maxBid: ngn(175), bidStep: ngn(10) }),
  ]);
  assert.equal(decision?.bidderId, "proxy-a");
  assert.ok(decision !== null && Math.abs(decision.amount - ngn(180)) <= 0.02);
});

test("the current leader wins an equal proxy-cap tie deterministically", () => {
  const decision = selectProxyBid(ngn(100), "incumbent", "seller", [
    rule({ id: "older-rule", userId: "challenger", maxBid: ngn(200), createdAt: new Date("2025-01-01T00:00:00Z") }),
    rule({ id: "incumbent-rule", userId: "incumbent", maxBid: ngn(200), createdAt: new Date("2026-01-01T00:00:00Z") }),
  ]);
  assert.deepEqual(decision, { bidderId: "incumbent", amount: ngn(200) });
});

test("a leader with no competing rule is never made to bid against itself", () => {
  assert.equal(selectProxyBid(ngn(100), "bidder-1", "seller", [rule()]), null);
});

test("seller rules and disabled rules are ignored", () => {
  assert.equal(selectProxyBid(ngn(100), "other", "seller", [
    rule({ userId: "seller", maxBid: ngn(500) }),
    rule({ id: "disabled", userId: "disabled", autoBidEnabled: false }),
  ]), null);
});