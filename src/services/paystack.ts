import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";

export type PaystackTransaction = {
  status?: unknown;
  reference?: unknown;
  currency?: unknown;
  amount?: unknown;
  metadata?: Record<string, unknown>;
};

export function getPaystackSecretKey(environment: NodeJS.ProcessEnv = process.env): string {
  const secretKey = environment.PAYSTACK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  if (environment.NODE_ENV === "production" &&
      (!secretKey.startsWith("sk_live_") || /replace|your|example/i.test(secretKey))) {
    throw new Error("Production payments require a live Paystack secret key (sk_live_).");
  }
  return secretKey;
}

export function getPaystackCallbackUrl(
  transactionType: "CART_CHECKOUT" | "WALLET_TOPUP",
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const frontendOrigin = (environment.FRONTEND_URL ?? "http://localhost:5173").split(",")[0]?.trim();
  if (!frontendOrigin) throw new Error("FRONTEND_URL must be configured for Paystack callbacks.");
  const callbackUrl = new URL("/payments/callback", frontendOrigin);
  callbackUrl.searchParams.set("type", transactionType);
  return callbackUrl.toString();
}

export function verifyPaystackWebhookSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature || !/^[a-f\d]{128}$/i.test(signature)) return false;
  const received = Buffer.from(signature, "hex");
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function verifyPaystackTransaction(reference: string): Promise<PaystackTransaction> {
  if (!reference || reference.length > 100) throw new Error("A valid Paystack reference is required.");
  const response = await axios.get<{ status?: boolean; data?: PaystackTransaction }>(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${getPaystackSecretKey()}` },
      timeout: 15_000,
    },
  );
  if (!response.data?.status || !response.data.data) {
    throw new Error("Paystack could not verify this transaction.");
  }
  return response.data.data;
}