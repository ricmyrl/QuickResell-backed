import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { prisma } from "./lib/prisma.js";
import auctionsRouter from "./routes/auctions.js";
import conversationsRouter from "./routes/conversations.js";
import marketplaceRouter from "./routes/marketplace.js";

const requiredEnvironment = ["DATABASE_URL", "SUPABASE_URL"];
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

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin is not allowed by CORS."));
  },
}));
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.use("/api", marketplaceRouter);
app.use("/api", conversationsRouter);
app.use("/api", auctionsRouter);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => console.log(`Quick Resell API listening on port ${port}`));

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);