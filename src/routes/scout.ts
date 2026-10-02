import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { sendScoutSupportEmail } from "../services/mail.js";

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

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

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