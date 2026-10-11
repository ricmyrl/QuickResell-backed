import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requirePasskeyVerification, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { getPaystackCallbackUrl, getPaystackSecretKey } from "../services/paystack.js";
import { finalizeWalletTopUp, WalletPaymentError } from "../services/walletPayments.js";
import { reconcileSellerWithdrawal, SellerWithdrawalError, withdrawSellerEarnings } from "../services/sellerWithdrawals.js";

const router = Router();

router.use("/wallet", requireSupabaseUser, requireConfirmedEmail);

router.get("/wallet", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const paidOrderFilter = {
    sellerId: user.id,
    order: { is: { paymentReference: { not: null }, status: { not: "CANCELLED" as const } } },
  };
  const paidOrderItems = await prisma.purchaseOrderItem.findMany({
    where: paidOrderFilter,
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      orderId: true,
      title: true,
      quantity: true,
      unitPriceCents: true,
      sellerFeeCents: true,
      fulfillmentStatus: true,
      createdAt: true,
      sellerPayout: { select: { id: true, status: true } },
    },
  });
  const [
    wallet,
    payoutAccount,
    earnings,
    withdrawals,
  ] = await Promise.all([
    prisma.wallet.findUnique({
      where: { userId: user.id },
      include: {
        transactions: {
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            amountCents: true,
            paymentReference: true,
            createdAt: true,
            type: true,
            direction: true,
            orderItem: { select: { title: true } },
          },
        },
      },
    }),
    prisma.sellerVerification.findUnique({
      where: { userId: user.id },
      select: {
        payoutStatus: true,
        bankAccountNumber: true,
        bankAccountName: true,
        paystackRecipientCode: true,
      },
    }),
    prisma.$queryRaw<Array<{
      earnedCents: bigint;
      pendingFulfillmentCents: bigint;
      readyForCashoutCents: bigint;
      paidOutCents: bigint;
      legacyReconciliationCents: bigint;
    }>>`
      SELECT
        COALESCE(SUM(item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint), 0)::bigint AS "earnedCents",
        COALESCE(SUM(CASE
          WHEN item."fulfillmentStatus" = 'PENDING_HANDOFF'
          THEN item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint
          ELSE 0
        END), 0)::bigint AS "pendingFulfillmentCents",
        COALESCE(SUM(CASE
          WHEN payout."status" IN ('PENDING', 'BLOCKED')
            AND item."fulfillmentStatus" IN ('READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
            AND payout."orderItemId" IS NOT NULL
          THEN GREATEST(
            item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint
            - COALESCE((
              SELECT SUM(allocation."amountCents"::bigint)
              FROM "SellerWithdrawalAllocation" allocation
              INNER JOIN "SellerWithdrawal" withdrawal ON withdrawal."id" = allocation."withdrawalId"
              WHERE allocation."sellerPayoutId" = payout."id"
                AND withdrawal."status" IN ('PROCESSING', 'SUCCESS', 'REVIEW_REQUIRED')
            ), 0),
            0
          )
          ELSE 0
        END), 0)::bigint AS "readyForCashoutCents",
        COALESCE(SUM(CASE
          WHEN payout."status" = 'SUCCESS' AND payout."orderItemId" IS NOT NULL
          THEN item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint
          ELSE 0
        END), 0)::bigint
        + COALESCE((
          SELECT SUM(allocation."amountCents"::bigint)
          FROM "SellerWithdrawalAllocation" allocation
          INNER JOIN "SellerWithdrawal" withdrawal ON withdrawal."id" = allocation."withdrawalId"
          INNER JOIN "SellerPayout" allocated_payout ON allocated_payout."id" = allocation."sellerPayoutId"
          INNER JOIN "PurchaseOrderItem" allocated_item ON allocated_item."id" = allocated_payout."orderItemId"
          INNER JOIN "PurchaseOrder" allocated_order ON allocated_order."id" = allocated_item."orderId"
          WHERE allocated_payout."sellerId" = ${user.id}::uuid
            AND withdrawal."status" = 'SUCCESS'
            AND allocated_order."paymentReference" IS NOT NULL
            AND allocated_order."status" <> 'CANCELLED'
        ), 0)::bigint AS "paidOutCents",
        COALESCE(SUM(CASE
          WHEN payout."id" IS NULL
            AND item."fulfillmentStatus" IN ('READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED')
          THEN GREATEST(
            item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint,
            0
          )
          ELSE 0
        END), 0)::bigint AS "legacyReconciliationCents"
      FROM "PurchaseOrderItem" item
      INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
      LEFT JOIN "SellerPayout" payout ON payout."orderItemId" = item."id"
      WHERE item."sellerId" = ${user.id}::uuid
        AND orders."paymentReference" IS NOT NULL
        AND orders."status" <> 'CANCELLED'
    `,
    prisma.sellerWithdrawal.findMany({
      where: { sellerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, amountKobo: true, transferReference: true, status: true, createdAt: true, updatedAt: true },
    }),
  ]);
  const payoutIds = paidOrderItems.flatMap((item) => item.sellerPayout ? [item.sellerPayout.id] : []);
  const withdrawalAllocations = payoutIds.length > 0
    ? await prisma.sellerWithdrawalAllocation.findMany({
      where: {
        sellerPayoutId: { in: payoutIds },
        withdrawal: { status: { in: ["PROCESSING", "SUCCESS", "REVIEW_REQUIRED"] } },
      },
      select: { sellerPayoutId: true, amountCents: true },
    })
    : [];
  const withdrawnByPayout = new Map<string, number>();
  for (const allocation of withdrawalAllocations) {
    withdrawnByPayout.set(
      allocation.sellerPayoutId,
      (withdrawnByPayout.get(allocation.sellerPayoutId) ?? 0) + allocation.amountCents,
    );
  }
  const earningsSummary = earnings[0];
  if (!earningsSummary) throw new Error("Seller earnings could not be summarized.");
  const cents = (value: bigint): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new Error("Seller earnings exceed the supported wallet balance range.");
    return result;
  };

  response.json({
    balanceCents: wallet?.balanceCents ?? 0,
    transactions: wallet?.transactions ?? [],
    withdrawals,
    sellerEarnings: {
      earnedCents: cents(earningsSummary.earnedCents),
      pendingFulfillmentCents: cents(earningsSummary.pendingFulfillmentCents),
      readyForCashoutCents: cents(earningsSummary.readyForCashoutCents),
      paidOutCents: cents(earningsSummary.paidOutCents),
      legacyReconciliationCents: cents(earningsSummary.legacyReconciliationCents),
      payoutAccountVerified: payoutAccount?.payoutStatus === "VERIFIED"
        && Boolean(payoutAccount.bankAccountNumber)
        && Boolean(payoutAccount.bankAccountName)
        && Boolean(payoutAccount.paystackRecipientCode),
      payouts: paidOrderItems.map((item) => ({
        id: item.sellerPayout?.id ?? item.id,
        orderId: item.orderId,
        orderItemId: item.id,
        title: item.title,
        amountCents: item.quantity * item.unitPriceCents - item.sellerFeeCents,
        status: item.sellerPayout?.status ?? "NOT_TRACKED",
        fulfillmentStatus: item.fulfillmentStatus,
        createdAt: item.createdAt,
        withdrawnCents: item.sellerPayout ? withdrawnByPayout.get(item.sellerPayout.id) ?? 0 : 0,
      })),
    },
  });
});

router.post("/wallet/withdrawals", requirePasskeyVerification, async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }
  const amountKobo = request.body?.amountKobo;
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0 || amountKobo > 2_147_483_647) {
    response.status(400).json({ error: "Enter a valid withdrawal amount in naira with up to two decimal places." });
    return;
  }

  try {
    const withdrawal = await withdrawSellerEarnings(user.id, amountKobo);
    response.json({ withdrawal });
  } catch (error) {
    if (error instanceof SellerWithdrawalError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/wallet/withdrawals/:withdrawalId/reconcile", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }
  const withdrawalId = request.params.withdrawalId;
  if (typeof withdrawalId !== "string" || !withdrawalId.trim()) {
    response.status(400).json({ error: "A valid withdrawal ID is required." });
    return;
  }
  try {
    const withdrawal = await reconcileSellerWithdrawal(withdrawalId, user.id);
    response.json({ withdrawal });
  } catch (error) {
    if (error instanceof SellerWithdrawalError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/wallet/topups/initialize", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const amountKobo = request.body?.amountKobo;
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 100 || amountKobo > 2_147_483_647) {
    response.status(400).json({ error: "Enter a wallet deposit of at least ₦1.00 with no more than two decimal places." });
    return;
  }
  if (!user.email) {
    response.status(400).json({ error: "A valid email is required to initialize payment." });
    return;
  }

  let secretKey: string;
  try {
    secretKey = getPaystackSecretKey();
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Paystack is not configured." });
    return;
  }

  const walletAmountCents = amountKobo;
  if (walletAmountCents < 100) {
    response.status(400).json({ error: "This deposit is below the minimum wallet credit. Enter a larger amount in naira." });
    return;
  }
  if (walletAmountCents > 2_147_483_647) {
    response.status(400).json({ error: "This deposit exceeds the supported wallet balance limit." });
    return;
  }

  const wallet = await prisma.wallet.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
    select: { id: true, balanceCents: true },
  });
  if (wallet.balanceCents + walletAmountCents > 2_147_483_647) {
    response.status(400).json({ error: "This deposit would exceed your wallet's maximum balance." });
    return;
  }

  const reference = `QR-WALLET-${randomUUID()}`;
  const transaction = await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      paymentReference: reference,
      amountCents: walletAmountCents,
      paymentAmountKobo: amountKobo,
    },
    select: { id: true },
  });

  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: amountKobo,
        currency: "NGN",
        reference,
        callback_url: getPaystackCallbackUrl("WALLET_TOPUP"),
        metadata: {
          transactionType: "WALLET_TOPUP",
          walletTransactionId: transaction.id,
          userId: user.id,
          amountKobo,
          paymentAmountKobo: amountKobo,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      },
    );

    const data = paystackResponse.data?.data;
    if (!data?.authorization_url || data.reference !== reference) {
      await prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED" },
      });
      response.status(502).json({ error: "Payment gateway initialization failed." });
      return;
    }

    response.json({
      status: "success",
      authorization_url: data.authorization_url,
      access_code: data.access_code,
      reference,
      amountKobo,
      currency: "NGN",
    });
  } catch (error: unknown) {
    await prisma.walletTransaction.update({
      where: { id: transaction.id },
      data: { status: "FAILED" },
    });
    const message = axios.isAxiosError(error)
      ? error.response?.data?.message ?? error.message
      : "Failed to initialize Paystack payment.";
    response.status(502).json({ error: message });
  }
});

router.post("/wallet/topups/verify/:reference", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const reference = request.params.reference;
  if (!reference) {
    response.status(400).json({ error: "reference is required." });
    return;
  }

  try {
    const balanceCents = await finalizeWalletTopUp(reference, user.id);
    response.json({ verified: true, reference, balanceCents });
  } catch (error) {
    if (error instanceof WalletPaymentError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;
