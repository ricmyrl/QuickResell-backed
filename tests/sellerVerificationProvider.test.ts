import assert from "node:assert/strict";
import test from "node:test";

import { canPublishListings, getSellerVerificationProvider } from "../src/services/sellerVerification.js";

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

test("sellers with verified payout and Paystack manual identity review can publish listings", () => {
  assert.equal(canPublishListings({
    identityStatus: "REVIEW_REQUIRED",
    payoutStatus: "VERIFIED",
    failureCode: "IDENTITY_MANUAL_REVIEW",
  }), true);
});

test("listing publication still requires verified payout and approved identity or the manual-review state", () => {
  assert.equal(canPublishListings(null), false);
  assert.equal(canPublishListings({
    identityStatus: "VERIFIED",
    payoutStatus: "NOT_STARTED",
    failureCode: null,
  }), false);
  assert.equal(canPublishListings({
    identityStatus: "REVIEW_REQUIRED",
    payoutStatus: "VERIFIED",
    failureCode: "OTHER_REVIEW_REASON",
  }), false);
  assert.equal(canPublishListings({
    identityStatus: "REJECTED",
    payoutStatus: "VERIFIED",
    failureCode: "IDENTITY_MANUAL_REVIEW",
  }), false);
});
