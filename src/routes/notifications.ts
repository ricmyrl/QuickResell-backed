import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";

const router = Router();

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

router.use("/notifications", requireSupabaseUser, requireConfirmedEmail);

router.get("/notifications", async (request, response) => {
  const user = currentUser(request);
  const rows = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });

  response.json({ notifications: rows });
});

router.delete("/notifications/:notificationId", async (request, response) => {
  const user = currentUser(request);
  const result = await prisma.notification.deleteMany({
    where: { id: request.params.notificationId, userId: user.id },
  });

  if (result.count === 0) {
    response.status(404).json({ error: "Notification not found." });
    return;
  }

  response.status(204).end();
});

router.post("/notifications/:notificationId/read", async (request, response) => {
  const user = currentUser(request);
  const notification = await prisma.notification.findUnique({
    where: { id: request.params.notificationId },
    select: { id: true, userId: true },
  });

  if (!notification || notification.userId !== user.id) {
    response.status(404).json({ error: "Notification not found." });
    return;
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { isRead: true },
  });

  response.json({ notification: updated });
});

router.post("/notifications/read-all", async (request, response) => {
  const user = currentUser(request);
  const result = await prisma.notification.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true },
  });

  response.json({ updated: result.count });
});

export default router;
