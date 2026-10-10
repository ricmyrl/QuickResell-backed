import assert from "node:assert/strict";
import test from "node:test";
import { convertNgnKoboToUsdCents } from "../src/services/exchangeRates.js";

test("converts a Paystack naira amount to USD wallet cents", () => {
  assert.equal(convertNgnKoboToUsdCents(150_000, 1_500), 100);
  assert.equal(convertNgnKoboToUsdCents(225_050, 1_500), 150);
});

test("rejects invalid naira amounts and exchange rates", () => {
  assert.throws(() => convertNgnKoboToUsdCents(0, 1_500), /NGN amount must be positive/);
  assert.throws(() => convertNgnKoboToUsdCents(100, 0), /valid USD exchange rate/);
  assert.equal(convertNgnKoboToUsdCents(1, 1_500), 0);
});
