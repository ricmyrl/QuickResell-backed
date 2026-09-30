import "dotenv/config";
import { createClient, type User as SupabaseUser } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

type AuthenticatedRequest = Request & { marketplaceUser?: User };

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
    const displayName = metadataString(authUser.user_metadata?.full_name, authUser.user_metadata?.name);
    const avatarUrl = metadataString(authUser.user_metadata?.avatar_url, authUser.user_metadata?.picture);
    const localUser = await prisma.user.upsert({
      where: { id: authUser.id },
      update: {
        email: authUser.email ?? undefined,
        displayName: displayName ?? undefined,
        avatarUrl: avatarUrl ?? undefined,
      },
      create: {
        id: authUser.id,
        email: authUser.email ?? null,
        displayName,
        avatarUrl,
      },
    });

    (request as AuthenticatedRequest).marketplaceUser = localUser;
    next();
  } catch (error) {
    next(error);
  }
}

export type { AuthenticatedRequest };