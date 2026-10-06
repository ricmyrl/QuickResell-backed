import express, { Router } from "express";
import { CartPaymentError, finalizeCartCheckout } from "../services/cartCheckout.js";
import { getPaystackSecretKey, verifyPaystackWebhookSignature } from "../services/paystack.js";
import { finalizeWalletTopUp, WalletPaymentError } from "../services/walletPayments.js";

const router = Router();

router.post("/paystack/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (request, response) => {
  let secretKey: string;
  try {
    secretKey = getPaystackSecretKey();
  } catch (error) {
    console.error("Paystack webhook cannot run because live payment credentials are unavailable.", error);
    response.status(503).json({ error: "Payment webhook is not configured." });
    return;
  }

  const rawBody = request.body;
  const signature = request.header("x-paystack-signature");
  if (!Buffer.isBuffer(rawBody) || !verifyPaystackWebhookSignature(rawBody, signature, secretKey)) {
    response.status(401).json({ error: "Invalid Paystack webhook signature." });
    return;
  }

  let event: {
    event?: unknown
    data?: {
      status?: unknown
      reference?: unknown
      metadata?: Record<string, unknown>
    }
  }
  try {
    event = JSON.parse(rawBody.toString("utf8")) as typeof event;
  } catch {
    response.status(400).json({ error: "Invalid Paystack webhook payload." });
    return;
  }

  if (event.event !== "charge.success" || event.data?.status !== "success") {
    response.status(200).json({ received: true });
    return;
  }

  const reference = event.data.reference;
  const metadata = event.data.metadata;
  const userId = metadata?.userId;
  const transactionType = metadata?.transactionType;
  if (typeof reference !== "string" || typeof userId !== "string") {
    console.error("Paystack sent a successful charge without required payment metadata.", { reference, transactionType });
    response.status(200).json({ received: true, requiresReview: true });
    return;
  }

  try {
    if (transactionType === "CART_CHECKOUT") {
      const order = await finalizeCartCheckout(reference, userId);
      if (!order) throw new CartPaymentError("Paid checkout could not be matched to payable cart items.", 409);
    } else if (transactionType === "WALLET_TOPUP") {
      await finalizeWalletTopUp(reference, userId);
    } else {
      console.error("Paystack charge has an unknown transaction type and needs review.", { reference, transactionType });
      response.status(200).json({ received: true, requiresReview: true });
      return;
    }
  } catch (error) {
    console.error("Paystack charge could not be finalized automatically.", { reference, transactionType, error });
    if ((error instanceof CartPaymentError || error instanceof WalletPaymentError) && error.status < 500) {
      response.status(200).json({ received: true, requiresReview: true });
      return;
    }
    response.status(500).json({ error: "Payment finalization will be retried." });
    return;
  }

  response.status(200).json({ received: true });
});

export default router;