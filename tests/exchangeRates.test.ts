import assert from "node:assert/strict";
import test from "node:test";
import { getExchangeRates } from "../src/services/exchangeRates.js";

test("reports Nigerian naira as the canonical currency without external exchange rates", async () => {
  const rates = await getExchangeRates();
  assert.equal(rates.base, "NGN");
  assert.equal(rates.rates.NGN, 1);
  assert.ok(Number.isFinite(Date.parse(rates.updatedAt)));
});
