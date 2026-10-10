import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAnalystStrategy,
  evaluateJumpBidStrategy,
  evaluateReserveTargetStrategy,
  evaluateSniperStrategy,
  evaluateStandardStrategy,
  resolveStandardBudgetTie,
  systemMinimumIncrement,
  type StrategyRoom,
  type StrategyRule,
} from "../src/services/bidStrategyEngine.js";

const ngn = (usd: number) => Math.round(usd * 1_331.267014 * 100) / 100;
const assertNgnApprox = (actual: number | undefined, expected: number, tolerance = 0.05) => {
  assert.ok(actual !== undefined && Math.abs(actual - ngn(expected)) <= tolerance,
    `${actual} is not within ${tolerance} of ${ngn(expected)}`);
};

function room(overrides: Partial<StrategyRoom> = {}): StrategyRoom {
  return {
    currentHighestBid: 0,
    startingPrice: ngn(15),
    highestBidderId: null,
    endsAt: new Date("2026-10-08T12:02:00Z"),
    ...overrides,
  };
}

function rule(overrides: Partial<StrategyRule> = {}): StrategyRule {
  return {
    userId: "buyer-1",
    maxBid: ngn(1000),
    autoBidEnabled: true,
    strategy: "STANDARD",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("system increments use each exact naira price tier", () => {
  assert.deepEqual(
    [19.99, 20, 99.99, 100, 499.99, 500, 2499.99, 2500].map(ngn).map(systemMinimumIncrement),
    [1, 5, 5, 10, 10, 25, 25, 50].map(ngn),
  );
});

test("standard strategy uses the starting price, raises one bracket, and disqualifies an unaffordable increment", () => {
  assert.deepEqual(evaluateStandardStrategy(room(), rule()), {
    action: "BID",
    amount: ngn(15),
    metadata: { strategy: "STANDARD" },
  });
  assert.equal(evaluateStandardStrategy(room({ currentHighestBid: ngn(100) }), rule()).amount, ngn(110));
  assert.equal(
    evaluateStandardStrategy(room({ startingPrice: ngn(100) }), rule({ maxBid: ngn(80) })).amount,
    ngn(80),
  );
  assert.deepEqual(
    evaluateStandardStrategy(room({ currentHighestBid: ngn(100) }), rule({ maxBid: ngn(109) })),
    { action: "DISABLE", reason: "BUDGET_BELOW_MINIMUM_INCREMENT" },
  );
  assert.deepEqual(
    evaluateStandardStrategy(room({ highestBidderId: "buyer-1" }), rule()),
    { action: "SKIP", reason: "ALREADY_LEADING" },
  );
  const stepUps: Array<[number, number]> = [
    [ngn(19), ngn(20)],
    [ngn(20), ngn(25)],
    [ngn(99.99), ngn(104.99)],
    [ngn(100), ngn(110)],
    [ngn(499.99), ngn(509.99)],
    [ngn(500), ngn(525)],
    [ngn(2499.99), ngn(2524.99)],
    [ngn(2500), ngn(2550)],
  ];
  for (const [currentHighestBid, expectedAmount] of stepUps) {
    const actualAmount = evaluateStandardStrategy(room({ currentHighestBid }), rule({ maxBid: ngn(10_000) })).amount;
    assert.ok(actualAmount !== undefined && Math.abs(actualAmount - expectedAmount) <= 0.05);
  }
});

test("equal standard budgets prioritize the earliest rule and disable its tied competitor", () => {
  const result = resolveStandardBudgetTie([
    { ...rule({ userId: "later" }), id: "later-rule", maxBid: ngn(200), createdAt: new Date("2026-02-01") },
    { ...rule({ userId: "earlier" }), id: "earlier-rule", maxBid: ngn(200), createdAt: new Date("2026-01-01") },
  ]);
  assert.equal(result?.winner.userId, "earlier");
  assert.equal(result?.amount, ngn(200));
  assert.deepEqual(result?.disabledRuleIds, ["later-rule"]);
});

test("jump bids scale by the current tier and gracefully degrade to the available budget", () => {
  assertNgnApprox(evaluateJumpBidStrategy(room({ currentHighestBid: ngn(1000) }), rule({ strategy: "JUMP_BID", maxBid: ngn(2000) })).amount, 1050);
  assertNgnApprox(
    Number(evaluateJumpBidStrategy(room({ currentHighestBid: ngn(1000) }), rule({ strategy: "JUMP_BID", maxBid: ngn(2000) })).metadata?.jumpAmount),
    50,
  );
  const degraded = evaluateJumpBidStrategy(
    room({ currentHighestBid: ngn(100) }),
    rule({ strategy: "JUMP_BID", maxBid: ngn(115) }),
  );
  assert.equal(degraded.amount, ngn(115));
  assert.equal(degraded.metadata?.fallback, "CAPPED_STANDARD");
});

test("jump cooldown uses a standard step rather than raising the user's price", () => {
  const result = evaluateJumpBidStrategy(
    room({ currentHighestBid: ngn(100) }),
    rule({ strategy: "JUMP_BID" }),
    { bidderId: "buyer-1", metadata: { strategy: "JUMP_BID" } },
  );
  assert.equal(result.amount, ngn(110));
  assert.equal(result.metadata?.fallback, "COOLDOWN_STANDARD");
});

test("sniper remains dormant before its window and arms at the threshold using database time", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const biddingRoom = room({ endsAt: new Date("2026-10-08T12:02:00.001Z"), currentHighestBid: ngn(100) });
  assert.deepEqual(
    evaluateSniperStrategy(biddingRoom, rule({ strategy: "SNIPER" }), now),
    { action: "SKIP", reason: "SNIPER_DORMANT" },
  );
  assert.equal(
    evaluateSniperStrategy(
      { ...biddingRoom, endsAt: new Date("2026-10-08T12:01:59.999Z") },
      rule({ strategy: "SNIPER" }),
      now,
    ).amount,
    ngn(110),
  );
});

test("reserve target leaps directly to reserve and falls back to standard below budget", () => {
  assert.equal(
    evaluateReserveTargetStrategy(
      room({ currentHighestBid: ngn(20) }),
      { reservePrice: ngn(150) },
      rule({ strategy: "RESERVE_TARGET", maxBid: ngn(200) }),
    ).amount,
    ngn(150),
  );
  assert.equal(
    evaluateReserveTargetStrategy(
      room({ currentHighestBid: ngn(20) }),
      { reservePrice: ngn(150) },
      rule({ strategy: "RESERVE_TARGET", maxBid: ngn(100) }),
    ).amount,
    ngn(25),
  );
  assert.equal(
    evaluateReserveTargetStrategy(room({ currentHighestBid: ngn(20) }), { reservePrice: null }, rule()).amount,
    ngn(25),
  );
});

test("analyst applies market value, condition, momentum, and margin of safety to its cap", () => {
  const result = evaluateAnalystStrategy(
    room({ currentHighestBid: ngn(300) }),
    rule({ strategy: "ANALYST", maxBid: ngn(500), marginOfSafety: 0.15 }),
    {
      fairMarketValue: ngn(450),
      recordedSales90Days: 3,
      conditionScore: 0.9,
      momentumAlpha: 0.05,
      marginOfSafety: 0.15,
    },
  );
  assert.equal(result.action, "BID");
  const expectedMav = Math.round(ngn(450) * 0.9 * 1.05 * 100) / 100;
  assertNgnApprox(result.amount, 310);
  assert.equal(result.metadata?.calculatedMAV, expectedMav);
  assert.equal(result.metadata?.valueCeiling, Math.round(expectedMav * 0.85 * 100) / 100);
});

test("analyst forfeits an unaffordable market-priced increment and falls back with insufficient data", () => {
  const overpriced = evaluateAnalystStrategy(
    room({ currentHighestBid: ngn(355) }),
    rule({ strategy: "ANALYST", maxBid: ngn(500) }),
    {
      fairMarketValue: ngn(360),
      recordedSales90Days: 3,
      conditionScore: 1,
      momentumAlpha: 0,
      marginOfSafety: 0,
    },
  );
  assert.equal(overpriced.action, "SKIP");
  assert.equal(overpriced.reason, "OVERPRICED_VS_MARKET");

  const fallback = evaluateAnalystStrategy(
    room({ currentHighestBid: ngn(100) }),
    rule({ strategy: "ANALYST" }),
    {
      fairMarketValue: null,
      recordedSales90Days: 2,
      conditionScore: 1,
      momentumAlpha: 0,
      marginOfSafety: 0,
    },
  );
  assert.equal(fallback.action, "BID");
  assert.equal(fallback.amount, ngn(110));
  assert.equal(fallback.reason, "INSUFFICIENT_MARKET_DATA");
});
