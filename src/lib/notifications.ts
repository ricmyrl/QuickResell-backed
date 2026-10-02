import { prisma } from "./prisma.js";

export type NotificationType =
  | "BID_PLACED"
  | "OUTBID"
  | "AUCTION_WON"
  | "AUCTION_CLOSED"
  | "PRICE_UPDATED"
  | "LISTING_SOLD"
  | "REVIEW"
  | "REPLY"
  | "ORDER_UPDATE";

export async function createNotification({
  userId,
  type,
  title,
  message,
  entityType,
  entityId,
}: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}) {
  if (!userId) return null;

  return prisma.notification.create({
    data: {
      userId,
      type,
      title,
      message,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
    },
  });
}

export async function createNotificationsForUsers(entries: Array<{
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
}>) {
  const validEntries = entries.filter((entry) => entry.userId && entry.userId.trim().length > 0);
  if (validEntries.length === 0) return [];

  return prisma.notification.createMany({
    data: validEntries.map((entry) => ({
      userId: entry.userId,
      type: entry.type,
      title: entry.title,
      message: entry.message,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
    })),
  });
}

export async function notifyBidActivity({
  auctionRoomId,
  auctionTitle,
  sellerId,
  previousBidderId,
  bidderId,
  amount,
}: {
  auctionRoomId: string;
  auctionTitle: string;
  sellerId: string;
  previousBidderId?: string | null;
  bidderId: string;
  amount: number;
}) {
  const notifications: Array<{
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    entityType: string;
    entityId: string;
  }> = [];

  if (previousBidderId && previousBidderId !== bidderId) {
    notifications.push({
      userId: previousBidderId,
      type: "OUTBID",
      title: "You were outbid",
      message: `Someone raised the price on “${auctionTitle}” to $${amount.toFixed(2)}.`,
      entityType: "auction",
      entityId: auctionRoomId,
    });
  }

  notifications.push({
    userId: sellerId,
    type: "BID_PLACED",
    title: "New bid received",
    message: `${auctionTitle} received a new bid at $${amount.toFixed(2)}.`,
    entityType: "auction",
    entityId: auctionRoomId,
  });

  if (notifications.length > 0) {
    await createNotificationsForUsers(notifications);
  }
}

export async function notifyAuctionResolution({
  userId,
  auctionRoomId,
  auctionTitle,
  type,
  finalPrice,
  reason,
}: {
  userId: string;
  auctionRoomId: string;
  auctionTitle: string;
  type: "AUCTION_WON" | "AUCTION_CLOSED" | "LISTING_SOLD" | "PRICE_UPDATED";
  finalPrice: number;
  reason?: string;
}) {
  const titleMap = {
    AUCTION_WON: "You won the auction",
    AUCTION_CLOSED: "Auction closed",
    LISTING_SOLD: "Your item sold",
    PRICE_UPDATED: "Price update",
  } satisfies Record<typeof type, string>;

  const messageMap = {
    AUCTION_WON: `You won “${auctionTitle}” for $${finalPrice.toFixed(2)}.`,
    AUCTION_CLOSED: `The auction for “${auctionTitle}” closed at $${finalPrice.toFixed(2)}${reason ? ` (${reason})` : ""}.`,
    LISTING_SOLD: `“${auctionTitle}” sold for $${finalPrice.toFixed(2)}.`,
    PRICE_UPDATED: `The asking price for “${auctionTitle}” changed to $${finalPrice.toFixed(2)}${reason ? ` (${reason})` : ""}.`,
  } satisfies Record<typeof type, string>;

  await createNotification({
    userId,
    type,
    title: titleMap[type],
    message: messageMap[type],
    entityType: "auction",
    entityId: auctionRoomId,
  });
}
