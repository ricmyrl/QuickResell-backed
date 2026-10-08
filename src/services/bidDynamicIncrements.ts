export const incrementCurveTypes = [
  "LINEAR_TIERED",
  "LOGARITHMIC",
  "EXPONENTIAL",
  "MARKET_SIGMOID",
] as const;

export type IncrementCurveType = (typeof incrementCurveTypes)[number];

export type DynamicIncrementInput = {
  currentBid: number;
  curve?: IncrementCurveType | null;
  alphaParam?: number | null;
  gammaParam?: number | null;
  velocityBidsPerMinute?: number | null;
};

export type DynamicIncrementResult = {
  increment: number;
  curveUsed: IncrementCurveType;
  usedFallback: boolean;
};

const MIN_INCREMENT = 1;
const LOG_ANCHOR = 50;
const EXPONENTIAL_STEP_CAP_RATIO = 0.1;
const BID_STEP_CAP_RATIO = 0.15;

export function standardBracketedIncrement(currentBid: number): number {
  if (!Number.isFinite(currentBid) || currentBid < 0) {
    throw new RangeError("currentBid must be a finite non-negative number.");
  }
  if (currentBid < 20) return 1;
  if (currentBid < 100) return 5;
  if (currentBid < 500) return 10;
  if (currentBid < 2500) return 25;
  return 50;
}

function marketGranularity(step: number): number {
  return step < 10 ? 0.5 : step <= 100 ? 1 : 5;
}

function roundAndClampStep(rawStep: number, currentBid: number): number {
  const granularity = marketGranularity(rawStep);
  let step = Math.round((rawStep + Number.EPSILON) / granularity) * granularity;
  const upperBound = Math.max(MIN_INCREMENT, currentBid * BID_STEP_CAP_RATIO);
  if (step > upperBound) {
    step = Math.floor((upperBound + Number.EPSILON) / granularity) * granularity;
  }
  return Math.max(MIN_INCREMENT, Math.round(step * 100) / 100);
}

function fallback(currentBid: number): DynamicIncrementResult {
  const increment = standardBracketedIncrement(currentBid);
  return { increment, curveUsed: "LINEAR_TIERED", usedFallback: true };
}

export function calculateDynamicBidIncrement(input: DynamicIncrementInput): DynamicIncrementResult {
  const {
    currentBid,
    curve: configuredCurve,
    alphaParam = 5,
    gammaParam = 0.0015,
    velocityBidsPerMinute,
  } = input;
  if (!Number.isFinite(currentBid) || currentBid < 0) {
    throw new RangeError("currentBid must be a finite non-negative number.");
  }
  const curve = configuredCurve ?? "LINEAR_TIERED";
  if (curve === "LINEAR_TIERED") {
    return {
      increment: standardBracketedIncrement(currentBid),
      curveUsed: "LINEAR_TIERED",
      usedFallback: false,
    };
  }
  if (currentBid === 0) return fallback(currentBid);

  let rawIncrement: number;
  if (curve === "LOGARITHMIC") {
    const alpha = alphaParam ?? 5;
    if (!Number.isFinite(alpha) || alpha < 0) return fallback(currentBid);
    rawIncrement = MIN_INCREMENT + alpha * Math.log1p(currentBid / LOG_ANCHOR);
  } else if (curve === "EXPONENTIAL") {
    const gamma = gammaParam ?? 0.0015;
    if (!Number.isFinite(gamma) || gamma < 0) return fallback(currentBid);
    rawIncrement = Math.min(
      MIN_INCREMENT * Math.exp(gamma * currentBid),
      currentBid * EXPONENTIAL_STEP_CAP_RATIO,
    );
  } else {
    if (!Number.isFinite(velocityBidsPerMinute) || (velocityBidsPerMinute ?? 0) <= 0) {
      return fallback(currentBid);
    }
    const velocity = velocityBidsPerMinute!;
    const multiplier = 1 + 3 / (1 + Math.exp(-0.8 * (velocity - 5)));
    rawIncrement = standardBracketedIncrement(currentBid) * multiplier;
  }

  if (!Number.isFinite(rawIncrement) || rawIncrement <= 0) return fallback(currentBid);
  const increment = roundAndClampStep(rawIncrement, currentBid);
  return { increment, curveUsed: curve, usedFallback: false };
}
