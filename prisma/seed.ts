import "dotenv/config";
import { randomUUID } from "node:crypto";
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
] as const;

const sellerNames = [
  "Ava Martinez",
  "Noah Patel",
  "Lena Brooks",
  "Jordan Lee",
  "Sofia Nguyen",
  "Ethan Cooper",
  "Mila Sanchez",
  "Chris Turner",
  "Priya Shah",
  "Daniel Kim",
  "Emma Wilson",
  "Leo Brown",
  "Rachel Green",
  "Samir Ali",
  "Olivia Davis",
];

const campusLocations = [
  "North Hall",
  "South Quad",
  "Engineering Building",
  "Main Library",
  "West Campus",
  "Residence Commons",
  "Student Center",
  "Greenway Apartments",
  "Science Center",
  "East Dorm Row",
];

const titleSets: Record<string, string[]> = {
  Books: [
    "Intro Psychology Textbook",
    "Calculus Workbook",
    "Microeconomics Reader",
    "Business Strategy Notes",
    "Modern Literature Collection",
    "Physics Lab Manual",
    "Spanish Grammar Guide",
    "Writing Essentials Handbook",
    "History of Art Book",
    "Biology Study Set",
  ],
  Clothing: [
    "Vintage Hoodie",
    "Running Shorts",
    "Button-Up Shirt",
    "Campus Sweatshirt",
    "Flannel Shirt",
    "Athletic Leggings",
    "Denim Jacket",
    "Utility Tote",
    "Comfort Knit Sweater",
    "Leather Backpack",
  ],
  Electronics: [
    "Bluetooth Speaker",
    "USB-C Hub",
    "Laptop Stand",
    "Portable SSD",
    "Smartwatch Charger",
    "Projector",
    "Tablet Case",
    "Wireless Mouse",
    "Monitor Arm",
    "Ring Light",
  ],
  Furniture: [
    "Nightstand",
    "Bookshelf",
    "Futon Mat",
    "Folding Table",
    "Bean Bag Chair",
    "Small Coffee Table",
    "Window Bench",
    "Rolling Cart",
    "Standing Shelf",
    "Desk Organizer",
  ],
  "Dorm Essentials": [
    "String Lights",
    "Laundry Hamper",
    "Mini Fridge",
    "Hanging Shelves",
    "Water Filter Pitcher",
    "Desk Organizer Set",
    "Cotton Bedding Set",
    "Room Fan",
    "Under-Bed Storage",
    "Wall Mirror",
  ],
  "Sports & Outdoors": [
    "Running Shoes",
    "Hiking Backpack",
    "Cycling Helmet",
    "Tennis Racket",
    "Portable Cooler",
    "Fitness Bands",
    "Camping Stove",
    "Surfboard",
    "Golf Set",
    "Basketball",
  ],
  Other: [
    "Travel Mug",
    "Phone Stand",
    "Waterproof Tote",
    "Desk Clock",
    "Reusable Bottle",
    "Shoe Rack",
    "Umbrella",
    "Camera Tripod",
    "Desk Tray",
    "Study Planner",
  ],
};

const imageLibrary: Record<string, string[]> = {
  Books: [
    "https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1516979187457-637abb4f9353?auto=format&fit=crop&w=900&q=80",
  ],
  Clothing: [
    "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=80",
  ],
  Electronics: [
    "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=900&q=80",
  ],
  Furniture: [
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=900&q=80",
  ],
  "Dorm Essentials": [
    "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1516321165247-4aa89a48be28?auto=format&fit=crop&w=900&q=80",
  ],
  "Sports & Outdoors": [
    "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=900&q=80",
  ],
  Other: [
    "https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?auto=format&fit=crop&w=900&q=80",
  ],
};

function buildProductCatalog(total: number) {
  const entries: Array<{ title: string; category: string; price: number; originalPrice: number; description: string; location: string; images: string[] }> = [];

  for (let index = 0; index < total; index += 1) {
    const category = categoryNames[index % categoryNames.length];
    const title = titleSets[category][index % titleSets[category].length];
    const price = 12 + ((index * 13) % 140);
    const originalPrice = price + 8 + ((index * 7) % 40);
    const location = campusLocations[index % campusLocations.length];
    const description = index % 2 === 0
      ? `Great condition ${title.toLowerCase()} from a recent move-out. Includes original packaging and minimal wear.`
      : `Lightly used ${title.toLowerCase()} available for quick pickup near ${location}. Clean, functional, and ready for campus life.`;

    const imagePool = imageLibrary[category] ?? imageLibrary.Other;
    const images = [
      imagePool[index % imagePool.length],
      imagePool[(index + 1) % imagePool.length],
      imagePool[(index + 2) % imagePool.length],
    ];

    entries.push({ title, category, price, originalPrice, description, location, images });
  }

  return entries;
}

async function ensureSellerRecords() {
  const sellers = [] as Array<{ id: string; email: string; displayName: string }>;
  for (const sellerName of sellerNames) {
    const email = `${sellerName.toLowerCase().replace(/[^a-z]+/g, ".")}.${randomUUID().slice(0, 6)}@campusmarket.test`;
    const seller = await prisma.user.upsert({
      where: { email },
      update: { displayName: sellerName },
      create: {
        id: randomUUID(),
        email,
        displayName: sellerName,
        trustScore: 70,
      },
    });
    sellers.push({ id: seller.id, email: seller.email ?? email, displayName: seller.displayName ?? sellerName });
  }
  return sellers;
}

async function seed(): Promise<void> {
  for (const categoryName of categoryNames) {
    await prisma.category.upsert({
      where: { name: categoryName },
      update: {},
      create: { name: categoryName },
    });
  }

  const existingPosts = await prisma.post.count();
  const targetCount = Math.min(100, 100 - existingPosts);
  if (targetCount <= 0) {
    console.log(`Seed already contains ${existingPosts} listings. No new listings created.`);
    return;
  }

  const sellers = await ensureSellerRecords();
  const categories = await prisma.category.findMany();
  const categoryMap = new Map(categories.map((category) => [category.name, category]));
  const catalog = buildProductCatalog(targetCount);

  const batchSize = 8;
  let created = 0;

  for (let index = 0; index < catalog.length; index += batchSize) {
    const batch = catalog.slice(index, index + batchSize);
    await prisma.$transaction(async (tx) => {
      for (let innerIndex = 0; innerIndex < batch.length; innerIndex += 1) {
        const item = batch[innerIndex];
        const seller = sellers[(index + innerIndex) % sellers.length];
        const category = categoryMap.get(item.category);
        if (!category) continue;

        const post = await tx.post.create({
          data: {
            sellerId: seller.id,
            categoryId: category.id,
            title: item.title,
            description: item.description,
            price: item.price,
            originalPrice: item.originalPrice,
            locationCampus: item.location,
            quantityAvailable: 1 + ((index + innerIndex) % 4),
            status: "ACTIVE",
          },
        });

        await tx.listingImage.createMany({
          data: item.images.map((url, imageIndex) => ({
            postId: post.id,
            url,
            sortOrder: imageIndex,
          })),
        });

        if ((index + innerIndex) % 4 === 0) {
          await tx.auctionRoom.create({
            data: {
              postId: post.id,
              sellerId: seller.id,
              currentHighestBid: item.price * 0.8,
              reservePrice: item.price * 0.9,
              isPublic: true,
              status: "ACTIVE",
              endsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * (3 + ((index + innerIndex) % 5))),
            },
          }).catch(() => undefined);
        }

        created += 1;
      }
    }, {
      timeout: 60000,
      maxWait: 60000,
    });

    console.log(`Created ${Math.min(index + batch.length, catalog.length)} / ${catalog.length} listings.`);
  }

  console.log(`Seed complete: ${created} new listings created across ${sellers.length} sellers.`);
}

try {
  await seed();
} catch (error) {
  console.error("Seed failed:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}