import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { getPaystackCallbackUrl, getPaystackSecretKey, verifyPaystackWebhookSignature } from "../src/services/paystack.js";

test("production requires a live Paystack secret key", () => {
  assert.equal(getPaystackSecretKey({ NODE_ENV: "development", PAYSTACK_SECRET_KEY: "sk_test_example" }), "sk_test_example");
  assert.equal(getPaystackSecretKey({ NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_live_a1b2c3" }), "sk_live_a1b2c3");
  assert.throws(() => getPaystackSecretKey({ NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_test_example" }), /live Paystack secret key/);
  assert.throws(() => getPaystackSecretKey({ NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_live_replace-with-your-key" }), /live Paystack secret key/);
  assert.throws(() => getPaystackSecretKey({ NODE_ENV: "production" }), /PAYSTACK_SECRET_KEY is not configured/);
});

test("payment callbacks use the configured frontend origin and identify transaction type", () => {
  assert.equal(
    getPaystackCallbackUrl("CART_CHECKOUT", { FRONTEND_URL: "https://shop.example,https://www.example" }),
    "https://shop.example/payments/callback?type=CART_CHECKOUT",
  );
  assert.equal(
    getPaystackCallbackUrl("WALLET_TOPUP", { FRONTEND_URL: "http://localhost:5173" }),
    "http://localhost:5173/payments/callback?type=WALLET_TOPUP",
  );
});

test("webhook signatures require an exact HMAC-SHA512 match", () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const secret = "sk_live_example";
  const signature = createHmac("sha512", secret).update(body).digest("hex");

  assert.equal(verifyPaystackWebhookSignature(body, signature, secret), true);
  assert.equal(verifyPaystackWebhookSignature(body, signature, "another-secret"), false);
  assert.equal(verifyPaystackWebhookSignature(Buffer.from("{}"), signature, secret), false);
  assert.equal(verifyPaystackWebhookSignature(body, undefined, secret), false);
  assert.equal(verifyPaystackWebhookSignature(body, "invalid", secret), false);
});