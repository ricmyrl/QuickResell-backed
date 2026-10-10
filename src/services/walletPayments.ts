import { prisma } from "../lib/prisma.js";
import { verifyPaystackTransaction } from "./paystack.js";

export class WalletPaymentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WalletPaymentError";
  }
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
  if (payment.status !== "success"
    || payment.reference !== reference
    || payment.currency !== "NGN"
    || payment.amount !== transaction.paymentAmountKobo
    || payment.metadata?.transactionType !== "WALLET_TOPUP"
    || payment.metadata.walletTransactionId !== transaction.id
    || payment.metadata.userId !== userId
    || (payment.metadata.amountKobo !== transaction.amountCents
      && !(transaction.status === "PENDING"
        ? payment.metadata.amountUsdCents === transaction.amountCents
        : Number.isSafeInteger(payment.metadata.amountUsdCents)
          && transaction.amountCents === transaction.paymentAmountKobo))
    || payment.metadata.paymentAmountKobo !== transaction.paymentAmountKobo) {
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