import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.use("/payments", requireSupabaseUser, requireConfirmedEmail);

router.post("/payments/initialize", async (request, response) => {
  const buyer = (request as AuthenticatedRequest).marketplaceUser;
  if (!buyer) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  const cartItems = await prisma.cartItem.findMany({
    where: { userId: buyer.id },
    include: {
      post: {
        select: {
          price: true,
          quantityAvailable: true,
          sellerId: true,
          status: true,
          auctionRoom: { select: { status: true } },
        },
      },
    },
  });
  if (cartItems.length === 0) {
    response.status(400).json({ error: "Your cart is empty." });
    return;
  }

  const unavailableItem = cartItems.some(({ post, quantity }) =>
    post.status !== "ACTIVE" || post.sellerId === buyer.id || post.quantityAvailable < quantity ||
    (post.auctionRoom !== null && post.auctionRoom.status !== "CLOSED")
  );
  if (unavailableItem) {
    response.status(409).json({ error: "A cart item is no longer available. Refresh your cart and try again." });
    return;
  }

  const amountCents = cartItems.reduce((total, { post, quantity }) => total + Math.round(post.price * 100) * quantity, 0);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    response.status(409).json({ error: "The cart total is invalid." });
    return;
  }

  const paystackEmail = buyer.email;
  if (!paystackEmail) {
    response.status(400).json({ error: "A valid email is required to initialize payment." });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  const reference = `QR-${randomUUID()}`;
  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: paystackEmail,
        amount: amountCents,
        currency: "NGN",
        reference,
        metadata: {
          userId: buyer.id,
          cartSubtotalCents: amountCents,
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
    if (!data?.authorization_url || !data?.reference) {
      response.status(502).json({ error: "Payment gateway initialization failed." });
      return;
    }

    response.json({
      status: "success",
      authorization_url: data.authorization_url,
      access_code: data.access_code,
      reference: data.reference,
      amountCents,
    });
  } catch (error: unknown) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Failed to initialize Paystack payment.";
    response.status(500).json({ error: message });
  }
});

router.get("/payments/verify/:reference", async (request, response) => {
    const buyer = (request as AuthenticatedRequest).marketplaceUser;
    if (!buyer) {
      response.status(401).json({ error: "Unauthorized." });
      return;
    }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  const reference = request.params.reference;
  if (!reference) {
    response.status(400).json({ error: "reference is required." });
    return;
  }

  try {
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );

    const data = paystackResponse.data?.data;
    if (!data) {
      response.status(400).json({ error: "Transaction could not be verified." });
      return;
    }

    if (data.status !== "success" || data.reference !== reference || data.currency !== "NGN" || data.metadata?.userId !== buyer.id) {
      response.status(400).json({ error: "Payment could not be verified for this account." });
      return;
    }

    response.json({
      verified: true,
      status: data.status,
      reference: data.reference,
      amount: data.amount / 100,
      currency: data.currency,
      metadata: data.metadata ?? {},
    });
  } catch (error: unknown) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Failed to verify Paystack payment.";
    response.status(500).json({ error: message });
  }
});

export default router;
