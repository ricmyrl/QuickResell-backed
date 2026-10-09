import assert from "node:assert/strict";
import test from "node:test";
import { feeForAcceptedBid } from "../src/services/auctionPlatformFee.js";

test("retains the actual increase from every second accepted bid", () => {
  assert.equal(feeForAcceptedBid(1, 500), 0);
  assert.equal(feeForAcceptedBid(2, 500), 500);
  assert.equal(feeForAcceptedBid(3, 1_000), 0);
  assert.equal(feeForAcceptedBid(4, 250), 250);
});

test("rejects invalid bid sequence and increment values", () => {
  assert.throws(() => feeForAcceptedBid(0, 500));
  assert.throws(() => feeForAcceptedBid(1.5, 500));
  assert.throws(() => feeForAcceptedBid(1, -1));
  assert.throws(() => feeForAcceptedBid(2, Number.MAX_SAFE_INTEGER + 1));
});
