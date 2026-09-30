import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be set before seeding.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const categoryNames = [
  "Books",
  "Clothing",
  "Electronics",
  "Furniture",
  "Dorm Essentials",
  "Sports & Outdoors",
  "Other",
];

try {
  for (const name of categoryNames) {
    await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
  }
} finally {
  await prisma.$disconnect();
}