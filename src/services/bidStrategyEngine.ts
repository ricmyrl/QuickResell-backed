import { standardBracketedIncrement } from "./bidDynamicIncrements.js";

export const bidStrategies = ["STANDARD", "JUMP_BID", "SNIPER", "RESERVE_TARGET", "ANALYST"] as const;
export type BidStrategy = (typeof bidStrategies)[number];

export type StrategyRoom = {
  currentHighestBid: number;
  startingPrice: number;
  highestBidderId: string | null;
  endsAt?: Date | string;
  reservePrice?: number | null;
};

export type StrategyRule = {
  userId: string;
  maxBid: number;
  autoBidEnabled: boolean;
  strategy?: BidStrategy;
  jumpMultiplier?: number;
  sniperWindowSeconds?: number;
  marginOfSafety?: number;
  createdAt?: Date | string;
};

export type BidStrategyMetadata = Record<string, number | string>;
export type StrategyEvaluation = {
  action: "BID" | "SKIP" | "DISABLE";
  amount?: number;
  reason?: string;
  metadata?: BidStrategyMetadata;
};

export type MarketDataPayload = {
  fairMarketValue: number | null;
  recordedSales90Days: number;
  conditionScore: number;
  momentumAlpha: number;
  marginOfSafety: number;
};

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function systemMinimumIncrement(currentBid: number): number {
  return standardBracketedIncrement(currentBid);
}

function currentBid(room: StrategyRoom): number {
  return room.currentHighestBid > 0 ? room.currentHighestBid : 0;
}

function nextStandardAmount(room: StrategyRoom, increment = systemMinimumIncrement(currentBid(room))): number {
  const current = currentBid(room);
  return current === 0
    ? room.startingPrice
    : roundCurrency(current + increment);
}

function qualify(room: StrategyRoom, rule: StrategyRule): StrategyEvaluation | null {
  if (!rule.autoBidEnabled) return { action: "SKIP", reason: "RULE_DISABLED" };
  if (rule.userId === room.highestBidderId) return { action: "SKIP", reason: "ALREADY_LEADING" };
  if (!Number.isFinite(rule.maxBid) || rule.maxBid <= 0) {
    return { action: "DISABLE", reason: "INVALID_MAX_BID" };
  }
  return null;
}

export function evaluateStandardStrategy(
  room: StrategyRoom,
  rule: StrategyRule,
  increment = systemMinimumIncrement(currentBid(room)),
): StrategyEvaluation {
  const rejected = qualify(room, rule);
  if (rejected) return rejected;
  const nextAmount = nextStandardAmount(room, increment);
  if (!Number.isFinite(nextAmount) || nextAmount <= 0) return { action: "DISABLE", reason: "INVALID_STARTING_PRICE" };
  if (currentBid(room) > 0 && nextAmount > rule.maxBid) {
    return { action: "DISABLE", reason: "BUDGET_BELOW_MINIMUM_INCREMENT" };
  }
  return { action: "BID", amount: Math.min(nextAmount, rule.maxBid), metadata: { strategy: "STANDARD" } };
}

export function evaluateJumpBidStrategy(
  room: StrategyRoom,
  rule: StrategyRule,
  previousBid?: { bidderId: string; metadata: BidStrategyMetadata | null } | null,
  increment = systemMinimumIncrement(currentBid(room)),
): StrategyEvaluation {
  const rejected = qualify(room, rule);
  if (rejected) return rejected;
  const standard = evaluateStandardStrategy(room, rule, increment);
  if (standard.action !== "BID") return standard;
  const multiplier = rule.jumpMultiplier ?? 2;
  if (!Number.isFinite(multiplier) || multiplier < 1.5 || multiplier > 5) {
    return { action: "DISABLE", reason: "INVALID_JUMP_MULTIPLIER" };
  }
  const jumpAmount = roundCurrency(increment * multiplier);
  const nextAmount = currentBid(room) === 0
    ? standard.amount!
    : roundCurrency(currentBid(room) + jumpAmount);
  const previousWasJump = previousBid?.bidderId === rule.userId
    && previousBid.metadata?.strategy === "JUMP_BID";

  if (previousWasJump) {
    return {
      action: "BID",
      amount: standard.amount,
      metadata: { strategy: "JUMP_BID", multiplierUsed: multiplier, jumpAmount, fallback: "COOLDOWN_STANDARD" },
    };
  }
  if (nextAmount > rule.maxBid) {
    return {
      action: "BID",
      amount: rule.maxBid,
      metadata: { strategy: "JUMP_BID", multiplierUsed: multiplier, jumpAmount, fallback: "CAPPED_STANDARD" },
    };
  }
  return {
    action: "BID",
    amount: nextAmount,
    metadata: { strategy: "JUMP_BID", multiplierUsed: multiplier, jumpAmount },
  };
}

export function evaluateSniperStrategy(
  room: StrategyRoom & { endsAt: Date | string },
  rule: StrategyRule,
  dbNow: Date,
  increment = systemMinimumIncrement(currentBid(room)),
): StrategyEvaluation {
  const rejected = qualify(room, rule);
  if (rejected) return rejected;
  const windowSeconds = rule.sniperWindowSeconds ?? 120;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) {
    return { action: "DISABLE", reason: "INVALID_SNIPER_WINDOW" };
  }
  const remainingMs = new Date(room.endsAt).getTime() - dbNow.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs > windowSeconds * 1000) {
    return { action: "SKIP", reason: "SNIPER_DORMANT" };
  }
  const standard = evaluateStandardStrategy(room, rule, increment);
  return standard.action === "BID"
    ? { ...standard, metadata: { strategy: "SNIPER" } }
    : standard;
}

export function evaluateReserveTargetStrategy(
  room: StrategyRoom,
  listing: { reservePrice?: number | null },
  rule: StrategyRule,
  increment = systemMinimumIncrement(currentBid(room)),
): StrategyEvaluation {
  const rejected = qualify(room, rule);
  if (rejected) return rejected;
  const reserve = listing.reservePrice;
  if (reserve === null || reserve === undefined || reserve <= 0) {
    const fallback = evaluateStandardStrategy(room, rule, increment);
    return fallback.action === "BID"
      ? { ...fallback, metadata: { strategy: "RESERVE_TARGET", fallback: "STANDARD_NO_RESERVE" } }
      : fallback;
  }
  const current = currentBid(room);
  if (current < reserve && rule.maxBid >= reserve) {
    return {
      action: "BID",
      amount: reserve,
      metadata: { strategy: "RESERVE_TARGET" },
    };
  }
  const fallback = evaluateStandardStrategy(room, rule, increment);
  return fallback.action === "BID"
    ? { ...fallback, metadata: { strategy: "RESERVE_TARGET", fallback: "STANDARD_RESERVE_UNREACHED" } }
    : fallback;
}

export function evaluateAnalystStrategy(
  room: StrategyRoom,
  rule: StrategyRule,
  marketData: MarketDataPayload | null,
  increment = systemMinimumIncrement(currentBid(room)),
): StrategyEvaluation {
  const rejected = qualify(room, rule);
  if (rejected) return rejected;
  if (!marketData || marketData.fairMarketValue === null || marketData.recordedSales90Days < 3) {
    const fallback = evaluateStandardStrategy(room, rule, increment);
    return {
      ...fallback,
      reason: "INSUFFICIENT_MARKET_DATA",
      metadata: { strategy: "ANALYST", fallback: "STANDARD_INSUFFICIENT_MARKET_DATA" },
    };
  }
  const { fairMarketValue, conditionScore, momentumAlpha, marginOfSafety } = marketData;
  if (
    !Number.isFinite(fairMarketValue) || fairMarketValue <= 0
    || !Number.isFinite(conditionScore) || conditionScore <= 0.1 || conditionScore > 1
    || !Number.isFinite(momentumAlpha) || momentumAlpha < -0.3 || momentumAlpha > 0.3
    || !Number.isFinite(marginOfSafety) || marginOfSafety < 0 || marginOfSafety > 1
  ) {
    return { action: "DISABLE", reason: "INVALID_MARKET_DATA" };
  }
  const mav = fairMarketValue * conditionScore * (1 + momentumAlpha);
  const valueCeiling = roundCurrency(mav * (1 - marginOfSafety));
  const effectiveCap = Math.min(rule.maxBid, valueCeiling);
  const nextAmount = nextStandardAmount(room, increment);
  const metadata: BidStrategyMetadata = {
    strategy: "ANALYST",
    fmv: fairMarketValue,
    conditionScore,
    momentumAlpha,
    calculatedMAV: roundCurrency(mav),
    valueCeiling,
    effectiveCap,
  };
  if (currentBid(room) > 0 && nextAmount > rule.maxBid) {
    return { action: "DISABLE", reason: "BUDGET_BELOW_MINIMUM_INCREMENT" };
  }
  if (nextAmount > valueCeiling && nextAmount <= rule.maxBid) {
    return { action: "SKIP", reason: "OVERPRICED_VS_MARKET", metadata };
  }
  if (effectiveCap <= currentBid(room)) {
    return { action: "SKIP", reason: "OVERPRICED_VS_MARKET", metadata };
  }
  return {
    action: "BID",
    amount: Math.min(nextAmount, effectiveCap),
    metadata,
  };
}

export function resolveStandardBudgetTie(
  rules: Array<StrategyRule & { id: string }>,
): { winner: StrategyRule & { id: string }; amount: number; disabledRuleIds: string[] } | null {
  if (rules.length < 2) return null;
  const sorted = [...rules].sort((left, right) => {
    const leftTime = new Date(left.createdAt ?? 0).getTime();
    const rightTime = new Date(right.createdAt ?? 0).getTime();
    return leftTime - rightTime || left.id.localeCompare(right.id);
  });
  const winner = sorted[0];
  if (sorted.some((rule) => rule.strategy !== "STANDARD" || rule.maxBid !== winner.maxBid)) return null;
  return { winner, amount: winner.maxBid, disabledRuleIds: sorted.slice(1).map((rule) => rule.id) };
}
