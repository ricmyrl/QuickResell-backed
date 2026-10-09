import { prisma } from "../lib/prisma.js";
import { getExchangeRates } from "./exchangeRates.js";
import { convertUsdToPayoutKobo, initiateSellerPayout } from "./paystack.js";

export type PayoutNotificationStatus = "BLOCKED" | "SUCCESS" | "FAILED" | "REVERSED" | "REVIEW_REQUIRED";

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

function statusFromPaystack(status: string | undefined): "PROCESSING" | "SUCCESS" | "FAILED" | "REVIEW_REQUIRED" {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
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
    if (!payout || payout.status === status) return false;
    if (payout.status === "SUCCESS" || payout.status === "REVERSED") return false;

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
    return true;
  });
}

export async function processPendingSellerPayouts(orderId: string): Promise<void> {
  const payouts = await prisma.sellerPayout.findMany({
    where: { orderId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (payouts.length === 0) return;

  const payoutRate = await getExchangeRates();
  for (const payout of payouts) {
    if (!payout.recipientCode || payout.amountUsdCents <= 0 || !payout.transferReference) {
      await updatePayoutStatus(payout.id, "BLOCKED", { failureReason: "PAYOUT_DETAILS_OR_AMOUNT_INVALID" });
      continue;
    }

    const amountKobo = convertUsdToPayoutKobo(payout.amountUsdCents / 100, payoutRate.rates.NGN);
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      await updatePayoutStatus(payout.id, "BLOCKED", { failureReason: "CONVERTED_PAYOUT_AMOUNT_INVALID" });
      continue;
    }

    const claimed = await prisma.sellerPayout.updateMany({
      where: { id: payout.id, status: "PENDING" },
      data: { status: "PROCESSING", amountKobo, failureReason: null },
    });
    if (claimed.count !== 1) continue;

    try {
      const transfer = await initiateSellerPayout({
        amountKobo,
        recipientCode: payout.recipientCode,
        reference: payout.transferReference,
        reason: `QuickResell seller payout for order ${orderId}`,
      });
      const status = statusFromPaystack(transfer.status);
      await updatePayoutStatus(payout.id, status, {
        amountKobo,
        transferCode: transfer.transfer_code ?? null,
        failureReason: status === "FAILED" ? "PAYSTACK_TRANSFER_FAILED" : null,
      });
    } catch (error) {
      await updatePayoutStatus(payout.id, "REVIEW_REQUIRED", {
        amountKobo,
        failureReason: "PAYSTACK_RESULT_REQUIRES_RECONCILIATION",
      });
      console.error("Seller payout result requires manual Paystack reconciliation.", {
        sellerId: payout.sellerId,
        orderId,
        transferReference: payout.transferReference,
        error,
      });
    }
  }
}

export async function processAllPendingSellerPayouts(): Promise<void> {
  const orders = await prisma.sellerPayout.findMany({
    where: { status: "PENDING" },
    distinct: ["orderId"],
    select: { orderId: true },
  });
  for (const { orderId } of orders) {
    try {
      await processPendingSellerPayouts(orderId);
    } catch (error) {
      console.error("Pending seller payouts could not be processed.", { orderId, error });
    }
  }
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
