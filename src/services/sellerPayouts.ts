import { prisma } from "../lib/prisma.js";
import { getExchangeRates } from "./exchangeRates.js";
import { convertUsdToPayoutKobo, initiateSellerPayout } from "./paystack.js";

function statusFromPaystack(status: string | undefined): "PROCESSING" | "SUCCESS" | "FAILED" | "REVIEW_REQUIRED" {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  if (status === "otp") return "REVIEW_REQUIRED";
  return "PROCESSING";
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
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: { status: "BLOCKED", failureReason: "PAYOUT_DETAILS_OR_AMOUNT_INVALID" },
      });
      continue;
    }

    const amountKobo = convertUsdToPayoutKobo(payout.amountUsdCents / 100, payoutRate.rates.NGN);
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: { status: "BLOCKED", failureReason: "CONVERTED_PAYOUT_AMOUNT_INVALID" },
      });
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
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: {
          status,
          transferCode: transfer.transfer_code ?? null,
          completedAt: status === "SUCCESS" ? new Date() : null,
          failureReason: status === "FAILED" ? "PAYSTACK_TRANSFER_FAILED" : null,
        },
      });
    } catch (error) {
      await prisma.sellerPayout.update({
        where: { id: payout.id },
        data: {
          status: "REVIEW_REQUIRED",
          failureReason: "PAYSTACK_RESULT_REQUIRES_RECONCILIATION",
        },
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
    select: { id: true },
  });
  if (!existing) return false;

  const where = status === "SUCCESS"
    ? { transferReference: reference, status: { notIn: ["FAILED" as const, "REVERSED" as const] } }
    : status === "FAILED"
      ? { transferReference: reference, status: { notIn: ["SUCCESS" as const, "REVERSED" as const] } }
      : status === "PROCESSING"
        ? { transferReference: reference, status: { in: ["PENDING" as const, "PROCESSING" as const, "REVIEW_REQUIRED" as const] } }
        : { transferReference: reference };
  await prisma.sellerPayout.updateMany({
    where: { ...where, id: existing.id },
    data: {
      status,
      ...(transferCode ? { transferCode } : {}),
      completedAt: status === "SUCCESS" || status === "FAILED" || status === "REVERSED" ? new Date() : null,
      failureReason: status === "FAILED" ? "PAYSTACK_TRANSFER_FAILED" : null,
    },
  });
  return true;
}
