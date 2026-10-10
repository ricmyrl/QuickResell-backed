import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDynamicBidIncrement,
  standardBracketedIncrement,
} from "../src/services/bidDynamicIncrements.js";

const ngn = (usd: number) => Math.round(usd * 1_331.267014 * 100) / 100;
const approximately = (actual: number, expected: number, tolerance = 0.1) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

test("linear fallback preserves standard bracketed increments", () => {
  assert.equal(standardBracketedIncrement(ngn(19.99)), ngn(1));
  assert.equal(standardBracketedIncrement(ngn(20)), ngn(5));
  assert.equal(standardBracketedIncrement(ngn(100)), ngn(10));
  assert.equal(standardBracketedIncrement(ngn(500)), ngn(25));
  assert.equal(standardBracketedIncrement(ngn(2500)), ngn(50));
  assert.deepEqual(
    calculateDynamicBidIncrement({ currentBid: ngn(500), curve: "LINEAR_TIERED" }),
    { increment: ngn(25), curveUsed: "LINEAR_TIERED", usedFallback: false },
  );
});

test("logarithmic curve follows the dampened formula and market rounding", () => {
  const result = calculateDynamicBidIncrement({ currentBid: ngn(100), curve: "LOGARITHMIC" });
  approximately(result.increment, ngn(6.5));
  assert.equal(result.curveUsed, "LOGARITHMIC");
  assert.equal(result.usedFallback, false);
});

test("exponential curve compounds by price and observes its raw-step cap", () => {
  approximately(
    calculateDynamicBidIncrement({ currentBid: ngn(1000), curve: "EXPONENTIAL" }).increment,
    ngn(4.5),
  );
  assert.ok(calculateDynamicBidIncrement({ currentBid: ngn(10_000), curve: "EXPONENTIAL" }).increment <= ngn(1000));
});

test("market sigmoid increases with velocity and rounds currency steps", () => {
  const quiet = calculateDynamicBidIncrement({
    currentBid: ngn(500),
    curve: "MARKET_SIGMOID",
    velocityBidsPerMinute: 5,
  });
  const busy = calculateDynamicBidIncrement({
    currentBid: ngn(500),
    curve: "MARKET_SIGMOID",
    velocityBidsPerMinute: 100,
  });
  assert.ok(quiet.increment > 0);
  assert.ok(busy.increment > quiet.increment);
  assert.equal(quiet.usedFallback, false);
  assert.equal(busy.usedFallback, false);
});

test("market rounding uses scaled half-dollar, dollar, and five-dollar granularity", () => {
  approximately(
    calculateDynamicBidIncrement({ currentBid: ngn(20), curve: "LOGARITHMIC" }).increment,
    ngn(2.5),
  );
  approximately(
    calculateDynamicBidIncrement({ currentBid: ngn(100), curve: "LOGARITHMIC", alphaParam: ngn(10) }).increment,
    ngn(12),
  );
  approximately(
    calculateDynamicBidIncrement({
      currentBid: ngn(10_000),
      curve: "MARKET_SIGMOID",
      velocityBidsPerMinute: 100,
    }).increment,
    ngn(200),
    0.3,
  );
});

test("missing or zero velocity uses the standard bracketed increment", () => {
  for (const velocityBidsPerMinute of [undefined, null, 0]) {
    const result = calculateDynamicBidIncrement({
      currentBid: ngn(500),
      curve: "MARKET_SIGMOID",
      velocityBidsPerMinute,
    });
    assert.equal(result.increment, ngn(25));
    assert.equal(result.curveUsed, "LINEAR_TIERED");
    assert.equal(result.usedFallback, true);
  }
});

test("all curve outputs are at least one and do not exceed fifteen percent of the bid", () => {
  const cases = [
    [ngn(20), calculateDynamicBidIncrement({ currentBid: ngn(20), curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [ngn(100), calculateDynamicBidIncrement({ currentBid: ngn(100), curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [ngn(500), calculateDynamicBidIncrement({ currentBid: ngn(500), curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 })] as const,
    [ngn(10_000), calculateDynamicBidIncrement({ currentBid: ngn(10_000), curve: "EXPONENTIAL" })] as const,
  ];
  for (const [currentBid, { increment }] of cases) {
    assert.ok(increment >= ngn(1));
    assert.ok(increment <= currentBid * 0.15);
  }
  assert.ok(calculateDynamicBidIncrement({ currentBid: ngn(20), curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 }).increment > 0);
  assert.ok(calculateDynamicBidIncrement({ currentBid: ngn(100), curve: "MARKET_SIGMOID", velocityBidsPerMinute: 100 }).increment > 0);
});

test("invalid curves, parameters and prices fail safe to linear increments", () => {
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: ngn(500), curve: "LOGARITHMIC", alphaParam: -1 }).increment,
    ngn(25),
  );
  assert.equal(
    calculateDynamicBidIncrement({ currentBid: ngn(500), curve: "EXPONENTIAL", gammaParam: Number.NaN }).increment,
    ngn(25),
  );
  assert.throws(() => calculateDynamicBidIncrement({ currentBid: -1 }), RangeError);
});
