import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requirePasskeyVerification, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { usdToNgnKobo } from "../services/exchangeRates.js";
import { getPaystackCallbackUrl, getPaystackSecretKey, verifyPaystackTransaction } from "../services/paystack.js";
import { auctionPaymentGraceMs } from "../services/auctionPaymentPolicy.js";

const router = Router();

router.use("/payments", requireSupabaseUser, requireConfirmedEmail);

router.post("/payments/initialize", requirePasskeyVerification, async (request, response) => {
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
          auctionRoom: {
            select: {
              id: true,
              status: true,
              highestBidderId: true,
              currentHighestBid: true,
              paymentDueAt: true,
              paymentGraceUntil: true,
              paymentGraceUsed: true,
              buyerDefaultedAt: true,
            },
          },
        },
      },
    },
  });
  if (cartItems.length === 0) {
    response.status(400).json({ error: "Your cart is empty." });
    return;
  }

  const eligibleItems = cartItems.filter((item) => {
    if (item.auctionRoomId) {
      return item.post.auctionRoom?.id === item.auctionRoomId
        && item.post.auctionRoom.status === "SOLD"
        && item.post.auctionRoom.highestBidderId === buyer.id;
    }
    return true;
  });
  if (eligibleItems.some((item) => item.auctionRoomId && item.post.auctionRoom?.highestBidderId !== buyer.id)) {
    response.status(409).json({ error: "An auction result changed. Refresh your cart and try again." });
    return;
  }
  const paymentCheckedAt = new Date();
  const overdueAuction = eligibleItems.find((item) => {
    if (!item.auctionRoomId || !item.post.auctionRoom) return false;
    const room = item.post.auctionRoom;
    return room.buyerDefaultedAt !== null
      || !room.paymentDueAt
      || (paymentCheckedAt > room.paymentDueAt
        && (!room.paymentGraceUntil || paymentCheckedAt > room.paymentGraceUntil));
  });
  if (overdueAuction) {
    response.status(409).json({ error: "The payment deadline for an auction item has passed. Remove it from your cart and refresh." });
    return;
  }
  const unavailableItem = eligibleItems.some(({ post, quantity, auctionRoomId }) =>
    !auctionRoomId && (post.status !== "ACTIVE" || post.sellerId === buyer.id || post.quantityAvailable < quantity ||
      (post.auctionRoom !== null && post.auctionRoom.status !== "CLOSED"))
  );
  if (unavailableItem) {
    response.status(409).json({ error: "A cart item is no longer available. Refresh your cart and try again." });
    return;
  }

  if (eligibleItems.length === 0) {
    response.status(409).json({ error: "No items are ready for checkout. Auction items unlock after the seller confirms your win." });
    return;
  }
  if (eligibleItems.length > 100) {
    response.status(400).json({ error: "Checkout supports up to 100 cart items at a time. Remove some items and try again." });
    return;
  }

  const subtotalUsd = eligibleItems.reduce((total, item) => {
    const unitPriceCents = Math.round((item.auctionRoomId && item.post.auctionRoom
      ? item.post.auctionRoom.currentHighestBid
      : item.post.price) * 100);
    return total + unitPriceCents * item.quantity;
  }, 0) / 100;
  if (!Number.isFinite(subtotalUsd) || subtotalUsd <= 0) {
    response.status(409).json({ error: "The cart total is invalid." });
    return;
  }

  let amountCents: number;
  try {
    amountCents = await usdToNgnKobo(subtotalUsd);
  } catch {
    response.status(503).json({ error: "Payment is temporarily unavailable because exchange rates could not be loaded." });
    return;
  }

  const paystackEmail = buyer.email;
  if (!paystackEmail) {
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

  const reference = `QR-${randomUUID()}`;
  const paymentInitializationStartedAt = new Date();
  try {
    await prisma.$transaction(async (transaction) => {
      for (const item of eligibleItems) {
        if (!item.auctionRoomId) continue;
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "AuctionRoom" WHERE "id" = ${item.auctionRoomId} FOR UPDATE
        `;
        if (!locked.length) throw new Error("An auction item changed before payment could start.");
        const room = await transaction.auctionRoom.findUniqueOrThrow({
          where: { id: item.auctionRoomId },
          select: {
            status: true,
            highestBidderId: true,
            paymentDueAt: true,
            paymentGraceUntil: true,
            paymentGraceUsed: true,
            buyerDefaultedAt: true,
          },
        });
        if (room.status !== "SOLD" || room.highestBidderId !== buyer.id || room.buyerDefaultedAt || !room.paymentDueAt) {
          throw new Error("The auction result is no longer payable.");
        }
        if (paymentInitializationStartedAt <= room.paymentDueAt && !room.paymentGraceUsed) {
          await transaction.auctionRoom.update({
            where: { id: item.auctionRoomId },
            data: {
              paymentGraceUsed: true,
              paymentGraceUntil: new Date(room.paymentDueAt.getTime() + auctionPaymentGraceMs),
            },
          });
        } else if (
          paymentInitializationStartedAt > room.paymentDueAt
          && (!room.paymentGraceUntil || paymentInitializationStartedAt > room.paymentGraceUntil)
        ) {
          throw new Error("The payment deadline for an auction item has passed.");
        }
      }
    });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "The auction item is no longer payable." });
    return;
  }

  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: paystackEmail,
        amount: amountCents,
        currency: "NGN",
        reference,
        callback_url: getPaystackCallbackUrl("CART_CHECKOUT"),
        metadata: {
          transactionType: "CART_CHECKOUT",
          userId: buyer.id,
          subtotalUsdCents: Math.round(subtotalUsd * 100),
          paymentAmountKobo: amountCents,
          cartItemIds: eligibleItems.map((item) => item.id),
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
      response.status(502).json({ error: "Payment gateway initialization failed." });
      return;
    }

    response.json({
      status: "success",
      authorization_url: data.authorization_url,
      access_code: data.access_code,
      reference: data.reference,
      amountCents,
      currency: "NGN",
    });
  } catch (error: unknown) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Failed to initialize Paystack payment.";
    response.status(502).json({ error: message });
  }
});

router.get("/payments/verify/:reference", async (request, response) => {
    const buyer = (request as AuthenticatedRequest).marketplaceUser;
    if (!buyer) {
      response.status(401).json({ error: "Unauthorized." });
      return;
    }

  const reference = request.params.reference;
  if (!reference) {
    response.status(400).json({ error: "reference is required." });
    return;
  }

  try {
    const data = await verifyPaystackTransaction(reference);
    if (data.status !== "success"
      || data.reference !== reference
      || data.currency !== "NGN"
      || data.metadata?.transactionType !== "CART_CHECKOUT"
      || data.metadata?.userId !== buyer.id
      || data.amount !== Number(data.metadata?.paymentAmountKobo)) {
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
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : error instanceof Error ? error.message : "Failed to verify Paystack payment.";
    response.status(502).json({ error: message });
  }
});

export default router;
