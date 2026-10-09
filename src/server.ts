import "dotenv/config";
import cors from "cors";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { prisma } from "./lib/prisma.js";
import auctionsRouter, { finalizeExpiredAuctions, finalizeUnpaidAuctionWins } from "./routes/auctions.js";
import auctionWatchlistRouter from "./routes/auctionWatchlist.js";
import accountRouter from "./routes/account.js";
import cartRouter from "./routes/cart.js";
import conversationsRouter from "./routes/conversations.js";
import currencyRouter from "./routes/currency.js";
import marketplaceRouter from "./routes/marketplace.js";
import notificationsRouter from "./routes/notifications.js";
import ordersRouter from "./routes/orders.js";
import paymentsRouter from "./routes/payments.js";
import passkeysRouter from "./routes/passkeys.js";
import paystackWebhookRouter from "./routes/paystackWebhook.js";
import sellerVerificationRouter from "./routes/sellerVerification.js";
import scoutRouter from "./routes/scout.js";
import walletRouter from "./routes/wallet.js";
import { getPaystackSecretKey } from "./services/paystack.js";
import { processDueSniperBids } from "./services/autoBidding.js";
import { processAllPendingSellerPayouts } from "./services/sellerPayouts.js";

const requiredEnvironment = ["SUPABASE_URL"];
if (!process.env.DATABASE_URL && !process.env.DIRECT_URL) {
  throw new Error("DATABASE_URL or DIRECT_URL must be configured.");
}
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`${name} must be configured.`);
}
if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY must be configured.");
}

const app = express();
const isProduction = process.env.NODE_ENV === "production";
if (isProduction) getPaystackSecretKey();
const frontendUrl = process.env.FRONTEND_URL ?? (isProduction ? "" : "http://localhost:5173");
if (isProduction && !frontendUrl.trim()) {
  throw new Error("FRONTEND_URL must be configured in production.");
}
const allowedOrigins = frontendUrl
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    const parsed = new URL(origin);
    if (isProduction && parsed.protocol !== "https:") {
      throw new Error("FRONTEND_URL origins must use HTTPS in production.");
    }
    return parsed.origin;
  });

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (allowedOrigins.includes(parsed.origin)) return true;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return true;
    if (hostname.startsWith("10.33.121.") || hostname.startsWith("192.168.") || hostname.startsWith("172.")) return true;
    if (isProduction) return false;
  } catch {
    return false;
  }

  return false;
}

app.use((_request, response, next) => {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: true,
}));
app.use("/api", paystackWebhookRouter);
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use("/api", currencyRouter);
app.use("/api", accountRouter);
app.use("/api", auctionWatchlistRouter);
app.use("/api", marketplaceRouter);
app.use("/api", sellerVerificationRouter);
app.use("/api", notificationsRouter);
app.use("/api", ordersRouter);
app.use("/api", conversationsRouter);
app.use("/api", scoutRouter);
app.use("/api", cartRouter);
app.use("/api", paymentsRouter);
app.use("/api", passkeysRouter);
app.use("/api", walletRouter);
app.use("/api", auctionsRouter);
app.use((request, response) => {
  const requestId = typeof response.locals.requestId === "string" ? response.locals.requestId : randomUUID();
  response.status(404).json({
    error: "The requested API endpoint does not exist.",
    code: "ENDPOINT_NOT_FOUND",
    requestId,
  });
});

void Promise.all([finalizeExpiredAuctions(), finalizeUnpaidAuctionWins(), processDueSniperBids()]).catch((error: unknown) => {
  console.error("Failed to run auction maintenance workers during startup.", error);
});
const auctionFinalizationTimer = setInterval(() => {
  void Promise.all([finalizeExpiredAuctions(), finalizeUnpaidAuctionWins(), processDueSniperBids()]).catch((error: unknown) => {
    console.error("Failed to run auction maintenance workers.", error);
  });
}, 5_000);

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const requestId = typeof response.locals.requestId === "string" ? response.locals.requestId : randomUUID();
  const details = typeof error === "object" && error !== null
    ? error as { code?: unknown; type?: unknown; status?: unknown; message?: unknown }
    : {};
  const errorCode = typeof details.code === "string" ? details.code : "";
  const errorType = typeof details.type === "string" ? details.type : "";
  let status = 500;
  let code = "INTERNAL_SERVER_ERROR";
  let message = "The server could not complete your request.";

  if (errorType === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "The request body contains invalid JSON.";
  } else if (errorType === "entity.too.large") {
    status = 413;
    code = "REQUEST_TOO_LARGE";
    message = "The request body is too large.";
  } else if (["P2021", "P2022", "42P01", "42703"].includes(errorCode)) {
    status = 503;
    code = "DATABASE_SCHEMA_UNAVAILABLE";
    message = "The database is missing a required update. Please retry shortly or contact support.";
  } else if (["P1001", "P1002", "P1008", "P1017", "08000", "08003", "08006"].includes(errorCode)) {
    status = 503;
    code = "DATABASE_UNAVAILABLE";
    message = "The database is temporarily unavailable. Please retry shortly.";
  } else if (errorCode === "P2002") {
    status = 409;
    code = "RESOURCE_CONFLICT";
    message = "This request conflicts with an existing record.";
  } else if (errorCode === "P2003") {
    status = 409;
    code = "RELATED_RESOURCE_CONFLICT";
    message = "This request references a resource that can no longer be changed.";
  } else if (errorCode === "P2025") {
    status = 404;
    code = "RESOURCE_NOT_FOUND";
    message = "The requested record could not be found.";
  } else if (error instanceof Error && error.message === "Origin is not allowed by CORS.") {
    status = 403;
    code = "ORIGIN_NOT_ALLOWED";
    message = "This website is not allowed to access the API.";
  }

  console.error("API request failed.", {
    requestId,
    method: request.method,
    path: request.path,
    status,
    code,
    error,
  });
  response.status(status).json({ error: message, code, requestId });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => console.log(`Quick Resell API listening on port ${port}`));

void processAllPendingSellerPayouts().catch((error: unknown) => {
  console.error("Failed to process pending seller payouts during startup.", error);
});
const sellerPayoutRetryTimer = setInterval(() => {
  void processAllPendingSellerPayouts().catch((error: unknown) => {
    console.error("Failed to process pending seller payouts.", error);
  });
}, 60_000);

async function shutdown() {
  clearInterval(auctionFinalizationTimer);
  clearInterval(sellerPayoutRetryTimer);
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);