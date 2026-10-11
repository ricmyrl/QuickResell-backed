import { createHmac, timingSafeEqual } from "node:crypto";
import axios from "axios";

export type PaystackTransaction = {
  status?: unknown;
  reference?: unknown;
  currency?: unknown;
  amount?: unknown;
  paid_at?: unknown;
  metadata?: Record<string, unknown>;
};

export type PaystackBank = { name: string; code: string };

export function asPaystackInteger(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) ? normalized : undefined;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "");
    if (!normalized) return undefined;
    const parsed = Number(normalized); 
    return Number.isFinite(parsed) && Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function hasPaystackChargeAtLeast(expectedAmount: number, actualAmount: number): boolean {
  return Number.isSafeInteger(expectedAmount)
    && Number.isSafeInteger(actualAmount)
    && actualAmount >= expectedAmount;
}

export function validatePayoutAmountKobo(amountKobo: number): number {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new Error("The seller payout must be a positive whole-kobo amount.");
  }
  return amountKobo;
}

export function getPaystackProviderErrorMessage(error: unknown): string | undefined {
  if (!axios.isAxiosError<{ message?: unknown }>(error)) return undefined;
  const message = error.response?.data?.message;
  if (typeof message !== "string" || !message.trim()) return undefined;
  return message
    .replace(/\b\d{10,11}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
}

export function getPaystackErrorDiagnostics(error: unknown): {
  status?: number;
  code?: string;
  message?: string;
} {
  if (!axios.isAxiosError<{ message?: unknown }>(error)) {
    return { message: error instanceof Error ? error.message.slice(0, 240) : "Unknown Paystack error." };
  }
  return {
    status: error.response?.status,
    code: error.code,
    message: getPaystackProviderErrorMessage(error),
  };
}

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
  reference,
  reason,
}: {
  amountKobo: number
  recipientCode: string
  reference: string
  reason: string
}): Promise<{ reference?: string; transfer_code?: string; status?: string }> {
  validatePayoutAmountKobo(amountKobo);
  const response = await axios.post<{ data?: { reference?: string; transfer_code?: string; status?: string } }>(
    "https://api.paystack.co/transfer",
    {
      source: "balance",
      reason,
      amount: amountKobo,
      recipient: recipientCode,
      reference,
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

export async function verifySellerTransfer(reference: string): Promise<{ reference: string; transfer_code?: string; status: string; amount?: number }> {
  const response = await axios.get<{
    data?: { reference?: string; transfer_code?: string; status?: string; amount?: number }
  }>(
    `https://api.paystack.co/transfer/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${getPaystackSecretKey()}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    },
  );

  const transfer = response.data?.data;
  if (!transfer || transfer.reference !== reference || typeof transfer.status !== "string") {
    throw new Error("Paystack did not return a matching transfer status.");
  }
  return {
    reference,
    status: transfer.status,
    transfer_code: transfer.transfer_code,
    amount: transfer.amount,
  };
}

export async function verifySellerTransferByCode(
  reference: string,
  transferCode: string,
): Promise<{ reference: string; transfer_code?: string; status: string; amount?: number }> {
  const response = await axios.get<{
    data?: { reference?: string; transfer_code?: string; status?: string; amount?: number }
  }>(
    `https://api.paystack.co/transfer/${encodeURIComponent(transferCode)}`,
    {
      headers: {
        Authorization: `Bearer ${getPaystackSecretKey()}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    },
  );
  const transfer = response.data?.data;
  if (!transfer || transfer.reference !== reference || typeof transfer.status !== "string") {
    throw new Error("Paystack did not return a matching transfer for this transfer code.");
  }
  return {
    reference,
    status: transfer.status,
    transfer_code: transfer.transfer_code,
    amount: transfer.amount,
  };
}

export async function reconcileSellerTransfer(
  reference: string,
  transferCode?: string | null,
): Promise<{ reference: string; transfer_code?: string; status: string; amount?: number }> {
  try {
    return await verifySellerTransfer(reference);
  } catch (error) {
    if (!transferCode || !axios.isAxiosError(error) || error.response?.status !== 404) throw error;
    return verifySellerTransferByCode(reference, transferCode);
  }
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