import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { usdToNgnKobo } from "../services/exchangeRates.js";

const router = Router();

type PaystackVerification = {
  data?: {
    status?: unknown;
    reference?: unknown;
    currency?: unknown;
    amount?: unknown;
    metadata?: Record<string, unknown>;
  };
};

router.use("/wallet", requireSupabaseUser, requireConfirmedEmail);

router.get("/wallet", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const wallet = await prisma.wallet.findUnique({
    where: { userId: user.id },
    include: {
      transactions: {
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, amountCents: true, paymentReference: true, createdAt: true },
      },
    },
  });

  response.json({
    balanceCents: wallet?.balanceCents ?? 0,
    transactions: wallet?.transactions ?? [],
  });
});

router.post("/wallet/topups/initialize", async (request, response) => {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const amountCents = request.body?.amountCents;
  if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 2_147_483_647) {
    response.status(400).json({ error: "Enter a wallet deposit of at least $1.00 with no more than two decimal places." });
    return;
  }
  if (!user.email) {
    response.status(400).json({ error: "A valid email is required to initialize payment." });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  let paymentAmountKobo: number;
  try {
    paymentAmountKobo = await usdToNgnKobo(amountCents / 100);
  } catch {
    response.status(503).json({ error: "Payment is temporarily unavailable because exchange rates could not be loaded." });
    return;
  }
  if (paymentAmountKobo > 2_147_483_647) {
    response.status(400).json({ error: "This deposit amount is above the payment gateway limit." });
    return;
  }

  const wallet = await prisma.wallet.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
    select: { id: true, balanceCents: true },
  });
  if (wallet.balanceCents + amountCents > 2_147_483_647) {
    response.status(400).json({ error: "This deposit would exceed your wallet's maximum balance." });
    return;
  }

  const reference = `QR-WALLET-${randomUUID()}`;
  const transaction = await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      paymentReference: reference,
      amountCents,
      paymentAmountKobo,
    },
    select: { id: true },
  });

  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: user.email,
        amount: paymentAmountKobo,
        currency: "NGN",
        reference,
        metadata: {
          transactionType: "WALLET_TOPUP",
          walletTransactionId: transaction.id,
          userId: user.id,
          amountUsdCents: amountCents,
          paymentAmountKobo,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
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
      amountCents: paymentAmountKobo,
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

  const transaction = await prisma.walletTransaction.findFirst({
    where: { paymentReference: reference, wallet: { userId: user.id } },
    include: { wallet: { select: { id: true } } },
  });
  if (!transaction || transaction.status === "FAILED") {
    response.status(404).json({ error: "This wallet deposit could not be found." });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  let paymentData: PaystackVerification["data"];
  try {
    const paystackResponse = await axios.get<PaystackVerification>(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    paymentData = paystackResponse.data?.data;
  } catch (error: unknown) {
    const message = axios.isAxiosError(error)
      ? error.response?.data?.message ?? error.message
      : "Failed to verify Paystack payment.";
    response.status(502).json({ error: message });
    return;
  }

  if (
    paymentData?.status !== "success"
    || paymentData.reference !== reference
    || paymentData.currency !== "NGN"
    || paymentData.amount !== transaction.paymentAmountKobo
    || paymentData.metadata?.transactionType !== "WALLET_TOPUP"
    || paymentData.metadata?.walletTransactionId !== transaction.id
    || paymentData.metadata?.userId !== user.id
    || paymentData.metadata?.amountUsdCents !== transaction.amountCents
  ) {
    response.status(400).json({ error: "Payment could not be verified for this wallet deposit." });
    return;
  }

  const wallet = await prisma.$transaction(async (database) => {
    const updated = await database.walletTransaction.updateMany({
      where: { id: transaction.id, status: "PENDING" },
      data: { status: "COMPLETED" },
    });
    if (updated.count === 1) {
      await database.wallet.update({
        where: { id: transaction.walletId },
        data: { balanceCents: { increment: transaction.amountCents } },
      });
    }
    return database.wallet.findUniqueOrThrow({
      where: { id: transaction.walletId },
      select: { balanceCents: true },
    });
  });

  response.json({
    verified: true,
    reference,
    balanceCents: wallet.balanceCents,
  });
});

export default router;
