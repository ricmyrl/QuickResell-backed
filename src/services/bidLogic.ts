export const maxAllowedBid = 13_312_670_140;
export const minimumBidIncrement = 1_331.27;

export type AutoBidRuleCandidate = {
  id: string;
  userId: string;
  maxBid: number;
  bidStep: number;
  autoBidEnabled: boolean;
  createdAt: Date | string;
};

export type ProxyBidDecision = { bidderId: string; amount: number };

/** Helper to convert dates safely to timestamps */
function getTimestamp(date: Date | string): number {
  const time = new Date(date).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Rounds currency calculations to 2 decimal places to avoid float drift */
function roundCurrency(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function isValidManualBidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maxAllowedBid;
}

export function minimumBidAmount(currentHighestBid: number, startingPrice: number): number {
  return Math.max(currentHighestBid, startingPrice) + minimumBidIncrement;
}

export function calculateProxyBid(
  currentHighestBid: number,
  maxBid: number,
  bidStep: number,
  competingMaxBid = currentHighestBid,
): number | null {
  if (
    ![currentHighestBid, maxBid, bidStep, competingMaxBid].every(Number.isFinite) ||
    currentHighestBid < 0 ||
    bidStep <= 0 ||
    maxBid < currentHighestBid + minimumBidIncrement ||
    competingMaxBid < currentHighestBid ||
    competingMaxBid > maxBid
  ) {
    return null;
  }

  const rawNextAmount = Math.max(currentHighestBid + minimumBidIncrement, currentHighestBid + bidStep, competingMaxBid + bidStep);
  const nextAmount = roundCurrency(rawNextAmount);
  const cappedAmount = roundCurrency(Math.min(maxBid, nextAmount));

  return cappedAmount > currentHighestBid ? cappedAmount : null;
}

export function selectProxyBid(
  currentHighestBid: number,
  highestBidderId: string | null,
  sellerId: string,
  rules: AutoBidRuleCandidate[],
): ProxyBidDecision | null {
  const eligibleRules = rules.filter(
    (rule) =>
      rule.autoBidEnabled &&
      rule.userId !== sellerId &&
      Number.isFinite(rule.maxBid) &&
      rule.maxBid >= currentHighestBid + minimumBidIncrement &&
      rule.maxBid <= maxAllowedBid &&
      Number.isFinite(rule.bidStep) &&
      rule.bidStep > 0,
  );

  eligibleRules.sort((left, right) => {
    // 1. Highest maxBid gets priority
    if (right.maxBid !== left.maxBid) return right.maxBid - left.maxBid;

    // 2. Existing top bidder retains priority on maxBid tie
    const isRightCurrent = right.userId === highestBidderId ? 1 : 0;
    const isLeftCurrent = left.userId === highestBidderId ? 1 : 0;
    if (isRightCurrent !== isLeftCurrent) return isRightCurrent - isLeftCurrent;

    // 3. Earlier created rule wins tie
    const leftTime = getTimestamp(left.createdAt);
    const rightTime = getTimestamp(right.createdAt);
    if (leftTime !== rightTime) return leftTime - rightTime;

    // 4. Deterministic fallback ID sorting
    return left.id.localeCompare(right.id);
  });

  const leadingRule = eligibleRules[0];
  if (!leadingRule) return null;

  const competingRule = eligibleRules.find((rule) => rule.userId !== leadingRule.userId);

  // Do not raise bid against yourself if there is no competing auto-bid rule
  if (leadingRule.userId === highestBidderId && !competingRule) return null;

  const amount = calculateProxyBid(
    currentHighestBid,
    leadingRule.maxBid,
    leadingRule.bidStep,
    competingRule?.maxBid ?? currentHighestBid,
  );

  return amount === null ? null : { bidderId: leadingRule.userId, amount };
}