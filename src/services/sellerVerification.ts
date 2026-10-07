import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";

export type SmileEnvironment = "sandbox" | "production";
export type SellerVerificationProvider = "paystack" | "smile";

export function canPublishListings(verification: {
  identityStatus: string;
  payoutStatus: string;
  failureCode: string | null;
} | null): boolean {
  if (!verification || verification.payoutStatus !== "VERIFIED") return false;
  return verification.identityStatus === "VERIFIED" ||
    (verification.identityStatus === "REVIEW_REQUIRED" &&
      verification.failureCode === "IDENTITY_MANUAL_REVIEW");
}

export type SmileConfiguration = {
  partnerId: string;
  apiKey: string;
  environment: SmileEnvironment;
  partnerName: string;
  logoUrl: string;
  privacyPolicyUrl: string;
  themeColor: string;
  callbackUrl: string;
};

export function getSellerVerificationProvider(environment: NodeJS.ProcessEnv = process.env): SellerVerificationProvider {
  const requested = environment.SELLER_VERIFICATION_PROVIDER?.trim().toLowerCase();
  if (requested === "manual" || requested === "manual_review" || requested === "paystack") return "paystack";
  if (requested === "smile" || requested === "smile_id") return "smile";

  return "paystack";
}

export function getSmileConfiguration(environment: NodeJS.ProcessEnv = process.env): SmileConfiguration {
  const partnerId = environment.SMILE_ID_PARTNER_ID?.trim() ?? "";
  const apiKey = environment.SMILE_ID_API_KEY?.trim() ?? "";
  const smileEnvironment = environment.SMILE_ID_ENVIRONMENT?.trim() as SmileEnvironment | undefined;
  const partnerName = environment.SMILE_ID_PARTNER_NAME?.trim() ?? "";
  const logoUrl = environment.SMILE_ID_LOGO_URL?.trim() ?? "";
  const privacyPolicyUrl = environment.SMILE_ID_PRIVACY_POLICY_URL?.trim() ?? "";
  const callbackBaseUrl = environment.PUBLIC_API_URL?.trim() ?? "";
  const themeColor = environment.SMILE_ID_THEME_COLOR?.trim() || "#315f49";

  if (!/^[1-9]\d*$/.test(partnerId) || !apiKey || !partnerName || !logoUrl || !privacyPolicyUrl) {
    throw new Error("Smile ID partner credentials and branded verification details are not configured.");
  }
  if (smileEnvironment !== "sandbox" && smileEnvironment !== "production") {
    throw new Error("SMILE_ID_ENVIRONMENT must be sandbox or production.");
  }
  if (environment.NODE_ENV === "production" && smileEnvironment !== "production") {
    throw new Error("Production seller verification requires SMILE_ID_ENVIRONMENT=production.");
  }
  const callbackOrigin = callbackBaseUrl || (environment.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!callbackOrigin) throw new Error("PUBLIC_API_URL must be configured for seller verification callbacks.");

  let callbackUrl: URL;
  try {
    callbackUrl = new URL("/api/seller/verification/smile-webhook", callbackOrigin);
    if (environment.NODE_ENV === "production" && callbackUrl.protocol !== "https:") {
      throw new Error("PUBLIC_API_URL must use HTTPS in production.");
    }
    if (new URL(logoUrl).protocol !== "https:" || new URL(privacyPolicyUrl).protocol !== "https:") {
      throw new Error("Smile ID logo and privacy policy URLs must use HTTPS.");
    }
  } catch {
    throw new Error("Configure valid HTTPS Smile ID logo, privacy policy, and callback URLs.");
  }

  return {
    partnerId,
    apiKey,
    environment: smileEnvironment,
    partnerName,
    logoUrl,
    privacyPolicyUrl,
    themeColor,
    callbackUrl: callbackUrl.toString(),
  };
}

function smileApiBase(environment: SmileEnvironment): string {
  return environment === "production" ? "https://api.smileidentity.com" : "https://testapi.smileidentity.com";
}

export async function mintSmileToken(configuration: SmileConfiguration): Promise<string> {
  const response = await axios.post<{ token?: unknown }>(`${smileApiBase(configuration.environment)}/v3/token`, undefined, {
    headers: {
      "SmileID-Partner-ID": configuration.partnerId,
      "SmileID-API-Key": configuration.apiKey,
    },
    timeout: 15_000,
  });
  if (typeof response.data?.token !== "string" || !response.data.token) {
    throw new Error("Smile ID did not return an access token.");
  }
  return response.data.token;
}

export async function getSmileJobStatus(configuration: SmileConfiguration, jobId: string): Promise<{ status: string; job_id: string; user_id: string }> {
  const token = await mintSmileToken(configuration);
  const response = await axios.get<{ status?: unknown; job_id?: unknown; user_id?: unknown }>(
    `${smileApiBase(configuration.environment)}/v3/status/${encodeURIComponent(jobId)}`,
    {
      headers: {
        "SmileID-Partner-ID": configuration.partnerId,
        "SmileID-Token": token,
      },
      timeout: 15_000,
    },
  );
  const result = response.data;
  if (typeof result.status !== "string" || typeof result.job_id !== "string" || typeof result.user_id !== "string") {
    throw new Error("Smile ID returned an invalid verification status.");
  }
  return { status: result.status, job_id: result.job_id, user_id: result.user_id };
}

export function isValidSmileWebhookSignature(timestamp: string | undefined, signature: string | undefined, configuration: SmileConfiguration, now = Date.now()): boolean {
  if (!timestamp || !signature) return false;
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(now - eventTime) > 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", configuration.apiKey)
    .update(`${timestamp}${configuration.partnerId}sid_request`)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function hashVerifiedName(fullName: string, secret: string): string {
  const normalized = fullName
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-NG")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .sort()
    .join(" ");
  if (normalized.length < 4) throw new Error("The provider returned an incomplete identity name.");
  return createHmac("sha256", secret).update(normalized).digest("hex");
}

export function hashPayoutNameMatches(accountName: string, verifiedNameHash: string, secret: string): boolean {
  try {
    const actual = Buffer.from(hashVerifiedName(accountName, secret), "hex");
    const expected = Buffer.from(verifiedNameHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}