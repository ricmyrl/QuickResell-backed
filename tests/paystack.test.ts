import assert from "node:assert/strict";
import axios from "axios";
import { createHmac } from "node:crypto";
import test from "node:test";
import { getPaystackCallbackUrl, getPaystackProviderErrorMessage, getPaystackSecretKey, normalizeNigerianIdentityNumber, normalizePaystackBanks, validatePaystackIdentityAndBankAccount, verifyPaystackWebhookSignature } from "../src/services/paystack.js";

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

test("NIN and BVN values are normalized and must contain 11 digits", () => {
  assert.equal(normalizeNigerianIdentityNumber("NIN", "123-456-78901"), "12345678901");
  assert.equal(normalizeNigerianIdentityNumber("BVN", "12345678901"), "12345678901");
  assert.throws(() => normalizeNigerianIdentityNumber("NIN", "1234567890"), /11-digit NIN/);
  assert.throws(() => normalizeNigerianIdentityNumber("BVN", "1234567890A"), /11-digit BVN/);
});

test("Paystack identity validation includes the selected bank code", async () => {
  const originalAdapter = axios.defaults.adapter;
  let requestBody: Record<string, unknown> | undefined;
  axios.defaults.adapter = async (config) => {
    requestBody = JSON.parse(String(config.data)) as Record<string, unknown>;
    return {
      data: { status: true },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  try {
    await validatePaystackIdentityAndBankAccount({
      legalName: "Test User",
      idType: "BVN",
      idNumber: "12345678901",
      bankCode: "044",
      accountNumber: "0123456789",
      environment: { PAYSTACK_SECRET_KEY: "sk_test_example" },
    });
    assert.equal(requestBody?.bank_code, "044");
    assert.equal(requestBody?.country_code, "NG");
    assert.equal(requestBody?.account_name, "Test User");
    assert.equal(requestBody?.document_number, "12345678901");
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
});

test("Paystack provider errors are retained without exposing identity numbers", () => {
  const error = {
    isAxiosError: true,
    response: { data: { message: "BVN 12345678901 did not match account 0123456789" } },
  };
  assert.equal(
    getPaystackProviderErrorMessage(error),
    "BVN [redacted] did not match account [redacted]",
  );
  assert.equal(getPaystackProviderErrorMessage(new Error("not a provider error")), undefined);
});

test("Paystack bank list does not invent banks absent from the provider response", () => {
  assert.deepEqual(normalizePaystackBanks([]), []);
  assert.deepEqual(
    normalizePaystackBanks([{ name: "Access Bank", code: "044", active: false }]),
    [],
  );
});

test("Paystack bank list includes active banks outside a hard-coded bank-code list", () => {
  assert.deepEqual(
    normalizePaystackBanks([
      { name: "Advancly MFB", code: "090759", active: true },
      { name: "Access Bank", code: "044", active: true },
      { name: "Guaranty Trust Bank", code: "058", active: true },
      { name: "New Nigerian Bank", code: "999001", active: true },
      { name: "Inactive Bank", code: "999002", active: false },
    ]),
    [
      { name: "Access Bank", code: "044" },
      { name: "Guaranty Trust Bank", code: "058" },
      { name: "Advancly MFB", code: "090759" },
      { name: "New Nigerian Bank", code: "999001" },
    ],
  );
});

test("Paystack bank list puts popular commercial banks first and sorts the rest alphabetically", () => {
  assert.deepEqual(
    normalizePaystackBanks([
      { name: "Zenith Bank", code: "057", active: true },
      { name: "Other Bank", code: "999001", active: true },
      { name: "United Bank For Africa", code: "033", active: true },
      { name: "Access Bank", code: "044", active: true },
      { name: "Another Bank", code: "999002", active: true },
    ]),
    [
      { name: "Access Bank", code: "044" },
      { name: "United Bank For Africa", code: "033" },
      { name: "Zenith Bank", code: "057" },
      { name: "Another Bank", code: "999002" },
      { name: "Other Bank", code: "999001" },
    ],
  );
});