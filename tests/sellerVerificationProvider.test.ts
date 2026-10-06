import assert from "node:assert/strict";
import test from "node:test";

import { getSellerVerificationProvider } from "../src/services/sellerVerification.js";

test("Paystack is selected by default even when Smile ID is configured", () => {
  const provider = getSellerVerificationProvider({
    NODE_ENV: "development",
    SMILE_ID_PARTNER_ID: "12345",
    SMILE_ID_API_KEY: "secret",
    SMILE_ID_ENVIRONMENT: "sandbox",
    SMILE_ID_PARTNER_NAME: "Quick Resell",
    SMILE_ID_LOGO_URL: "https://example.com/logo.png",
    SMILE_ID_PRIVACY_POLICY_URL: "https://example.com/privacy",
  } as NodeJS.ProcessEnv);

  assert.equal(provider, "paystack");
});

test("Smile provider is selected only when explicitly requested", () => {
  const provider = getSellerVerificationProvider({
    NODE_ENV: "development",
    SELLER_VERIFICATION_PROVIDER: "smile",
    SMILE_ID_PARTNER_ID: "12345",
    SMILE_ID_API_KEY: "secret",
    SMILE_ID_ENVIRONMENT: "sandbox",
    SMILE_ID_PARTNER_NAME: "Quick Resell",
    SMILE_ID_LOGO_URL: "https://example.com/logo.png",
    SMILE_ID_PRIVACY_POLICY_URL: "https://example.com/privacy",
  } as NodeJS.ProcessEnv);

  assert.equal(provider, "smile");
});
