import { prisma } from "../lib/prisma.js";
import { getPaystackErrorDiagnostics, initiateSellerPayout, verifySellerTransfer } from "./paystack.js";

export type PayoutNotificationStatus = "BLOCKED" | "SUCCESS" | "FAILED" | "REVERSED" | "REVIEW_REQUIRED";

export class SellerCashoutError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SellerCashoutError";
  }
}

export function getSellerPayoutNotification(
  status: PayoutNotificationStatus,
  amountKobo: number | null,
  orderId: string,
) {
  const amount = amountKobo === null
    ? ""
    : `${(amountKobo / 100).toLocaleString("en-NG", { style: "currency", currency: "NGN" })} `;
  const messages: Record<PayoutNotificationStatus, { title: string; message: string }> = {
    BLOCKED: {
      title: "Seller payout needs attention",
      message: `Your payout for order ${orderId} is blocked. Verify your payout account or contact support.`,
    },
    SUCCESS: {
      title: "Seller payout sent",
      message: `Paystack reports your ${amount}payout for order ${orderId} as successful. Check your bank account to confirm receipt.`,
    },
    FAILED: {
      title: "Seller payout failed",
      message: `Paystack reports your ${amount}payout for order ${orderId} as failed. Contact support before any retry.`,
    },
    REVERSED: {
      title: "Seller payout reversed",
      message: `Paystack reversed your ${amount}payout for order ${orderId}. Contact support.`,
    },
    REVIEW_REQUIRED: {
      title: "Seller payout needs review",
      message: `The result of your ${amount}payout for order ${orderId} needs reconciliation. Contact support before taking further action.`,
    },
  };
  return messages[status];
}

function statusFromPaystack(status: string | undefined): "PROCESSING" | "SUCCESS" | "FAILED" | "REVERSED" | "REVIEW_REQUIRED" {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  if (status === "reversed") return "REVERSED";
  if (status === "otp") return "REVIEW_REQUIRED";
  return "PROCESSING";
}

async function updatePayoutStatus(
  payoutId: string,
  status: "BLOCKED" | "PROCESSING" | "SUCCESS" | "FAILED" | "REVERSED" | "REVIEW_REQUIRED",
  data: { amountKobo?: number; transferCode?: string | null; failureReason?: string | null },
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const payout = await transaction.sellerPayout.findUnique({
      where: { id: payoutId },
      select: { id: true, orderId: true, sellerId: true, amountKobo: true, status: true },
    });
    if (!payout) return false;
    if (payout.status === status) {
      await transaction.sellerPayout.updateMany({
        where: { id: payout.id, status },
        data,
      });
      return false;
    }
    if (payout.status === "FAILED" || payout.status === "REVERSED"
      || (payout.status === "SUCCESS" && status !== "REVERSED")) return false;

    const updated = await transaction.sellerPayout.updateMany({
      where: { id: payout.id, status: payout.status },
      data: {
        ...data,
        status,
        completedAt: status === "SUCCESS" || status === "FAILED" || status === "REVERSED" ? new Date() : null,
      },
    });
    if (updated.count !== 1) return false;

    if (status === "BLOCKED" || status === "SUCCESS" || status === "FAILED" || status === "REVERSED" || status === "REVIEW_REQUIRED") {
      const notification = getSellerPayoutNotification(status, data.amountKobo ?? payout.amountKobo, payout.orderId);
      await transaction.notification.create({
        data: {
          userId: payout.sellerId,
          type: "ORDER_UPDATE",
          title: notification.title,
          message: notification.message,
          entityType: "SELLER_PAYOUT",
          entityId: payout.id,
        },
      });
    }
    if (status === "FAILED" || status === "REVERSED") {
      const cashoutTransaction = await transaction.walletTransaction.findUnique({
        where: { paymentReference: `QR-CASHOUT-${payout.id}` },
        select: { id: true, status: true, amountCents: true },
      });
      if (cashoutTransaction?.status === "COMPLETED") {
        const refundableAmount = payout.amountKobo ?? data.amountKobo ?? cashoutTransaction.amountCents;
        if (!Number.isSafeInteger(refundableAmount) || refundableAmount <= 0) {
          throw new Error(`Seller payout ${payout.id} has an invalid refundable amount.`);
        }
        const wallet = await transaction.wallet.findUnique({
          where: { userId: payout.sellerId },
          select: { id: true },
        });
        if (!wallet) throw new Error(`Seller wallet is missing for payout ${payout.id}.`);
        await transaction.wallet.update({
          where: { id: wallet.id },
          data: { balanceCents: { increment: refundableAmount } },
        });
        await transaction.walletTransaction.updateMany({
          where: { id: cashoutTransaction.id, status: "COMPLETED" },
          data: { status: "FAILED" },
        });
      }
    }
    return true;
  });
}

export async function cashOutSellerOrderItem(itemId: string, sellerId: string) {
  const item = await prisma.purchaseOrderItem.findFirst({
    where: { id: itemId, sellerId },
    include: {
      order: { select: { id: true, paymentReference: true, status: true } },
      sellerPayout: true,
    },
  });
  if (!item) throw new SellerCashoutError("Order item not found.", 404);
  if (!item.order.paymentReference) {
    throw new SellerCashoutError("The buyer's payment must be confirmed before cashing out.", 409);
  }
  if (item.order.status === "CANCELLED") {
    throw new SellerCashoutError("A cancelled order cannot be cashed out.", 409);
  }
  if (!["READY_FOR_PICKUP", "SHIPPED", "COMPLETED"].includes(item.fulfillmentStatus)) {
    throw new SellerCashoutError("Mark this item pickup-ready or shipped before cashing out.", 409);
  }
  if (!item.sellerPayout) {
    throw new SellerCashoutError("This older order has no tracked payout record. Check Paystack before requesting any payment.", 409);
  }

  const verification = await prisma.sellerVerification.findUnique({
    where: { userId: sellerId },
    select: {
      payoutStatus: true,
      bankAccountNumber: true,
      bankAccountName: true,
      paystackRecipientCode: true,
    },
  });
  if (verification?.payoutStatus !== "VERIFIED"
    || !verification.bankAccountNumber
    || !verification.bankAccountName
    || !verification.paystackRecipientCode) {
    throw new SellerCashoutError("Verify your payout bank account before cashing out.", 409);
  }

  let payout = item.sellerPayout;
  if (payout.status === "BLOCKED") {
    if (payout.amountCents <= 0) {
      throw new SellerCashoutError("This item has no positive seller proceeds to cash out.", 409);
    }
    const updated = await prisma.sellerPayout.updateMany({
      where: { id: payout.id, status: "BLOCKED" },
      data: {
        status: "PENDING",
        recipientCode: verification.paystackRecipientCode,
        failureReason: null,
      },
    });
    if (updated.count !== 1) {
      throw new SellerCashoutError("The payout status changed. Refresh your sales and try again.", 409);
    }
    payout = { ...payout, status: "PENDING", recipientCode: verification.paystackRecipientCode };
  }
  if (payout.status !== "PENDING") {
    throw new SellerCashoutError(
      payout.status === "SUCCESS"
        ? "This item has already been paid out."
        : payout.status === "PROCESSING"
          ? "This payout is already processing."
          : "This payout needs reconciliation. Contact support before trying again.",
      409,
    );
  }
  if (!payout.recipientCode || !payout.transferReference) {
    throw new SellerCashoutError("A verified Paystack recipient is required before cashing out.", 409);
  }

  const amountKobo = payout.amountCents;
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new SellerCashoutError("The payout amount could not be calculated safely.", 409);
  }

  const claimed = await prisma.$transaction(async (transaction) => {
    const payoutClaim = await transaction.sellerPayout.updateMany({
      where: { id: payout.id, status: "PENDING" },
      data: {
        status: "PROCESSING",
        amountKobo,
        recipientCode: verification.paystackRecipientCode,
        failureReason: null,
      },
    });
    if (payoutClaim.count !== 1) return false;

    const withdrawalAllocation = await transaction.sellerWithdrawalAllocation.findFirst({
      where: {
        sellerPayoutId: payout.id,
        withdrawal: { status: { in: ["PROCESSING", "SUCCESS", "REVIEW_REQUIRED"] } },
      },
      select: { id: true },
    });
    if (withdrawalAllocation) {
      throw new SellerCashoutError("Part of this sale is already included in a wallet withdrawal. Refresh your wallet before cashing out the sale.", 409);
    }

    const walletDebit = await transaction.wallet.updateMany({
      where: { userId: sellerId, balanceCents: { gte: payout.amountCents } },
      data: { balanceCents: { decrement: payout.amountCents } },
    });
    if (walletDebit.count !== 1) {
      throw new SellerCashoutError("Your available wallet balance is too low to cash out this sale.", 409);
    }
    const wallet = await transaction.wallet.findUniqueOrThrow({
      where: { userId: sellerId },
      select: { id: true },
    });
    await transaction.walletTransaction.create({
      data: {
        walletId: wallet.id,
        paymentReference: `QR-CASHOUT-${payout.id}`,
        amountCents: payout.amountCents,
        paymentAmountKobo: amountKobo,
        type: "CASHOUT",
        direction: "DEBIT",
        orderId: item.order.id,
        orderItemId: item.id,
        status: "COMPLETED",
      },
    });
    return true;
  });
  if (!claimed) {
    throw new SellerCashoutError("This payout was already claimed. Refresh its status before trying again.", 409);
  }

  try {
    const transfer = await initiateSellerPayout({
      amountKobo,
      recipientCode: verification.paystackRecipientCode,
      reference: payout.transferReference,
      reason: `QuickResell seller payout for order ${item.order.id}`,
    });
    await updatePayoutStatus(payout.id, statusFromPaystack(transfer.status), {
      amountKobo,
      transferCode: transfer.transfer_code ?? null,
      failureReason: transfer.status === "failed" ? "PAYSTACK_TRANSFER_FAILED" : null,
    });
  } catch (error) {
    await updatePayoutStatus(payout.id, "REVIEW_REQUIRED", {
      amountKobo,
      failureReason: "PAYSTACK_RESULT_REQUIRES_RECONCILIATION",
    });
    console.error("Seller cashout result requires manual Paystack reconciliation.", {
      sellerId,
      orderId: item.order.id,
      orderItemId: item.id,
      transferReference: payout.transferReference,
      paystackError: getPaystackErrorDiagnostics(error),
    });
  }

  return prisma.sellerPayout.findUniqueOrThrow({
    where: { id: payout.id },
    select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
  });
}

export async function reconcileSellerPayout(itemId: string, sellerId: string) {
  const item = await prisma.purchaseOrderItem.findFirst({
    where: { id: itemId, sellerId },
    select: {
      sellerPayout: {
        select: { id: true, status: true, transferReference: true, transferCode: true, amountKobo: true },
      },
    },
  });
  const payout = item?.sellerPayout;
  if (!payout) throw new SellerCashoutError("This order has no tracked Paystack payout to reconcile.", 409);
  if (!payout.transferReference) {
    throw new SellerCashoutError("This payout has no Paystack reference. Contact support before taking further action.", 409);
  }
  if (payout.status !== "REVIEW_REQUIRED" && payout.status !== "PROCESSING") {
    throw new SellerCashoutError("This payout does not currently need a Paystack status check.", 409);
  }

  let transfer: Awaited<ReturnType<typeof verifySellerTransfer>>;
  try {
    transfer = await verifySellerTransfer(payout.transferReference);
  } catch (error) {
    console.error("Paystack could not confirm a seller payout status.", {
      sellerId,
      orderItemId: itemId,
      paystackError: getPaystackErrorDiagnostics(error),
    });
    const diagnostics = getPaystackErrorDiagnostics(error);
    const message = diagnostics.status === 401 || diagnostics.status === 403
      ? "Paystack rejected the server credentials. Support must check that the Paystack key matches the account and environment used for this transfer."
      : diagnostics.status === 404
        ? "Paystack could not find this transfer reference. Support must check the Paystack dashboard and account before any retry."
        : diagnostics.status === 400 || diagnostics.status === 422
          ? "Paystack rejected the transfer status request. Support must review the reference in the Paystack dashboard."
          : "Paystack could not confirm the transfer yet. Try checking again later; do not submit another cash-out.";
    throw new SellerCashoutError(message, 502);
  }
  if (typeof transfer.amount === "number" && payout.amountKobo !== null && transfer.amount !== payout.amountKobo) {
    console.error("Paystack transfer amount does not match the recorded seller payout.", {
      sellerId,
      orderItemId: itemId,
      transferReference: payout.transferReference,
      recordedAmountKobo: payout.amountKobo,
      verifiedAmountKobo: transfer.amount,
    });
    throw new SellerCashoutError("Paystack returned a transfer amount that does not match this payout. Contact support; do not cash out again.", 409);
  }

  const status = statusFromPaystack(transfer.status);
  await updatePayoutStatus(payout.id, status, {
    amountKobo: payout.amountKobo ?? undefined,
    transferCode: transfer.transfer_code ?? payout.transferCode,
    failureReason: status === "FAILED"
      ? "PAYSTACK_TRANSFER_FAILED"
      : status === "REVIEW_REQUIRED"
        ? "PAYSTACK_TRANSFER_REQUIRES_ACTION"
        : null,
  });
  return prisma.sellerPayout.findUniqueOrThrow({
    where: { id: payout.id },
    select: { id: true, status: true, amountKobo: true, updatedAt: true, completedAt: true },
  });
}

export async function applyPaystackTransferEvent(
  reference: string,
  event: "transfer.success" | "transfer.failed" | "transfer.reversed" | "transfer.queued" | "transfer.processing",
  transferCode?: string,
): Promise<boolean> {
  const status = event === "transfer.success"
    ? "SUCCESS"
    : event === "transfer.failed"
      ? "FAILED"
      : event === "transfer.reversed"
        ? "REVERSED"
        : "PROCESSING";
  const existing = await prisma.sellerPayout.findUnique({
    where: { transferReference: reference },
    select: { id: true, transferCode: true },
  });
  if (!existing) return false;

  const changed = await updatePayoutStatus(existing.id, status, {
    transferCode: transferCode ?? existing.transferCode,
    failureReason: status === "FAILED" ? "PAYSTACK_TRANSFER_FAILED" : null,
  });
  return changed || (await prisma.sellerPayout.findUnique({
    where: { transferReference: reference },
    select: { status: true },
  }))?.status === status;
}
