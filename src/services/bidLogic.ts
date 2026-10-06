export const maxAllowedBid = 10_000_000;

export type AutoBidRuleCandidate = {
  id: string;
  userId: string;
  maxBid: number;
  bidStep: number;
  autoBidEnabled: boolean;
  createdAt: Date | string;
};

export type ProxyBidDecision = { bidderId: string; amount: number };

export function isValidManualBidAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maxAllowedBid;
}

export function calculateProxyBid(
  currentHighestBid: number,
  maxBid: number,
  bidStep: number,
  competingMaxBid = currentHighestBid,
): number | null {
  if (![currentHighestBid, maxBid, bidStep, competingMaxBid].every(Number.isFinite) ||
      currentHighestBid < 0 || bidStep <= 0 || maxBid <= currentHighestBid ||
      competingMaxBid < currentHighestBid || competingMaxBid > maxBid) {
    return null;
  }

  const nextAmount = Math.max(currentHighestBid + bidStep, competingMaxBid + bidStep);
  const cappedAmount = Math.min(maxBid, nextAmount);
  return cappedAmount > currentHighestBid ? cappedAmount : null;
}

export function selectProxyBid(
  currentHighestBid: number,
  highestBidderId: string | null,
  sellerId: string,
  rules: AutoBidRuleCandidate[],
): ProxyBidDecision | null {
  const eligibleRules = rules.filter((rule) =>
    rule.autoBidEnabled &&
    rule.userId !== sellerId &&
    Number.isFinite(rule.maxBid) && rule.maxBid > currentHighestBid && rule.maxBid <= maxAllowedBid &&
    Number.isFinite(rule.bidStep) && rule.bidStep > 0,
  );

  eligibleRules.sort((left, right) =>
    right.maxBid - left.maxBid ||
    Number(right.userId === highestBidderId) - Number(left.userId === highestBidderId) ||
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
    left.id.localeCompare(right.id),
  );

  const leadingRule = eligibleRules[0];
  if (!leadingRule) return null;
  const competingRule = eligibleRules.find((rule) => rule.userId !== leadingRule.userId);
  if (leadingRule.userId === highestBidderId && !competingRule) return null;

  const amount = calculateProxyBid(
    currentHighestBid,
    leadingRule.maxBid,
    leadingRule.bidStep,
    competingRule?.maxBid ?? currentHighestBid,
  );
  return amount === null ? null : { bidderId: leadingRule.userId, amount };
}