export function feeForAcceptedBid(sequence: number, incrementAmountCents: number): number {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Bid sequence must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(incrementAmountCents) || incrementAmountCents < 0) {
    throw new Error("Bid increment must be a non-negative safe integer number of cents.");
  }
  return sequence % 2 === 0 ? incrementAmountCents : 0;
}
