import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";

export type PaystackTransaction = {
  status?: unknown;
  reference?: unknown;
  currency?: unknown;
  amount?: unknown;
  metadata?: Record<string, unknown>;
};

export type PaystackBank = { name: string; code: string };

const popularNigerianBankCodes = [
  "044", "011", "058", "033", "057", "070", "214",
  "221", "232", "035", "032", "076", "050", "082",
];
const popularNigerianBankOrder = new Map(
  popularNigerianBankCodes.map((code, index) => [code, index]),
);

export function normalizePaystackBanks(
  banks: Array<{ name?: unknown; code?: unknown; active?: unknown }>,
): PaystackBank[] {
  const normalized = banks
    .filter((bank): bank is { name: string; code: string; active?: unknown } =>
      typeof bank.name === "string" &&
      bank.name.trim().length > 0 &&
      typeof bank.code === "string" &&
      bank.code.trim().length > 0 &&
      bank.active !== false)
    .map(({ name, code }) => ({ name, code }));

  return normalized.sort((left, right) => {
    const leftOrder = popularNigerianBankOrder.get(left.code);
    const rightOrder = popularNigerianBankOrder.get(right.code);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return left.name.localeCompare(right.name);
  });
}

export function convertUsdToPayoutKobo(usdAmount: number, ngnRate: number): number {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0;
  if (!Number.isFinite(ngnRate) || ngnRate <= 0) throw new Error("A valid NGN exchange rate is required for payouts.");
  return Math.round(usdAmount * ngnRate * 100);
}

export async function createPaystackTransferRecipient({
  name,
  accountNumber,
  bankCode,
}: {
  name: string
  accountNumber: string
  bankCode: string
}): Promise<{ recipient_code?: string; details?: { account_number?: string; bank_code?: string } }> {
  const response = await axios.post<{ data?: { recipient_code?: string; details?: { account_number?: string; bank_code?: string } } }>(
    "https://api.paystack.co/transferrecipient",
    {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    },
    {
      headers: {
        Authorization: `Bearer ${getPaystackSecretKey()}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    },
  );

  const recipient = response.data?.data;
  if (!recipient?.recipient_code) {
    throw new Error("Paystack did not return a transfer recipient.");
  }
  return recipient;
}

export async function initiateSellerPayout({
  amountKobo,
  recipientCode,
  reason,
}: {
  amountKobo: number
  recipientCode: string
  reason: string
}): Promise<{ reference?: string; transfer_code?: string; status?: string }> {
  const response = await axios.post<{ data?: { reference?: string; transfer_code?: string; status?: string } }>(
    "https://api.paystack.co/transfer",
    {
      source: "balance",
      reason,
      amount: amountKobo,
      recipient: recipientCode,
    },
    {
      headers: {
        Authorization: `Bearer ${getPaystackSecretKey()}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    },
  );

  const transfer = response.data?.data;
  if (!transfer) {
    throw new Error("Paystack did not create a transfer for the seller.");
  }
  return transfer;
}

export function getPaystackSecretKey(environment: NodeJS.ProcessEnv = process.env): string {
  const secretKey = environment.PAYSTACK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  if (environment.NODE_ENV === "production" &&
      (!secretKey.startsWith("sk_live_") || /replace|your|example/i.test(secretKey))) {
    throw new Error("Production payments require a live Paystack secret key (sk_live_).");
  }
  return secretKey;
}

export function normalizeNigerianIdentityNumber(
  idType: "NIN" | "BVN" | "Passport",
  value: string,
): string {
  const trimmed = value?.trim() ?? "";
  if (idType === "Passport") return trimmed;
  const normalized = trimmed.replace(/[\s-]/g, "");
  if (!/^\d{11}$/.test(normalized)) {
    throw new Error(`Enter a valid 11-digit ${idType} number.`);
  }
  return normalized;
}

export async function validatePaystackIdentityAndBankAccount({
  legalName,
  idType,
  idNumber,
  bankCode,
  accountNumber,
  environment = process.env,
}: {
  legalName: string
  idType: "NIN" | "BVN"
  idNumber: string
  bankCode: string
  accountNumber: string
  environment?: NodeJS.ProcessEnv
}): Promise<void> {
  const secretKey = getPaystackSecretKey(environment);
  const normalized = normalizeNigerianIdentityNumber(idType, idNumber);
  const response = await axios.post<{ status?: boolean; message?: string }>(
    "https://api.paystack.co/bank/validate",
    {
      account_number: accountNumber,
      bank_code: bankCode,
      country_code: "NG",
      account_name: legalName,
      account_type: "personal",
      document_type: "identityNumber",
      document_number: normalized,
    },
    {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    },
  );

  if (response.data?.status !== true) {
    throw new Error(response.data?.message ?? `Paystack could not validate this ${idType} and bank account.`);
  }
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