import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDynamicBidIncrement,
  standardBracketedIncrement,
} from "../src/services/bidDynamicIncrements.js";

test("linear fallback preserves standard bracketed increments", () => {
  assert.equal(standardBracketedIncrement(19.99), 1);
  assert.equal(standardBracketedIncrement(20), 5);
  assert.equal(standardBracketedIncrement(100), 10);
  assert.equal(standardBracketedIncrement(500), 25);
  assert.equal(standardBracketedIncrement(2500), 50);
  assert.deepEqual(
    calculateDynamicBidIncrement({ currentBid: 500, curve: "LINEAR_TIERED" }),
    { increment: 25, curveUsed: "LINEAR_TIERED", usedFallback: false },
  );
});

test("logarithmic curve follows the dampened formula and market rounding", () => {
  const result = calculateDynamicBidIncrement({ currentBid: 100, curve: "LOGARITHMIC" });
  assert.equal(result.increment, 6.5);
  assert.equal(result.curveUsed, "LOGARITHMIC");
  assert.equal(result.usedFallback, false);
});

test("exponential curve compounds by price and observes its raw-step cap", () => {
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 1000, curve: "EXPONENTIAL" }).increment,
    4.5,
  );
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 10_000, curve: "EXPONENTIAL" }).increment,
    1000,
  );
});

test("market sigmoid increases with velocity and rounds currency steps", () => {
  const quiet = calculateDynamicBidIncrement({
    currentBid: 500,
    curve: "MARKET_SIGMOID",
    velocityBidsPerMinute: 5,
  });
  const busy = calculateDynamicBidIncrement({
    currentBid: 500,
    curve: "MARKET_SIGMOID",
    velocityBidsPerMinute: 100,
  });
  assert.equal(quiet.increment, 63);
  assert.equal(busy.increment, 75);
  assert.equal(quiet.usedFallback, false);
  assert.equal(busy.usedFallback, false);
});

test("market rounding uses half-dollar, dollar, and five-dollar granularity", () => {
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 20, curve: "LOGARITHMIC" }).increment,
    2.5,
  );
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 100, curve: "LOGARITHMIC", alphaParam: 10 }).increment,
    12,
  );
  assert.equal(
    calculateDynamicBidIncrement({
      currentBid: 10_000,
      curve: "MARKET_SIGMOID",
      velocityBidsPerMinute: 100,
    }).increment,
    200,
  );
});

test("missing or zero velocity uses the standard bracketed increment", () => {
  for (const velocityBidsPerMinute of [undefined, null, 0]) {
    const result = calculateDynamicBidIncrement({
      currentBid: 500,
      curve: "MARKET_SIGMOID",
      velocityBidsPerMinute,
    });
    assert.equal(result.increment, 25);
    assert.equal(result.curveUsed, "LINEAR_TIERED");
    assert.equal(result.usedFallback, true);
  }
});

test("all curve outputs are at least one and do not exceed fifteen percent of the bid", () => {
  const cases = [
    [20, calculateDynamicBidIncrement({ currentBid: 20, curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [100, calculateDynamicBidIncrement({ currentBid: 100, curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [500, calculateDynamicBidIncrement({ currentBid: 500, curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [10_000, calculateDynamicBidIncrement({ currentBid: 10_000, curve: "EXPONENTIAL" })] as const,
  ];
  for (const [currentBid, { increment }] of cases) {
    assert.ok(increment >= 1);
    assert.ok(increment <= currentBid * 0.15);
  }
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 20, curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 }).increment,
    3,
  );
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 100, curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 }).increment,
    15,
  );
});

test("invalid curves, parameters and prices fail safe to linear increments", () => {
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 500, curve: "LOGARITHMIC", alphaParam: -1 }).increment,
    25,
  );
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: 500, curve: "EXPONENTIAL", gammaParam: Number.NaN }).increment,
    25,
  );
  assert.throws(() => calculateDynamicBidIncrement({ currentBid: -1 }), RangeError);
});
