import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { createClient } from "@supabase/supabase-js";

const router = Router();

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for account deletion.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function ownedListingImagePath(value: string, ownerId: string): string | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;

  try {
    const url = new URL(value);
    const bucket = process.env.SUPABASE_LISTING_BUCKET ?? "listing-images";
    const prefix = `/storage/v1/object/public/${bucket}/${ownerId}/`;
    if (url.origin !== new URL(supabaseUrl).origin || !url.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(url.pathname.slice(`/storage/v1/object/public/${bucket}/`.length));
    return path.startsWith(`${ownerId}/`) && path.length > ownerId.length + 1 ? path : null;
  } catch {
    return null;
  }
}

router.use("/account", requireSupabaseUser);

router.get("/account", async (request, response) => {
  const user = currentUser(request);
  response.json({
    profile: {
      displayName: user.displayName,
      email: user.email,
      preferredDormOrCampus: user.preferredDormOrCampus,
      budgetPreference: user.budgetPreference,
    },
  });
});

router.patch("/account", async (request, response) => {
  const user = currentUser(request);
  const { preferredDormOrCampus, budgetPreference } = request.body ?? {};

  if (typeof preferredDormOrCampus !== "string" || preferredDormOrCampus.trim().length > 120) {
    response.status(400).json({ error: "Campus or area must be 120 characters or fewer." });
    return;
  }
  if (budgetPreference !== null
    && (typeof budgetPreference !== "number" || !Number.isFinite(budgetPreference) || budgetPreference < 0 || budgetPreference > 100000)) {
    response.status(400).json({ error: "Budget must be between 0 and 100,000, or left blank." });
    return;
  }

  const profile = await prisma.user.update({
    where: { id: user.id },
    data: {
      preferredDormOrCampus: preferredDormOrCampus.trim() || null,
      budgetPreference,
    },
    select: {
      displayName: true,
      email: true,
      preferredDormOrCampus: true,
      budgetPreference: true,
    },
  });
  response.json({ profile });
});

router.delete("/account", async (request, response) => {
  const user = currentUser(request);
  const confirmation = request.body?.confirmation;
  if (confirmation !== user.email) {
    response.status(400).json({ error: "Enter the email address on your account to confirm permanent deletion." });
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    response.status(503).json({ error: "Account deletion is not configured on this server. Contact support to complete your request." });
    return;
  }
  const admin = supabaseAdmin();
  const imageRows = await prisma.listingImage.findMany({
    where: { post: { sellerId: user.id } },
    select: { url: true },
  });
  const imagePaths = Array.from(new Set(imageRows
    .map(({ url }) => ownedListingImagePath(url, user.id))
    .filter((path): path is string => path !== null)));
  const imageBucket = process.env.SUPABASE_LISTING_BUCKET ?? "listing-images";
  for (let index = 0; index < imagePaths.length; index += 100) {
    const { error } = await admin.storage.from(imageBucket).remove(imagePaths.slice(index, index + 100));
    if (error) {
      console.error("Account listing images could not be removed.", { userId: user.id, error: error.message });
      response.status(502).json({ error: "Your listing photos could not be deleted. No account records were removed; please retry or contact support." });
      return;
    }
  }

  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.purchaseOrder.deleteMany({
        where: {
          OR: [
            { buyerId: user.id },
            { items: { some: { sellerId: user.id } } },
          ],
        },
      });
      await transaction.user.delete({ where: { id: user.id } });
    });
  } catch (error) {
    console.error("Marketplace account records could not be deleted.", { userId: user.id, error });
    response.status(500).json({ error: "Some listing photos may already be removed, but account records could not be deleted. Retry account deletion or contact support." });
    return;
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("Local account data was deleted, but Supabase account deletion failed.", {
      userId: user.id,
      error: error.message,
    });
    response.status(502).json({ error: "Your marketplace data was deleted, but sign-in could not be removed yet. Retry account deletion or contact support." });
    return;
  }

  response.json({ deleted: true });
});

export default router;
