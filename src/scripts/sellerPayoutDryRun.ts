import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import {
  buildSellerPayoutReconciliationRows,
  sellerPayoutReconciliationCsv,
} from "../services/sellerPayoutReconciliation.js";

function parseSinceArgument(arguments_: string[]): Date | undefined {
  if (arguments_.some((argument) => !argument.startsWith("--since=")) || arguments_.length > 1) {
    throw new Error("The only supported option is --since=YYYY-MM-DD.");
  }
  const sinceArgument = arguments_[0];
  if (!sinceArgument) return undefined;

  const dateText = sinceArgument.slice("--since=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error("Use --since=YYYY-MM-DD.");
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
    throw new Error("The --since date is not a valid calendar date.");
  }
  return date;
}

const connectionString = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
if (!connectionString) throw new Error("DATABASE_URL or DIRECT_URL must be configured.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  const since = parseSinceArgument(process.argv.slice(2));
  const items = await prisma.purchaseOrderItem.findMany({
    where: {
      order: {
        paymentReference: { not: null },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
    },
    orderBy: [{ order: { createdAt: "asc" } }, { orderId: "asc" }, { sellerId: "asc" }],
    select: {
      id: true,
      orderId: true,
      sellerId: true,
      quantity: true,
      unitPriceCents: true,
      sellerFeeCents: true,
      seller: {
        select: {
          displayName: true,
          sellerVerification: {
            select: {
              payoutStatus: true,
              bankName: true,
              bankAccountLast4: true,
              paystackRecipientCode: true,
            },
          },
        },
      },
      order: {
        select: {
          id: true,
          paymentReference: true,
          status: true,
          createdAt: true,
        },
      },
    },
  });

  const rows = buildSellerPayoutReconciliationRows(items);
  console.log(sellerPayoutReconciliationCsv(rows));
  const requiresReconciliation = rows.filter((row) => row.action === "RECONCILE_WITH_PAYSTACK_BEFORE_TRANSFER").length;
  console.error(
    `Dry run only: ${rows.length} seller/order rows; ${requiresReconciliation} require Paystack reconciliation. `
    + "No transfer status is stored in QuickResell, so do not initiate transfers from this report alone.",
  );
} finally {
  await prisma.$disconnect();
}
