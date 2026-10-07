export const auctionPaymentWindowMs = 24 * 60 * 60 * 1000;
export const auctionPaymentGraceMs = 15 * 60 * 1000;
export const buyerDefaultPenaltyPoints = 20;
export const buyerBidSuspensionMonths = 6;

export function isAuctionPaymentOnTime(
  paidAt: Date,
  paymentDueAt: Date | null,
  paymentGraceUntil: Date | null,
): boolean {
  return Boolean(paymentDueAt && (
    paidAt <= paymentDueAt
    || (paymentGraceUntil && paidAt <= paymentGraceUntil)
  ));
}
