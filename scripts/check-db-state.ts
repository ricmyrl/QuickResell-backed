import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL must be set.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  const [userCount, postCount, imageCount] = await Promise.all([
    prisma.user.count(),
    prisma.post.count(),
    prisma.listingImage.count(),
  ]);

  console.log(JSON.stringify({ userCount, postCount, imageCount }, null, 2));
} finally {
  await prisma.$disconnect();
}
