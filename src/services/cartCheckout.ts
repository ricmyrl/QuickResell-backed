import { randomUUID } from "node:crypto";
import type { Post } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { verifyPaystackTransaction } from "./paystack.js";
import { isAuctionPaymentOnTime } from "./auctionPaymentPolicy.js";
import { processPendingSellerPayouts } from "./sellerPayouts.js";

export class CartPaymentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CartPaymentError";
  }
}

type VerifiedCartPayment = { subtotalUsdCents: number; cartItemIds: string[]; paidAt: Date | null };

export async function verifyCartPayment(reference: string, buyerId: string): Promise<VerifiedCartPayment> {
  let transaction;
  try {
    transaction = await verifyPaystackTransaction(reference);
  } catch {
    throw new CartPaymentError("Paystack verification is temporarily unavailable.", 502);
  }

  if (transaction.status !== "success"
    || transaction.reference !== reference
    || transaction.currency !== "NGN"
    || transaction.metadata?.userId !== buyerId
    || transaction.metadata?.transactionType !== "CART_CHECKOUT") {
    throw new CartPaymentError("Payment verification failed or the transaction is not complete.", 402);
  }

  const subtotalUsdCents = Number(transaction.metadata.subtotalUsdCents);
  const cartItemIds: unknown = transaction.metadata.cartItemIds;
  const paymentAmountKobo = Number(transaction.metadata.paymentAmountKobo);
  if (!Number.isSafeInteger(subtotalUsdCents)
    || subtotalUsdCents <= 0
    || !Array.isArray(cartItemIds)
    || cartItemIds.length === 0
    || cartItemIds.length > 100
    || !cartItemIds.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
    || new Set(cartItemIds).size !== cartItemIds.length
    || !Number.isSafeInteger(paymentAmountKobo)
    || transaction.amount !== paymentAmountKobo) {
    throw new CartPaymentError("The payment amount does not match the checkout total.", 402);
  }

  const paidAtValue = transaction.paid_at;
  const paidAt = typeof paidAtValue === "string" ? new Date(paidAtValue) : null;
  return {
    subtotalUsdCents,
    cartItemIds,
    paidAt: paidAt && Number.isFinite(paidAt.getTime()) ? paidAt : null,
  };
}

function isAvailable(post: Post & { auctionRoom?: { status: string } | null }, userId: string, quantity: number): boolean {
  const roomUnavailable = post.auctionRoom && post.auctionRoom.status !== "CLOSED";
  return post.status === "ACTIVE" && post.sellerId !== userId && !roomUnavailable && post.quantityAvailable >= quantity;
}

function isAuctionCartItemAvailable(
  item: { auctionRoomId: string | null; post: { auctionRoom?: { id: string; status: string; highestBidderId: string | null } | null } },
  userId: string,
): boolean {
  const room = item.post.auctionRoom;
  return Boolean(item.auctionRoomId && room
    && item.auctionRoomId === room.id
    && room.status === "SOLD"
    && room.highestBidderId === userId);
}

export async function finalizeCartCheckout(reference: string, buyerId: string) {
  const verifiedPayment = await verifyCartPayment(reference, buyerId);

  const order = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${buyerId}::uuid FOR UPDATE
    `;
    const existingOrder = await transaction.purchaseOrder.findUnique({
      where: { paymentReference: reference },
      include: { items: true },
    });
    if (existingOrder) {
      if (existingOrder.buyerId !== buyerId) throw new CartPaymentError("This payment reference belongs to another account.", 409);
      return existingOrder;
    }

    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "CartItem" WHERE "userId" = ${buyerId}::uuid ORDER BY "postId" FOR UPDATE
    `;
    const cartItems = await transaction.cartItem.findMany({
      where: { userId: buyerId },
      orderBy: { postId: "asc" },
    });
    if (cartItems.length === 0) return null;
    const payableCartItemIds = new Set(verifiedPayment.cartItemIds);
    if (verifiedPayment.cartItemIds.some((id) => !cartItems.some((item) => item.id === id))) {
      throw new CartPaymentError("Your cart changed after payment started. Contact support with your payment reference.", 409);
    }

    const purchaseLines: Array<{ post: Post; quantity: number; unitPriceCents: number; sellerFeeCents: number; isAuction: boolean }> = [];
    for (const item of cartItems) {
      if (!payableCartItemIds.has(item.id)) continue;
      const locked = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Post" WHERE "id" = ${item.postId} FOR UPDATE
      `;
      if (!locked.length) throw new CartPaymentError("A listing in your cart no longer exists. Contact support with your payment reference.", 409);
      const post = await transaction.post.findUnique({
        where: { id: item.postId },
        include: {
          auctionRoom: {
            select: {
              id: true,
              status: true,
              highestBidderId: true,
              currentHighestBid: true,
              platformFeeCents: true,
              paymentDueAt: true,
              paymentGraceUntil: true,
            },
          },
        },
      });
      if (!post) throw new CartPaymentError("An item in your cart is no longer available. Contact support with your payment reference.", 409);
      if (item.auctionRoomId) {
        if (item.auctionRoomId !== post.auctionRoom?.id) {
          throw new CartPaymentError(`“${post.title}” is no longer available. Contact support with your payment reference.`, 409);
        }
        if (!isAuctionCartItemAvailable({ auctionRoomId: item.auctionRoomId, post }, buyerId)) continue;
        if (!verifiedPayment.paidAt
          || !isAuctionPaymentOnTime(
            verifiedPayment.paidAt,
            post.auctionRoom.paymentDueAt,
            post.auctionRoom.paymentGraceUntil,
          )) {
          throw new CartPaymentError(`The payment for auction item “${post.title}” was completed after its deadline. Contact support with your payment reference.`, 409);
        }
      } else if (!isAvailable(post, buyerId, item.quantity)) {
        throw new CartPaymentError(`“${post.title}” is no longer available. Contact support with your payment reference.`, 409);
      }

      const unitPriceCents = Math.round((item.auctionRoomId && post.auctionRoom
        ? post.auctionRoom.currentHighestBid
        : post.price) * 100);
      if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
        throw new CartPaymentError(`“${post.title}” has an invalid asking price. Contact support with your payment reference.`, 409);
      }
      const sellerFeeCents = item.auctionRoomId ? post.auctionRoom?.platformFeeCents ?? 0 : 0;
      if (!Number.isSafeInteger(sellerFeeCents) || sellerFeeCents < 0 || sellerFeeCents > unitPriceCents * item.quantity) {
        throw new CartPaymentError(`“${post.title}” has an invalid seller fee. Contact support with your payment reference.`, 409);
      }
      purchaseLines.push({
        post,
        quantity: item.quantity,
        unitPriceCents,
        sellerFeeCents,
        isAuction: Boolean(item.auctionRoomId),
      });
    }

    if (purchaseLines.length === 0) return null;
    const subtotalCents = purchaseLines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
    if (!Number.isSafeInteger(subtotalCents)) throw new CartPaymentError("The order total is too large to process.", 400);
    if (subtotalCents !== verifiedPayment.subtotalUsdCents) {
      throw new CartPaymentError("The payable items changed after payment started. Contact support with your payment reference.", 409);
    }

    const createdOrder = await transaction.purchaseOrder.create({
      data: {
        buyerId,
        paymentReference: reference,
        subtotalCents,
        items: { create: purchaseLines.map(({ post, quantity, unitPriceCents, sellerFeeCents }) => ({
          postId: post.id,
          sellerId: post.sellerId,
          title: post.title,
          quantity,
          unitPriceCents,
          sellerFeeCents,
        })) },
      },
      include: { items: true },
    });

    const sellerPayoutGroups = new Map<string, number>();
    for (const line of purchaseLines) {
      const sellerTotal = sellerPayoutGroups.get(line.post.sellerId) ?? 0;
      sellerPayoutGroups.set(
        line.post.sellerId,
        sellerTotal + line.quantity * line.unitPriceCents - line.sellerFeeCents,
      );
    }
    const payoutRows = [];
    for (const [sellerId, amountUsdCents] of sellerPayoutGroups) {
      const verification = await transaction.sellerVerification.findUnique({
        where: { userId: sellerId },
        select: {
          payoutStatus: true,
          bankAccountNumber: true,
          bankAccountName: true,
          paystackRecipientCode: true,
        },
      });
      const eligible = verification?.payoutStatus === "VERIFIED"
        && Boolean(verification.bankAccountNumber)
        && Boolean(verification.bankAccountName)
        && Boolean(verification.paystackRecipientCode)
        && amountUsdCents > 0;
      payoutRows.push({
        orderId: createdOrder.id,
        sellerId,
        amountUsdCents,
        recipientCode: eligible ? verification.paystackRecipientCode : null,
        transferReference: eligible ? `QRSP_${randomUUID().replaceAll("-", "")}` : null,
        status: eligible ? "PENDING" as const : "BLOCKED" as const,
        failureReason: eligible
          ? null
          : amountUsdCents <= 0
            ? "NON_POSITIVE_PAYOUT"
            : verification?.payoutStatus !== "VERIFIED"
              ? "PAYOUT_ACCOUNT_NOT_VERIFIED"
              : !verification.bankAccountNumber || !verification.bankAccountName
                ? "PAYOUT_ACCOUNT_DETAILS_MISSING"
                : "PAYSTACK_RECIPIENT_MISSING",
      });
    }
    await transaction.sellerPayout.createMany({ data: payoutRows });

    const sellerOrderLines = new Map<string, string[]>();
    for (const line of purchaseLines) {
      const titles = sellerOrderLines.get(line.post.sellerId) ?? [];
      titles.push(line.post.title);
      sellerOrderLines.set(line.post.sellerId, titles);
    }
    await transaction.notification.createMany({
      data: [
        {
          userId: buyerId,
          type: "ORDER_UPDATE",
          title: "Order placed",
          message: `Your payment was confirmed and your order for ${purchaseLines.length === 1 ? "1 item" : `${purchaseLines.length} items`} is recorded. You can track it in My Orders.`,
          entityType: "ORDER",
          entityId: createdOrder.id,
        },
        ...Array.from(sellerOrderLines, ([sellerId, titles]) => ({
          userId: sellerId,
          type: "ORDER_UPDATE" as const,
          title: "New order received",
          message: `A buyer placed an order for ${titles.join(", ")}. Review it in Seller Studio and arrange fulfillment.`,
          entityType: "ORDER",
          entityId: createdOrder.id,
        })),
      ],
    });

    for (const line of purchaseLines.filter((purchaseLine) => !purchaseLine.isAuction)) {
      const quantityAvailable = line.post.quantityAvailable - line.quantity;
      await transaction.post.update({
        where: { id: line.post.id },
        data: { quantityAvailable, ...(quantityAvailable === 0 ? { status: "SOLD" } : {}) },
      });
    }
    await transaction.cartItem.deleteMany({
      where: { userId: buyerId, postId: { in: purchaseLines.map((line) => line.post.id) } },
    });

    return createdOrder;
  });

  if (order) {
    try {
      await processPendingSellerPayouts(order.id);
    } catch (error) {
      console.error("Seller payouts remain pending after order finalization.", { orderId: order.id, error });
    }
  }
  return order;
}
