import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const maxMessageLength = 4000;

router.use(requireSupabaseUser);

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

  const message = await prisma.$transaction(async (transaction) => {
    const created = await transaction.message.create({
      data: {
        conversationId: access.conversation.id,
        senderId: user.id,
        content: content.trim(),
      },
      include: {
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
    await transaction.conversation.update({
      where: { id: access.conversation.id },
      data: { updatedAt: new Date() },
    });
    return created;
  });

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
    },
  });

  response.json({ messages });
});

export default router;
