import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { createNotification } from "../lib/notifications.js";

const router = Router();
const maxMessageLength = 4000;
const allowedMessageTypes = new Set(["GENERAL", "REVIEW", "REPLY"] as const);

router.use("/conversations", requireSupabaseUser);
router.use("/listings/:listingId/conversation", requireSupabaseUser);

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function conversationDetails() {
  return {
    listing: {
      include: {
        images: { orderBy: { sortOrder: "asc" as const }, take: 1 },
      },
    },
    buyer: { select: { id: true, displayName: true, avatarUrl: true } },
    seller: { select: { id: true, displayName: true, avatarUrl: true } },
  };
}

type ParticipantConversationAccess =
  | { error: string; status: 404 | 403 }
  | { conversation: { id: string; buyerId: string; sellerId: string } };

async function findParticipantConversation(
  conversationId: string,
  userId: string,
): Promise<ParticipantConversationAccess> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, buyerId: true, sellerId: true },
  });

  if (!conversation) return { error: "Conversation not found.", status: 404 };
  if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
    return { error: "You are not a participant in this conversation.", status: 403 };
  }

  return { conversation };
}

router.get("/conversations", async (request, response) => {
  const user = currentUser(request);
  const conversations = await prisma.conversation.findMany({
    where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
    orderBy: { updatedAt: "desc" },
    include: {
      ...conversationDetails(),
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  response.json({ conversations });
});

router.use("/listings/:listingId/conversation", requireConfirmedEmail);
router.post("/listings/:listingId/conversation", async (request, response) => {
  const buyer = currentUser(request);
  const listing = await prisma.post.findUnique({
    where: { id: request.params.listingId },
    select: { id: true, sellerId: true, status: true },
  });

  if (!listing) {
    response.status(404).json({ error: "Listing not found." });
    return;
  }
  if (listing.sellerId === buyer.id) {
    response.status(400).json({ error: "You cannot start a conversation with yourself." });
    return;
  }

  const key = {
    buyerId: buyer.id,
    sellerId: listing.sellerId,
    listingId: listing.id,
  };
  const existing = await prisma.conversation.findUnique({
    where: { buyerId_sellerId_listingId: key },
    include: conversationDetails(),
  });

  if (existing) {
    response.json({ conversation: existing });
    return;
  }
  if (listing.status !== "ACTIVE") {
    response.status(409).json({ error: "A conversation cannot be started for an inactive listing." });
    return;
  }

  const conversation = await prisma.conversation.upsert({
    where: { buyerId_sellerId_listingId: key },
    update: {},
    create: key,
    include: conversationDetails(),
  });

  response.status(201).json({ conversation });
});

router.use("/conversations/:conversationId/messages", requireConfirmedEmail);
router.post("/conversations/:conversationId/messages", async (request, response) => {
  const user = currentUser(request);
  const access = await findParticipantConversation(request.params.conversationId, user.id);
  if ("error" in access) {
    response.status(access.status).json({ error: access.error });
    return;
  }

  const content = request.body?.content;
  if (typeof content !== "string" || !content.trim() || content.trim().length > maxMessageLength) {
    response.status(400).json({
      error: `content is required and must be at most ${maxMessageLength} characters.`,
    });
    return;
  }

  const messageType = typeof request.body?.type === "string" ? request.body.type.toUpperCase() : "GENERAL";
  if (!allowedMessageTypes.has(messageType as (typeof allowedMessageTypes extends Set<infer T> ? T : never))) {
    response.status(400).json({ error: "type must be one of GENERAL, REVIEW, or REPLY." });
    return;
  }

  const ratingValue = request.body?.rating;
  const rating = typeof ratingValue === "number" ? Number(ratingValue) : undefined;
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    response.status(400).json({ error: "rating must be an integer between 1 and 5 when provided." });
    return;
  }

  const replyToId = typeof request.body?.replyToId === "string" ? request.body.replyToId : null;
  if (replyToId && messageType !== "REPLY") {
    response.status(400).json({ error: "replyToId is only valid for REPLY messages." });
    return;
  }

  if (messageType === "REVIEW" && user.id !== access.conversation.buyerId) {
    response.status(403).json({ error: "Only the buyer can leave a review." });
    return;
  }

  if (messageType === "REPLY" && user.id !== access.conversation.sellerId) {
    response.status(403).json({ error: "Only the seller can reply to a review." });
    return;
  }

  if (messageType === "REVIEW" && rating === undefined) {
    response.status(400).json({ error: "A review must include a 1-5 rating." });
    return;
  }

  if (messageType === "REPLY" && !replyToId) {
    response.status(400).json({ error: "A reply must reference the review it is responding to." });
    return;
  }

  if (messageType === "REPLY" && replyToId) {
    const targetMessage = await prisma.message.findFirst({
      where: {
        id: replyToId,
        conversationId: access.conversation.id,
      },
      select: { id: true, type: true, senderId: true },
    });

    if (!targetMessage || targetMessage.type !== "REVIEW") {
      response.status(400).json({ error: "replyToId must reference a buyer review in this conversation." });
      return;
    }
  }

  const message = await prisma.$transaction(async (transaction) => {
    const created = await transaction.message.create({
      data: {
        conversationId: access.conversation.id,
        senderId: user.id,
        content: content.trim(),
        type: messageType as "GENERAL" | "REVIEW" | "REPLY",
        rating,
        replyToId: replyToId ?? undefined,
      },
      include: {
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
        replyTo: { select: { id: true, type: true, senderId: true } },
      },
    });
    await transaction.conversation.update({
      where: { id: access.conversation.id },
      data: { updatedAt: new Date() },
    });
    return created;
  });

  const recipientId = message.type === "REVIEW" ? access.conversation.sellerId : message.type === "REPLY" ? access.conversation.buyerId : null;
  if (recipientId && recipientId !== user.id) {
    await createNotification({
      userId: recipientId,
      type: message.type === "REVIEW" ? "REVIEW" : "REPLY",
      title: message.type === "REVIEW" ? "New customer review" : "Seller replied",
      message: message.type === "REVIEW"
        ? `${user.displayName ?? "A buyer"} left a ${message.rating ?? 0}-star review.`
        : `${user.displayName ?? "Your seller"} replied to your review.`,
      entityType: "conversation",
      entityId: access.conversation.id,
    });
  }

  response.status(201).json({ message });
});

router.get("/conversations/:conversationId/messages", async (request, response) => {
  const user = currentUser(request);
  const access = await findParticipantConversation(request.params.conversationId, user.id);
  if ("error" in access) {
    response.status(access.status).json({ error: access.error });
    return;
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: access.conversation.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      sender: { select: { id: true, displayName: true, avatarUrl: true } },
      replyTo: { select: { id: true, type: true, senderId: true } },
    },
  });

  response.json({ messages });
});

export default router;
