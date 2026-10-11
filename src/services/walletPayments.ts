import { prisma } from "../lib/prisma.js";
import { asPaystackInteger, verifyPaystackTransaction } from "./paystack.js";

export class WalletPaymentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WalletPaymentError";
  }
}

export function isWalletTopUpPaymentValid(
  reference: string,
  payment: {
    status?: unknown;
    reference?: unknown;
    currency?: unknown;
    amount?: unknown;
    metadata?: Record<string, unknown>;
  },
  transaction: {
    id: string;
    amountCents: number;
    paymentAmountKobo: number | null;
    status: "PENDING" | "COMPLETED" | "FAILED";
  },
  userId: string,
): boolean {
  const paymentAmount = asPaystackInteger(payment.amount);
  const expectedAmount = asPaystackInteger(transaction.paymentAmountKobo ?? transaction.amountCents);
  const metadataAmountKobo = asPaystackInteger(payment.metadata?.amountKobo);
  const metadataPaymentAmountKobo = asPaystackInteger(payment.metadata?.paymentAmountKobo);
  const metadataAmountUsdCents = asPaystackInteger(payment.metadata?.amountUsdCents);
  const requestedAmount = transaction.paymentAmountKobo ?? transaction.amountCents;

  return payment.status === "success"
    && payment.reference === reference
    && payment.currency === "NGN"
    && paymentAmount !== undefined
    && expectedAmount !== undefined
    && paymentAmount >= expectedAmount
    && payment.metadata?.transactionType === "WALLET_TOPUP"
    && payment.metadata.walletTransactionId === transaction.id
    && payment.metadata.userId === userId
    && (
      (metadataAmountKobo ?? NaN) === transaction.amountCents
      || (metadataPaymentAmountKobo ?? NaN) === requestedAmount
      || (transaction.status === "PENDING"
        && (metadataAmountUsdCents ?? NaN) === transaction.amountCents)
      || (transaction.status !== "PENDING"
        && Number.isSafeInteger(metadataAmountUsdCents)
        && transaction.amountCents === transaction.paymentAmountKobo)
    );
}

export async function finalizeWalletTopUp(reference: string, userId: string): Promise<number> {
  const transaction = await prisma.walletTransaction.findFirst({
    where: { paymentReference: reference, wallet: { userId } },
  });
  if (!transaction || transaction.status === "FAILED") {
    throw new WalletPaymentError("This wallet deposit could not be found.", 404);
  }

  let payment;
  try {
    payment = await verifyPaystackTransaction(reference);
  } catch {
    throw new WalletPaymentError("Paystack verification is temporarily unavailable.", 502);
  }

  if (!isWalletTopUpPaymentValid(reference, payment, {
    id: transaction.id,
    amountCents: transaction.amountCents,
    paymentAmountKobo: transaction.paymentAmountKobo,
    status: transaction.status,
  }, userId)) {
    throw new WalletPaymentError("Payment could not be verified for this wallet deposit.", 402);
  }

  const wallet = await prisma.$transaction(async (database) => {
    const updated = await database.walletTransaction.updateMany({
      where: { id: transaction.id, status: "PENDING" },
      data: {
        status: "COMPLETED",
        amountCents: transaction.paymentAmountKobo ?? transaction.amountCents,
      },
    });
    if (updated.count === 1) {
      await database.wallet.update({
        where: { id: transaction.walletId },
        data: { balanceCents: { increment: transaction.paymentAmountKobo ?? transaction.amountCents } },
      });
    }
    return database.wallet.findUniqueOrThrow({
      where: { id: transaction.walletId },
      select: { balanceCents: true },
    });
  });

  return wallet.balanceCents;
}