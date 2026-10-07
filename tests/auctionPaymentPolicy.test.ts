import assert from "node:assert/strict";
import test from "node:test";
import { auctionPaymentGraceMs, auctionPaymentWindowMs, isAuctionPaymentOnTime } from "../src/services/auctionPaymentPolicy.js";

test("auction payment deadline is 24 hours", () => {
  assert.equal(auctionPaymentWindowMs, 24 * 60 * 60 * 1000);
});

test("auction payments completed by the deadline are accepted without grace", () => {
  const dueAt = new Date("2025-01-02T12:00:00.000Z");

  assert.equal(isAuctionPaymentOnTime(dueAt, dueAt, null), true);
  assert.equal(isAuctionPaymentOnTime(new Date(dueAt.getTime() - 1), dueAt, null), true);
  assert.equal(isAuctionPaymentOnTime(new Date(dueAt.getTime() + 1), dueAt, null), false);
});

test("auction payment grace accepts payments for at most 15 minutes after the deadline", () => {
  const dueAt = new Date("2025-01-02T12:00:00.000Z");
  const graceUntil = new Date(dueAt.getTime() + auctionPaymentGraceMs);

  assert.equal(isAuctionPaymentOnTime(graceUntil, dueAt, graceUntil), true);
  assert.equal(isAuctionPaymentOnTime(new Date(graceUntil.getTime() + 1), dueAt, graceUntil), false);
  assert.equal(isAuctionPaymentOnTime(new Date(dueAt.getTime() + 1), dueAt, null), false);
});

test("auction payment cannot be accepted without a seller-acceptance deadline", () => {
  assert.equal(isAuctionPaymentOnTime(new Date(), null, null), false);
});
