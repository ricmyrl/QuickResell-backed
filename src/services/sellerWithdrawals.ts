import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { getPaystackErrorDiagnostics, initiateSellerPayout, verifySellerTransfer } from "./paystack.js";

type WithdrawalStatus = "PROCESSING" | "SUCCESS" | "FAILED" | "REVERSED" | "REVIEW_REQUIRED";
type TransferEvent = "transfer.success" | "transfer.failed" | "transfer.reversed" | "transfer.queued" | "transfer.processing";

export class SellerWithdrawalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SellerWithdrawalError";
  }
}

function statusFromPaystack(status: string | undefined): WithdrawalStatus {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  if (status === "reversed") return "REVERSED";
  return status === "otp" ? "REVIEW_REQUIRED" : "PROCESSING";
}

async function updateWithdrawalStatus(
  withdrawalId: string,
  status: WithdrawalStatus,
  data: { transferCode?: string | null; failureReason?: string | null } = {},
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const withdrawal = await transaction.sellerWithdrawal.findUnique({
      where: { id: withdrawalId },
      select: { id: true, walletId: true, amountCents: true, transferReference: true, status: true },
    });
    if (!withdrawal) return false;
    if (withdrawal.status === status) return false;
    if (withdrawal.status === "FAILED" || withdrawal.status === "REVERSED") return false;
    if (withdrawal.status === "SUCCESS" && status !== "REVERSED") return false;

    const updated = await transaction.sellerWithdrawal.updateMany({
      where: { id: withdrawal.id, status: withdrawal.status },
      data: {
        ...data,
        status,
        completedAt: ["SUCCESS", "FAILED", "REVERSED"].includes(status) ? new Date() : null,
      },
    });
    if (updated.count !== 1) return false;

    if (status === "SUCCESS") {
      await transaction.walletTransaction.updateMany({
        where: { paymentReference: withdrawal.transferReference, status: "PENDING" },
        data: { status: "COMPLETED" },
      });
    } else if (status === "FAILED" || status === "REVERSED") {
      await transaction.wallet.update({
        where: { id: withdrawal.walletId },
        data: { balanceCents: { increment: withdrawal.amountCents } },
      });
      await transaction.walletTransaction.updateMany({
        where: { paymentReference: withdrawal.transferReference, status: { in: ["PENDING", "COMPLETED"] } },
        data: { status: "FAILED" },
      });
    }
    return true;
  });
}

export async function withdrawSellerEarnings(sellerId: string, amountKobo: number) {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new SellerWithdrawalError("Enter a valid withdrawal amount in whole kobo.", 400);
  }

  const verification = await prisma.sellerVerification.findUnique({
    where: { userId: sellerId },
    select: { payoutStatus: true, bankAccountNumber: true, bankAccountName: true, paystackRecipientCode: true },
  });
  if (verification?.payoutStatus !== "VERIFIED"
    || !verification.bankAccountNumber
    || !verification.bankAccountName
    || !verification.paystackRecipientCode) {
    throw new SellerWithdrawalError("Verify your payout bank account before withdrawing seller earnings.", 409);
  }

  const reference = `QRW_${randomUUID().replaceAll("-", "")}`;
  const withdrawal = await prisma.$transaction(async (transaction) => {
    const lockedPayouts = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT payout."id"
      FROM "SellerPayout" payout
      INNER JOIN "PurchaseOrderItem" item ON item."id" = payout."orderItemId"
      INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
      WHERE payout."sellerId" = ${sellerId}::uuid
        AND payout."status" IN ('PENDING', 'BLOCKED')
        AND item."fulfillmentStatus" IN ('READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
        AND orders."paymentReference" IS NOT NULL
        AND orders."status" <> 'CANCELLED'
      ORDER BY payout."createdAt", payout."id"
      FOR UPDATE OF payout
    `;
    if (lockedPayouts.length === 0) {
      throw new SellerWithdrawalError("There are no fulfilled seller earnings available to withdraw.", 409);
    }

    const payoutIds = lockedPayouts.map(({ id }) => id);
    const payouts = await transaction.sellerPayout.findMany({
      where: { id: { in: payoutIds }, sellerId, status: { in: ["PENDING", "BLOCKED"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, amountCents: true, status: true, transferReference: true },
    });
    const existingAllocations = await transaction.sellerWithdrawalAllocation.findMany({
      where: {
        sellerPayoutId: { in: payoutIds },
        withdrawal: { status: { in: ["PROCESSING", "SUCCESS", "REVIEW_REQUIRED"] } },
      },
      select: { sellerPayoutId: true, amountCents: true },
    });
    const allocatedCents = new Map<string, number>();
    for (const allocation of existingAllocations) {
      allocatedCents.set(allocation.sellerPayoutId, (allocatedCents.get(allocation.sellerPayoutId) ?? 0) + allocation.amountCents);
    }

    let availableCents = 0;
    const availableByPayout = payouts.map((payout) => {
      const remainingCents = Math.max(0, payout.amountCents - (allocatedCents.get(payout.id) ?? 0));
      availableCents += remainingCents;
      return { ...payout, remainingCents };
    }).filter((payout) => payout.remainingCents > 0);
    if (amountKobo > availableCents) {
      throw new SellerWithdrawalError("The requested amount exceeds your fulfilled seller earnings available to withdraw.", 409);
    }

    const wallet = await transaction.wallet.findUnique({ where: { userId: sellerId }, select: { id: true } });
    if (!wallet) throw new SellerWithdrawalError("Your seller earnings wallet is unavailable. Refresh and try again.", 409);
    const walletDebit = await transaction.wallet.updateMany({
      where: { id: wallet.id, balanceCents: { gte: amountKobo } },
      data: { balanceCents: { decrement: amountKobo } },
    });
    if (walletDebit.count !== 1) {
      throw new SellerWithdrawalError("Your available wallet balance is too low. Wallet funds already spent cannot be withdrawn again.", 409);
    }

    const created = await transaction.sellerWithdrawal.create({
      data: {
        sellerId,
        walletId: wallet.id,
        amountCents: amountKobo,
        amountKobo,
        recipientCode: verification.paystackRecipientCode!,
        transferReference: reference,
        status: "PROCESSING",
      },
      select: { id: true, amountKobo: true, recipientCode: true },
    });
    await transaction.walletTransaction.create({
      data: {
        walletId: wallet.id,
        paymentReference: reference,
        amountCents: amountKobo,
        paymentAmountKobo: amountKobo,
        type: "CASHOUT",
        direction: "DEBIT",
        status: "PENDING",
      },
    });

    let remaining = amountKobo;
    for (const payout of availableByPayout) {
      if (remaining === 0) break;
      const allocationCents = Math.min(remaining, payout.remainingCents);
      if (payout.status === "BLOCKED") {
        await transaction.sellerPayout.updateMany({
          where: { id: payout.id, status: "BLOCKED" },
          data: { status: "PENDING", recipientCode: verification.paystackRecipientCode, failureReason: null },
        });
      }
      await transaction.sellerWithdrawalAllocation.create({
        data: { withdrawalId: created.id, sellerPayoutId: payout.id, amountCents: allocationCents },
      });
      remaining -= allocationCents;
    }
    if (remaining !== 0) {
      throw new SellerWithdrawalError("Seller earnings changed while preparing this withdrawal. Refresh and try again.", 409);
    }
    return created;
  }, { isolationLevel: "Serializable" });

  try {
    const transfer = await initiateSellerPayout({
      amountKobo: withdrawal.amountKobo,
      recipientCode: withdrawal.recipientCode,
      reference,
      reason: "QuickResell seller earnings withdrawal",
    });
    await updateWithdrawalStatus(withdrawal.id, statusFromPaystack(transfer.status), {
      transferCode: transfer.transfer_code ?? null,
      failureReason: transfer.status === "failed" ? "PAYSTACK_TRANSFER_FAILED" : null,
    });
  } catch (error) {
    await updateWithdrawalStatus(withdrawal.id, "REVIEW_REQUIRED", {
      failureReason: "PAYSTACK_RESULT_REQUIRES_RECONCILIATION",
    });
    console.error("Seller wallet withdrawal requires manual Paystack reconciliation.", {
      sellerId,
      transferReference: reference,
      paystackError: getPaystackErrorDiagnostics(error),
    });
  }

  return prisma.sellerWithdrawal.findUniqueOrThrow({
    where: { id: withdrawal.id },
    select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
  });
}

export async function reconcileSellerWithdrawal(withdrawalId: string, sellerId: string) {
  const withdrawal = await prisma.sellerWithdrawal.findFirst({
    where: { id: withdrawalId, sellerId },
    select: {
      id: true,
      status: true,
      transferReference: true,
      transferCode: true,
      amountKobo: true,
    },
  });
  if (!withdrawal) throw new SellerWithdrawalError("Withdrawal not found.", 404);
  if (withdrawal.status !== "PROCESSING" && withdrawal.status !== "REVIEW_REQUIRED") {
    throw new SellerWithdrawalError("This withdrawal does not currently need a Paystack status check.", 409);
  }

  let transfer: Awaited<ReturnType<typeof verifySellerTransfer>>;
  try {
    transfer = await verifySellerTransfer(withdrawal.transferReference);
  } catch (error) {
    const diagnostics = getPaystackErrorDiagnostics(error);
    console.error("Paystack could not confirm a seller wallet withdrawal status.", {
      sellerId,
      withdrawalId,
      paystackError: diagnostics,
    });
    const message = diagnostics.status === 401 || diagnostics.status === 403
      ? "Paystack rejected the server credentials. Support must check the Paystack account and environment used for this withdrawal."
      : diagnostics.status === 404
        ? "Paystack could not find this withdrawal reference. Support must check the Paystack dashboard before any retry."
        : diagnostics.status === 429
          ? "Paystack is rate-limiting status checks. Wait a few minutes and check again; do not submit another withdrawal."
          : diagnostics.status !== undefined && diagnostics.status >= 500
            ? "Paystack is temporarily unavailable. Wait a few minutes and check again; do not submit another withdrawal."
            : diagnostics.code === "ECONNABORTED" || diagnostics.code === "ETIMEDOUT"
              ? "The Paystack status check timed out. Wait a few minutes and check again; do not submit another withdrawal."
              : diagnostics.status === undefined
                ? "The server could not reach Paystack to check this withdrawal. Contact support; do not submit another withdrawal."
                : `Paystack status check failed (HTTP ${diagnostics.status}). Contact support; do not submit another withdrawal.`;
    throw new SellerWithdrawalError(message, 502);
  }

  if (typeof transfer.amount === "number" && transfer.amount !== withdrawal.amountKobo) {
    console.error("Paystack transfer amount does not match the seller wallet withdrawal.", {
      sellerId,
      withdrawalId,
      recordedAmountKobo: withdrawal.amountKobo,
      verifiedAmountKobo: transfer.amount,
    });
    throw new SellerWithdrawalError("Paystack returned a transfer amount that does not match this withdrawal. Contact support; do not withdraw again.", 409);
  }

  const status = statusFromPaystack(transfer.status);
  await updateWithdrawalStatus(withdrawal.id, status, {
    transferCode: transfer.transfer_code ?? withdrawal.transferCode,
    failureReason: status === "FAILED"
      ? "PAYSTACK_TRANSFER_FAILED"
      : status === "REVIEW_REQUIRED"
        ? "PAYSTACK_TRANSFER_REQUIRES_ACTION"
        : null,
  });
  return prisma.sellerWithdrawal.findUniqueOrThrow({
    where: { id: withdrawal.id },
    select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
  });
}

export async function applyPaystackWithdrawalEvent(
  reference: string,
  event: TransferEvent,
  transferCode?: string,
): Promise<boolean> {
  const withdrawal = await prisma.sellerWithdrawal.findUnique({
    where: { transferReference: reference },
    select: { id: true, transferCode: true },
  });
  if (!withdrawal) return false;

  const status: WithdrawalStatus = event === "transfer.success"
    ? "SUCCESS"
    : event === "transfer.failed"
      ? "FAILED"
      : event === "transfer.reversed"
        ? "REVERSED"
        : "PROCESSING";
  const changed = await updateWithdrawalStatus(withdrawal.id, status, {
    transferCode: transferCode ?? withdrawal.transferCode,
    failureReason: status === "FAILED" ? "PAYSTACK_TRANSFER_FAILED" : null,
  });
  return changed || (await prisma.sellerWithdrawal.findUnique({
    where: { transferReference: reference },
    select: { status: true },
  }))?.status === status;
}
