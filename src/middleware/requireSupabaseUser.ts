import "dotenv/config";
import { createClient, type User as SupabaseUser } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

type AuthenticatedRequest = Request & { marketplaceUser?: User; emailConfirmed?: boolean };

let supabaseClient: ReturnType<typeof createClient> | undefined;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be configured.");
  }

  supabaseClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseClient;
}

function metadataString(...values: unknown[]): string | null {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return typeof value === "string" ? value.trim() : null;
}

export async function requireSupabaseUser(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const authorization = request.header("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    response.status(401).json({ error: "A Supabase access token is required." });
    return;
  }

  try {
    const { data, error } = await getSupabaseClient().auth.getUser(token);
    if (error || !data.user) {
      response.status(401).json({ error: "The Supabase access token is invalid or expired." });
      return;
    }

    const authUser: SupabaseUser = data.user;
    (request as AuthenticatedRequest).emailConfirmed = Boolean(authUser.email_confirmed_at);
    const displayName = metadataString(authUser.user_metadata?.full_name, authUser.user_metadata?.name);
    const avatarUrl = metadataString(authUser.user_metadata?.avatar_url, authUser.user_metadata?.picture);
    const profileUpdate = {
      email: authUser.email ?? undefined,
      displayName: displayName ?? undefined,
      avatarUrl: avatarUrl ?? undefined,
    };
    const existingUser = await prisma.user.findUnique({
      where: { id: authUser.id },
    });

    const profileChanged = existingUser !== null && (
      (profileUpdate.email !== undefined && existingUser.email !== profileUpdate.email) ||
      (profileUpdate.displayName !== undefined && existingUser.displayName !== profileUpdate.displayName) ||
      (profileUpdate.avatarUrl !== undefined && existingUser.avatarUrl !== profileUpdate.avatarUrl)
    );

    const isCampusVerified = Boolean(authUser.email_confirmed_at);
    const localUser = existingUser
      ? profileChanged
        ? await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            ...profileUpdate,
            isCampusVerified: existingUser.isCampusVerified || isCampusVerified,
          },
        })
        : {
            ...existingUser,
            isCampusVerified: existingUser.isCampusVerified || isCampusVerified,
          }
      : await prisma.user.upsert({
        where: { id: authUser.id },
        update: {
          ...profileUpdate,
          isCampusVerified: isCampusVerified,
        },
        create: {
          id: authUser.id,
          email: authUser.email ?? null,
          displayName,
          avatarUrl,
          isCampusVerified,
        },
      });

    (request as AuthenticatedRequest).marketplaceUser = localUser;
    next();
  } catch (error) {
    next(error);
  }
}

export async function optionalSupabaseUser(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!request.header("authorization")) {
    next();
    return;
  }
  await requireSupabaseUser(request, response, next);
}

export function requireConfirmedEmail(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if ((request as AuthenticatedRequest).emailConfirmed !== true) {
    response.status(403).json({ error: "Confirm your email address before using this feature." });
    return;
  }
  next();
}

export async function requirePasskeyVerification(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) {
    response.status(401).json({ error: "Authentication is required." });
    return;
  }
  const now = new Date();
  const consumed = await prisma.user.updateMany({
    where: { id: user.id, passkeyVerifiedUntil: { gt: now } },
    data: { passkeyVerifiedUntil: null },
  });
  if (consumed.count !== 1) {
    response.status(403).json({
      error: "Verify with your passkey before completing this action.",
      code: "PASSKEY_VERIFICATION_REQUIRED",
    });
    return;
  }
  next();
}

export type { AuthenticatedRequest };