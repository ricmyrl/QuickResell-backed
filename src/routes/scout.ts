import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { sendScoutSupportEmail } from "../services/mail.js";
import { generateScoutReply, type ScoutContext, type ScoutMessage } from "../services/scoutLanguageModel.js";

const router = Router();
const allowedIntents = new Set([
  "greeting",
  "bid_rule",
  "bid_status",
  "auction_search",
  "shop_search",
  "checkout",
  "seller",
  "trust",
  "support",
  "unknown",
]);
const allowedSupportCategories = new Set(["BIDDING", "SHOP", "CHECKOUT", "ACCOUNT", "TECHNICAL", "OTHER"]);
const supportWindowMs = 24 * 60 * 60 * 1000;
const maxSupportRequestsPerWindow = 5;
const chatWindowMs = 60_000;
const maxChatRequestsPerWindow = 12;
const chatRequestCounts = new Map<string, { count: number; resetAt: number }>();

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScoutMessage(value: unknown): value is ScoutMessage {
  return isRecord(value)
    && (value.role === "user" || value.role === "assistant")
    && boundedString(value.content, 1000);
}

function isScoutAuction(value: unknown): value is ScoutContext["auctions"][number] {
  return isRecord(value)
    && boundedString(value.title, 100)
    && boundedString(value.category, 60)
    && boundedString(value.location, 80)
    && typeof value.currentBid === "number"
    && Number.isFinite(value.currentBid)
    && value.currentBid >= 0
    && typeof value.bids === "number"
    && Number.isInteger(value.bids)
    && value.bids >= 0;
}

function isScoutListing(value: unknown): value is ScoutContext["listings"][number] {
  return isRecord(value)
    && boundedString(value.title, 100)
    && boundedString(value.category, 60)
    && boundedString(value.location, 80)
    && typeof value.price === "number"
    && Number.isFinite(value.price)
    && value.price >= 0
    && typeof value.quantityAvailable === "number"
    && Number.isInteger(value.quantityAvailable)
    && value.quantityAvailable >= 0;
}

function validChatMessages(value: unknown): value is ScoutMessage[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 8
    && value.every(isScoutMessage)
    && value[value.length - 1]?.role === "user";
}

function validScoutContext(value: unknown): value is ScoutContext {
  return isRecord(value)
    && Array.isArray(value.auctions)
    && value.auctions.length <= 20
    && value.auctions.every(isScoutAuction)
    && Array.isArray(value.listings)
    && value.listings.length <= 20
    && value.listings.every(isScoutListing);
}

function allowChatRequest(ipAddress: string): boolean {
  const now = Date.now();
  for (const [ip, entry] of chatRequestCounts) {
    if (entry.resetAt <= now) chatRequestCounts.delete(ip);
  }
  const current = chatRequestCounts.get(ipAddress);
  if (!current || current.resetAt <= now) {
    chatRequestCounts.set(ipAddress, { count: 1, resetAt: now + chatWindowMs });
    return true;
  }
  if (current.count >= maxChatRequestsPerWindow) return false;
  current.count += 1;
  return true;
}

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

router.post("/scout/chat", async (request, response) => {
  if (!allowChatRequest(request.ip || "unknown")) {
    response.status(429).json({ error: "Scout is receiving too many requests. Please wait a minute and try again." });
    return;
  }

  const { messages, context } = request.body ?? {};
  if (!validChatMessages(messages)) {
    response.status(400).json({ error: "Send between 1 and 8 recent Scout messages, each no longer than 1000 characters." });
    return;
  }
  if (!validScoutContext(context)) {
    response.status(400).json({ error: "The marketplace context is missing or invalid." });
    return;
  }

  try {
    const reply = await generateScoutReply(messages, context);
    response.json({ reply, model: process.env.SCOUT_MODEL?.trim() || "qwen2.5:0.5b" });
  } catch (error) {
    console.warn("Scout language model is unavailable.", error instanceof Error ? error.message : "Unknown model error.");
    response.status(503).json({ error: "The Scout language model is unavailable. Local Scout help is still available." });
  }
});

router.use("/scout/feedback", requireSupabaseUser, requireConfirmedEmail);
router.post("/scout/feedback", async (request, response) => {
  const user = currentUser(request);
  const { messageId, intent, helpful } = request.body ?? {};
  if (typeof messageId !== "string" || !/^[\w-]{1,80}$/.test(messageId)) {
    response.status(400).json({ error: "messageId must be a valid Scout response identifier." });
    return;
  }
  if (typeof intent !== "string" || !allowedIntents.has(intent)) {
    response.status(400).json({ error: "intent is not recognized." });
    return;
  }
  if (typeof helpful !== "boolean") {
    response.status(400).json({ error: "helpful must be a boolean." });
    return;
  }

  const feedback = await prisma.scoutFeedback.upsert({
    where: { userId_messageId: { userId: user.id, messageId } },
    update: { intent, helpful },
    create: { userId: user.id, messageId, intent, helpful },
  });
  response.status(200).json({ feedback: { id: feedback.id, helpful: feedback.helpful } });
});

router.use("/scout/support", requireSupabaseUser, requireConfirmedEmail);
router.post("/scout/support", async (request, response) => {
  const user = currentUser(request);
  const category = typeof request.body?.category === "string" ? request.body.category.toUpperCase() : "";
  const message = request.body?.message;
  if (!allowedSupportCategories.has(category)) {
    response.status(400).json({ error: "Choose a valid support category." });
    return;
  }
  if (typeof message !== "string" || message.trim().length < 12 || message.trim().length > 2000) {
    response.status(400).json({ error: "Describe the issue in 12 to 2000 characters." });
    return;
  }

  const recentCount = await prisma.supportRequest.count({
    where: { userId: user.id, createdAt: { gte: new Date(Date.now() - supportWindowMs) } },
  });
  if (recentCount >= maxSupportRequestsPerWindow) {
    response.status(429).json({ error: "You have reached the support request limit. Please try again later." });
    return;
  }

  const supportRequest = await prisma.supportRequest.create({
    data: { userId: user.id, category, message: message.trim() },
    select: { id: true, category: true, status: true, createdAt: true },
  });
  const emailNotified = await sendScoutSupportEmail({
    requestId: supportRequest.id,
    customerEmail: user.email,
    category,
    message: message.trim(),
  });
  response.status(201).json({ request: supportRequest, emailNotified });
});

router.get("/scout/support/:requestId", requireSupabaseUser, requireConfirmedEmail, async (request, response) => {
  const user = currentUser(request);
  const requestId = Array.isArray(request.params.requestId) ? request.params.requestId[0] : request.params.requestId;
  const supportRequest = await prisma.supportRequest.findFirst({
    where: { id: requestId, userId: user.id },
    select: { id: true, category: true, status: true, createdAt: true, updatedAt: true },
  });
  if (!supportRequest) {
    response.status(404).json({ error: "Support request not found." });
    return;
  }
  response.json({ request: supportRequest });
});

export default router;