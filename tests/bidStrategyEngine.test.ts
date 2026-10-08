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

function room(overrides: Partial<StrategyRoom> = {}): StrategyRoom {
  return {
    currentHighestBid: 0,
    startingPrice: 15,
    highestBidderId: null,
    endsAt: new Date("2026-10-08T12:02:00Z"),
    ...overrides,
  };
}

function rule(overrides: Partial<StrategyRule> = {}): StrategyRule {
  return {
    userId: "buyer-1",
    maxBid: 1000,
    autoBidEnabled: true,
    strategy: "STANDARD",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("system increments use each exact price tier", () => {
  assert.deepEqual(
    [19.99, 20, 99.99, 100, 499.99, 500, 2499.99, 2500].map(systemMinimumIncrement),
    [1, 5, 5, 10, 10, 25, 25, 50],
  );
});

test("standard strategy uses the starting price, raises one bracket, and disqualifies an unaffordable increment", () => {
  assert.deepEqual(evaluateStandardStrategy(room(), rule()), {
    action: "BID",
    amount: 15,
    metadata: { strategy: "STANDARD" },
  });
  assert.equal(evaluateStandardStrategy(room({ currentHighestBid: 100 }), rule()).amount, 110);
  assert.equal(
    evaluateStandardStrategy(room({ startingPrice: 100 }), rule({ maxBid: 80 })).amount,
    80,
  );
  assert.deepEqual(
    evaluateStandardStrategy(room({ currentHighestBid: 100 }), rule({ maxBid: 109 })),
    { action: "DISABLE", reason: "BUDGET_BELOW_MINIMUM_INCREMENT" },
  );
  assert.deepEqual(
    evaluateStandardStrategy(room({ highestBidderId: "buyer-1" }), rule()),
    { action: "SKIP", reason: "ALREADY_LEADING" },
  );
  const stepUps: Array<[number, number]> = [
    [19, 20],
    [20, 25],
    [99.99, 104.99],
    [100, 110],
    [499.99, 509.99],
    [500, 525],
    [2499.99, 2524.99],
    [2500, 2550],
  ];
  for (const [currentHighestBid, expectedAmount] of stepUps) {
    assert.equal(
      evaluateStandardStrategy(room({ currentHighestBid }), rule({ maxBid: 10_000 })).amount,
      expectedAmount,
    );
  }
});

test("equal standard budgets prioritize the earliest rule and disable its tied competitor", () => {
  const result = resolveStandardBudgetTie([
    { ...rule({ userId: "later" }), id: "later-rule", maxBid: 200, createdAt: new Date("2026-02-01") },
    { ...rule({ userId: "earlier" }), id: "earlier-rule", maxBid: 200, createdAt: new Date("2026-01-01") },
  ]);
  assert.equal(result?.winner.userId, "earlier");
  assert.equal(result?.amount, 200);
  assert.deepEqual(result?.disabledRuleIds, ["later-rule"]);
});

test("jump bids scale by the current tier and gracefully degrade to the available budget", () => {
  assert.equal(evaluateJumpBidStrategy(room({ currentHighestBid: 1000 }), rule({ strategy: "JUMP_BID", maxBid: 2000 })).amount, 1050);
  assert.equal(
    evaluateJumpBidStrategy(room({ currentHighestBid: 1000 }), rule({ strategy: "JUMP_BID", maxBid: 2000 })).metadata?.jumpAmount,
    50,
  );
  const degraded = evaluateJumpBidStrategy(
    room({ currentHighestBid: 100 }),
    rule({ strategy: "JUMP_BID", maxBid: 115 }),
  );
  assert.equal(degraded.amount, 115);
  assert.equal(degraded.metadata?.fallback, "CAPPED_STANDARD");
});

test("jump cooldown uses a standard step rather than raising the user's price", () => {
  const result = evaluateJumpBidStrategy(
    room({ currentHighestBid: 100 }),
    rule({ strategy: "JUMP_BID" }),
    { bidderId: "buyer-1", metadata: { strategy: "JUMP_BID" } },
  );
  assert.equal(result.amount, 110);
  assert.equal(result.metadata?.fallback, "COOLDOWN_STANDARD");
});

test("sniper remains dormant before its window and arms at the threshold using database time", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const biddingRoom = room({ endsAt: new Date("2026-10-08T12:02:00.001Z"), currentHighestBid: 100 });
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
    110,
  );
});

test("reserve target leaps directly to reserve and falls back to standard below budget", () => {
  assert.equal(
    evaluateReserveTargetStrategy(
      room({ currentHighestBid: 20 }),
      { reservePrice: 150 },
      rule({ strategy: "RESERVE_TARGET", maxBid: 200 }),
    ).amount,
    150,
  );
  assert.equal(
    evaluateReserveTargetStrategy(
      room({ currentHighestBid: 20 }),
      { reservePrice: 150 },
      rule({ strategy: "RESERVE_TARGET", maxBid: 100 }),
    ).amount,
    25,
  );
  assert.equal(
    evaluateReserveTargetStrategy(room({ currentHighestBid: 20 }), { reservePrice: null }, rule()).amount,
    25,
  );
});

test("analyst applies market value, condition, momentum, and margin of safety to its cap", () => {
  const result = evaluateAnalystStrategy(
    room({ currentHighestBid: 300 }),
    rule({ strategy: "ANALYST", maxBid: 500, marginOfSafety: 0.15 }),
    {
      fairMarketValue: 450,
      recordedSales90Days: 3,
      conditionScore: 0.9,
      momentumAlpha: 0.05,
      marginOfSafety: 0.15,
    },
  );
  assert.equal(result.action, "BID");
  assert.equal(result.amount, 310);
  assert.equal(result.metadata?.calculatedMAV, 425.25);
  assert.equal(result.metadata?.valueCeiling, 361.46);
});

test("analyst forfeits an unaffordable market-priced increment and falls back with insufficient data", () => {
  const overpriced = evaluateAnalystStrategy(
    room({ currentHighestBid: 355 }),
    rule({ strategy: "ANALYST", maxBid: 500 }),
    {
      fairMarketValue: 360,
      recordedSales90Days: 3,
      conditionScore: 1,
      momentumAlpha: 0,
      marginOfSafety: 0,
    },
  );
  assert.equal(overpriced.action, "SKIP");
  assert.equal(overpriced.reason, "OVERPRICED_VS_MARKET");

  const fallback = evaluateAnalystStrategy(
    room({ currentHighestBid: 100 }),
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
  assert.equal(fallback.amount, 110);
  assert.equal(fallback.reason, "INSUFFICIENT_MARKET_DATA");
});
