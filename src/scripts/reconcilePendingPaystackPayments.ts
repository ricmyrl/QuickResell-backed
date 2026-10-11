import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma.js";
import { finalizeCartCheckout } from "../services/cartCheckout.js";
import { verifyPaystackTransaction } from "../services/paystack.js";
import { finalizeWalletTopUp } from "../services/walletPayments.js";

type ReconciliationEntry = {
  type: "order" | "checkout" | "wallet";
  reference: string;
  buyerId?: string;
  userId?: string;
};

export async function reconcilePendingPaystackReferences(): Promise<{ processed: number; verified: number; skipped: number }> {
  const queue = new Map<string, ReconciliationEntry>();

  const walletTransactions = await prisma.walletTransaction.findMany({
    where: { status: "PENDING" },
    select: {
      paymentReference: true,
      wallet: { select: { userId: true } },
    },
  });

  for (const transaction of walletTransactions) {
    if (!transaction.paymentReference) continue;
    queue.set(transaction.paymentReference, {
      type: "wallet",
      reference: transaction.paymentReference,
      userId: transaction.wallet.userId,
    });
  }

  const pendingCheckouts = await prisma.paystackCheckout.findMany({
    where: { status: "PENDING" },
    select: {
      buyerId: true,
      reference: true,
    },
  });

  for (const checkout of pendingCheckouts) {
    if (queue.has(checkout.reference)) continue;
    queue.set(checkout.reference, {
      type: "checkout",
      reference: checkout.reference,
      buyerId: checkout.buyerId,
    });
  }

  const activeOrders = await prisma.purchaseOrder.findMany({
    where: { paymentReference: { not: null } },
    select: {
      buyerId: true,
      paymentReference: true,
      status: true,
    },
  });

  for (const order of activeOrders) {
    if (!order.paymentReference) continue;
    if (queue.has(order.paymentReference)) continue;
    queue.set(order.paymentReference, {
      type: "order",
      reference: order.paymentReference,
      buyerId: order.buyerId,
    });
  }

  const entries = [...queue.values()];
  console.log(`Checking ${entries.length} stored Paystack references...`);

  let processed = 0;
  let verified = 0;
  let skipped = 0;

  for (const entry of entries) {
    try {
      const payment = await verifyPaystackTransaction(entry.reference);
      if (payment.status !== "success" || payment.reference !== entry.reference || payment.currency !== "NGN") {
        console.log(`Skipping not-successful reference ${entry.reference}`);
        processed += 1;
        skipped += 1;
        continue;
      }

      if (entry.type === "wallet") {
        if (!entry.userId) {
          console.warn(`Missing userId for wallet reference ${entry.reference}`);
          processed += 1;
          skipped += 1;
          continue;
        }
        await finalizeWalletTopUp(entry.reference, entry.userId);
      } else {
        if (!entry.buyerId) {
          console.warn(`Missing buyerId for order reference ${entry.reference}`);
          processed += 1;
          skipped += 1;
          continue;
        }
        await finalizeCartCheckout(entry.reference, entry.buyerId);
      }

      processed += 1;
      verified += 1;
      console.log(`Verified and applied ${entry.reference}`);
    } catch (error) {
      processed += 1;
      skipped += 1;
      console.warn(`Reference ${entry.reference} could not be reconciled:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`Batch reconciliation complete. Verified: ${verified}, skipped: ${skipped}.`);
  return { processed, verified, skipped };
}

async function main() {
  await reconcilePendingPaystackReferences();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Batch Paystack reconciliation failed:", error);
    process.exitCode = 1;
  });
}
