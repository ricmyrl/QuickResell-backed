import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { ngnKoboToUsdCents } from "../services/exchangeRates.js";
import { getPaystackCallbackUrl, getPaystackSecretKey } from "../services/paystack.js";
import { finalizeWalletTopUp, WalletPaymentError } from "../services/walletPayments.js";

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
          THEN item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint
          ELSE 0
        END), 0)::bigint AS "readyForCashoutCents",
        COALESCE(SUM(CASE
          WHEN payout."status" = 'SUCCESS' AND payout."orderItemId" IS NOT NULL
          THEN item."quantity"::bigint * item."unitPriceCents"::bigint - item."sellerFeeCents"::bigint
          ELSE 0
        END), 0)::bigint AS "paidOutCents"
      FROM "PurchaseOrderItem" item
      INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
      LEFT JOIN "SellerPayout" payout ON payout."orderItemId" = item."id"
      WHERE item."sellerId" = ${user.id}::uuid
        AND orders."paymentReference" IS NOT NULL
        AND orders."status" <> 'CANCELLED'
    `,
  ]);
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
    sellerEarnings: {
      earnedCents: cents(earningsSummary.earnedCents),
      pendingFulfillmentCents: cents(earningsSummary.pendingFulfillmentCents),
      readyForCashoutCents: cents(earningsSummary.readyForCashoutCents),
      paidOutCents: cents(earningsSummary.paidOutCents),
      payoutAccountVerified: payoutAccount?.payoutStatus === "VERIFIED"
        && Boolean(payoutAccount.bankAccountNumber)
        && Boolean(payoutAccount.bankAccountName)
        && Boolean(payoutAccount.paystackRecipientCode),
      payouts: paidOrderItems.map((item) => ({
        id: item.sellerPayout?.id ?? item.id,
        orderId: item.orderId,
        orderItemId: item.id,
        title: item.title,
        amountUsdCents: item.quantity * item.unitPriceCents - item.sellerFeeCents,
        status: item.sellerPayout?.status ?? "NOT_TRACKED",
        fulfillmentStatus: item.fulfillmentStatus,
        createdAt: item.createdAt,
      })),
    },
  });
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

  let walletAmountCents: number;
  try {
    walletAmountCents = await ngnKoboToUsdCents(amountKobo);
  } catch {
    response.status(503).json({ error: "Payment is temporarily unavailable because exchange rates could not be loaded." });
    return;
  }
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
          amountUsdCents: walletAmountCents,
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
