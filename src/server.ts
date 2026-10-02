import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { prisma } from "./lib/prisma.js";
import auctionsRouter, { finalizeExpiredAuctions } from "./routes/auctions.js";
import auctionWatchlistRouter from "./routes/auctionWatchlist.js";
import cartRouter from "./routes/cart.js";
import conversationsRouter from "./routes/conversations.js";
import marketplaceRouter from "./routes/marketplace.js";
import notificationsRouter from "./routes/notifications.js";
import paymentsRouter from "./routes/payments.js";
import scoutRouter from "./routes/scout.js";

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
const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (allowedOrigins.includes(origin)) return true;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") return true;
    if (hostname.startsWith("10.33.121.") || hostname.startsWith("192.168.") || hostname.startsWith("172.")) return true;
  } catch {
    return false;
  }

  return false;
}

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
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use("/api", auctionWatchlistRouter);
app.use("/api", marketplaceRouter);
app.use("/api", notificationsRouter);
app.use("/api", conversationsRouter);
app.use("/api", scoutRouter);
app.use("/api", cartRouter);
app.use("/api", paymentsRouter);
app.use("/api", auctionsRouter);

void finalizeExpiredAuctions().catch((error: unknown) => {
  console.error("Failed to finalize expired auctions during startup.", error);
});
const auctionFinalizationTimer = setInterval(() => {
  void finalizeExpiredAuctions().catch((error: unknown) => {
    console.error("Failed to finalize expired auctions.", error);
  });
}, 5_000);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => console.log(`Quick Resell API listening on port ${port}`));

async function shutdown() {
  clearInterval(auctionFinalizationTimer);
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);