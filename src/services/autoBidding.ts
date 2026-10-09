import { Prisma, type AuctionRoom, type Bid, type BidStrategy as PrismaBidStrategy } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { calculateDynamicBidIncrement } from "./bidDynamicIncrements.js";
import { feeForAcceptedBid } from "./auctionPlatformFee.js";
import {
  evaluateAnalystStrategy,
  evaluateJumpBidStrategy,
  evaluateReserveTargetStrategy,
  evaluateSniperStrategy,
  evaluateStandardStrategy,
  resolveStandardBudgetTie,
  type BidStrategyMetadata,
  type MarketDataPayload,
  type StrategyEvaluation,
  type StrategyRoom,
} from "./bidStrategyEngine.js";
import { EventEmitter } from "node:events";

export const auctionEventBus = new EventEmitter();

export type AutoBidConfig = {
  antiSnipeWindowMs: number;
  antiSnipeExtensionMs: number;
};

const DEFAULT_CONFIG: AutoBidConfig = {
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 30_000,
};
let sniperScanInProgress = false;

export type AutoBidResult = {
  success: boolean;
  auctionRoom: AuctionRoom | null;
  bid: Bid | null;
  reason?: "ROOM_NOT_FOUND" | "AUCTION_INACTIVE" | "NO_ELIGIBLE_RULES" | "EQUILIBRIUM_REACHED" | "SNIPER_DORMANT" | "OVERPRICED_VS_MARKET";
};

type LockedAuctionContext = AuctionRoom & {
  postPrice: number;
  postTitle: string;
  categoryId: string;
  conditionScore: number;
};

async function lockAuctionContext(
  tx: Prisma.TransactionClient,
  auctionRoomId: string,
): Promise<LockedAuctionContext | null> {
  const rows = await tx.$queryRaw<LockedAuctionContext[]>`
    SELECT
      ar.*,
      p."price" AS "postPrice",
      p."title" AS "postTitle",
      p."categoryId" AS "categoryId",
      p."conditionScore" AS "conditionScore"
    FROM "AuctionRoom" ar
    INNER JOIN "Post" p ON p."id" = ar."postId"
    WHERE ar."id" = ${auctionRoomId}
    FOR UPDATE OF ar
  `;
  return rows[0] ?? null;
}

async function allEnabledRulesAreSniperDormant(auctionRoomId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{
    strategy: PrismaBidStrategy;
    sniperWindowSeconds: number;
    endsAt: Date;
    dbNow: Date;
  }>>`
    SELECT
      item."strategy",
      item."sniperWindowSeconds",
      room."endsAt",
      NOW() AS "dbNow"
    FROM "AuctionRoom" room
    INNER JOIN "AuctionWatchlistItem" item ON item."auctionRoomId" = room."id"
    INNER JOIN "User" account ON account."id" = item."userId"
    WHERE room."id" = ${auctionRoomId}
      AND room."status" = 'ACTIVE'
      AND room."endsAt" > NOW()
      AND item."autoBidEnabled" = true
      AND item."userId" <> room."sellerId"
      AND (account."biddingSuspendedUntil" IS NULL OR account."biddingSuspendedUntil" <= NOW())
  `;
  return rows.length > 0 && rows.every((row) =>
    row.strategy === "SNIPER"
    && row.sniperWindowSeconds >= 1
    && row.sniperWindowSeconds <= 3600
    && row.endsAt.getTime() - row.dbNow.getTime() > row.sniperWindowSeconds * 1000
  );
}

async function loadMarketData(
  tx: Prisma.TransactionClient,
  categoryId: string,
  conditionScore: number,
): Promise<MarketDataPayload> {
  const [sales] = await tx.$queryRaw<Array<{
    recordedSales90Days: bigint;
    fairMarketValue: number | null;
    recentVwap: number | null;
    previousVwap: number | null;
  }>>`
    SELECT
      COUNT(*) FILTER (
        WHERE orders."updatedAt" >= NOW() - INTERVAL '90 days'
      ) AS "recordedSales90Days",
      ((
        SUM(item."unitPriceCents"::numeric * item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '30 days'
        )
        / NULLIF(SUM(item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '30 days'
        ), 0)
      ) / 100.0)::double precision AS "fairMarketValue",
      (
        SUM(item."unitPriceCents"::numeric * item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '14 days'
        ) / NULLIF(SUM(item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '14 days'
        ), 0)
      )::double precision AS "recentVwap",
      (
        SUM(item."unitPriceCents"::numeric * item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '28 days'
            AND orders."updatedAt" < NOW() - INTERVAL '14 days'
        ) / NULLIF(SUM(item."quantity") FILTER (
          WHERE orders."updatedAt" >= NOW() - INTERVAL '28 days'
            AND orders."updatedAt" < NOW() - INTERVAL '14 days'
        ), 0)
      )::double precision AS "previousVwap"
    FROM "PurchaseOrderItem" item
    INNER JOIN "PurchaseOrder" orders ON orders."id" = item."orderId"
    INNER JOIN "Post" post ON post."id" = item."postId"
    WHERE post."categoryId" = ${categoryId}
      AND orders."status" = 'COMPLETED'
      AND item."fulfillmentStatus" = 'COMPLETED'
      AND orders."updatedAt" >= NOW() - INTERVAL '90 days'
  `;
  const previous = sales?.previousVwap;
  const recent = sales?.recentVwap;
  const trend = recent !== null && previous !== null && previous > 0
    ? Math.max(-0.3, Math.min(0.3, recent / previous - 1))
    : 0;
  return {
    fairMarketValue: sales?.fairMarketValue ?? null,
    recordedSales90Days: Number(sales?.recordedSales90Days ?? 0n),
    conditionScore,
    momentumAlpha: trend,
    marginOfSafety: 0,
  };
}

function bidMetadata(value: Prisma.JsonValue | null): BidStrategyMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: BidStrategyMetadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number") result[key] = item;
  }
  return result;
}

export async function processAuctionAutoBid(
  auctionRoomId: string,
  config: AutoBidConfig = DEFAULT_CONFIG,
): Promise<AutoBidResult> {
  if (await allEnabledRulesAreSniperDormant(auctionRoomId)) {
    return { success: true, reason: "SNIPER_DORMANT", auctionRoom: null, bid: null };
  }

  const domainEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const transactionResult = await prisma.$transaction(
    async (tx) => {
      const room = await lockAuctionContext(tx, auctionRoomId);
      if (!room) {
        return { success: false, reason: "ROOM_NOT_FOUND" as const, auctionRoom: null, bid: null };
      }
      const [{ dbNow }] = await tx.$queryRaw<[{ dbNow: Date }]>`SELECT NOW() AS "dbNow"`;
      if (room.status !== "ACTIVE" || room.endsAt <= dbNow) {
        return { success: false, reason: "AUCTION_INACTIVE" as const, auctionRoom: room, bid: null };
      }

      const rules = await tx.auctionWatchlistItem.findMany({
        where: {
          auctionRoomId,
          autoBidEnabled: true,
          userId: { not: room.sellerId },
          user: {
            OR: [
              { biddingSuspendedUntil: null },
              { biddingSuspendedUntil: { lte: dbNow } },
            ],
          },
        },
        include: { user: { select: { biddingSuspendedUntil: true } } },
      });
      if (rules.length === 0) {
        return { success: true, reason: "NO_ELIGIBLE_RULES" as const, auctionRoom: room, bid: null };
      }

      const previousBid = await tx.bid.findFirst({
        where: { auctionRoomId },
        orderBy: { sequence: "desc" },
        select: { sequence: true, bidderId: true, strategyMetadata: true },
      });
      const strategyRoom: StrategyRoom = {
        currentHighestBid: room.currentHighestBid,
        startingPrice: room.postPrice,
        highestBidderId: room.highestBidderId,
        endsAt: room.endsAt,
        reservePrice: room.reservePrice,
      };
      let velocityBidsPerMinute: number | null = null;
      if (room.incrementCurve === "MARKET_SIGMOID") {
        const [velocity] = await tx.$queryRaw<Array<{ velocityBidsPerMinute: number | null }>>`
          SELECT COUNT(*)::double precision / 5.0 AS "velocityBidsPerMinute"
          FROM "Bid"
          WHERE "auctionRoomId" = ${auctionRoomId}
            AND "createdAt" >= NOW() - INTERVAL '5 minutes'
        `;
        velocityBidsPerMinute = velocity?.velocityBidsPerMinute ?? null;
      }
      const increment = calculateDynamicBidIncrement({
        currentBid: room.currentHighestBid,
        curve: room.incrementCurve,
        alphaParam: room.curveAlphaParam,
        gammaParam: room.curveGammaParam,
        velocityBidsPerMinute,
      });
      const analystRules = rules.filter((rule) => rule.strategy === "ANALYST");
      const marketData = analystRules.length > 0
        ? await loadMarketData(tx, room.categoryId, room.conditionScore)
        : null;

      const evaluations = rules.map((rule) => {
        let evaluation: StrategyEvaluation;
        switch (rule.strategy) {
          case "JUMP_BID":
            evaluation = evaluateJumpBidStrategy(strategyRoom, rule, previousBid
              ? { bidderId: previousBid.bidderId, metadata: bidMetadata(previousBid.strategyMetadata) }
              : null, increment.increment);
            break;
          case "SNIPER":
            evaluation = evaluateSniperStrategy(strategyRoom as StrategyRoom & { endsAt: Date }, rule, dbNow, increment.increment);
            break;
          case "RESERVE_TARGET":
            evaluation = evaluateReserveTargetStrategy(strategyRoom, { reservePrice: room.reservePrice }, rule, increment.increment);
            break;
          case "ANALYST":
            evaluation = evaluateAnalystStrategy(
              strategyRoom,
              rule,
              marketData ? { ...marketData, marginOfSafety: rule.marginOfSafety } : null,
              increment.increment,
            );
            if (evaluation.reason === "INSUFFICIENT_MARKET_DATA") {
              console.warn("Analyst strategy is using standard bidding because market sales data is insufficient.", {
                auctionRoomId,
                ruleId: rule.id,
                reason: "INSUFFICIENT_MARKET_DATA",
              });
            }
            break;
          default:
            evaluation = evaluateStandardStrategy(strategyRoom, rule, increment.increment);
        }
        return { rule, evaluation };
      });

      const disabledIds = evaluations
        .filter(({ evaluation }) => evaluation.action === "DISABLE")
        .map(({ rule }) => rule.id);
      if (disabledIds.length > 0) {
        await tx.auctionWatchlistItem.updateMany({
          where: { id: { in: disabledIds } },
          data: { autoBidEnabled: false },
        });
      }

      const forcedTieAmounts = new Map<string, number>();
      const tiedDisabledIds = new Set<string>();
      const standardByBudget = new Map<number, typeof rules>();
      for (const rule of rules.filter((item) => item.strategy === "STANDARD")) {
        const group = standardByBudget.get(rule.maxBid) ?? [];
        group.push(rule);
        standardByBudget.set(rule.maxBid, group);
      }
      for (const group of standardByBudget.values()) {
        if (group.length < 2) continue;
        const tie = resolveStandardBudgetTie(group);
        if (!tie) continue;
        tie.disabledRuleIds.forEach((id) => tiedDisabledIds.add(id));
        await tx.auctionWatchlistItem.updateMany({
          where: { id: { in: tie.disabledRuleIds } },
          data: { autoBidEnabled: false },
        });
        const winnerEvaluation = evaluations.find(({ rule }) => rule.id === tie.winner.id)?.evaluation;
        if (winnerEvaluation?.action === "BID") {
          forcedTieAmounts.set(tie.winner.id, tie.amount);
        }
      }

      const candidates = evaluations.filter(({ rule, evaluation }) =>
        evaluation.action === "BID"
        && !disabledIds.includes(rule.id)
        && !tiedDisabledIds.has(rule.id)
      );
      const selected = candidates.sort((left, right) => {
        const leftAmount = forcedTieAmounts.get(left.rule.id) ?? left.evaluation.amount!;
        const rightAmount = forcedTieAmounts.get(right.rule.id) ?? right.evaluation.amount!;
        if (rightAmount !== leftAmount) return rightAmount - leftAmount;
        if (right.rule.maxBid !== left.rule.maxBid) return right.rule.maxBid - left.rule.maxBid;
        if (right.rule.userId === room.highestBidderId) return 1;
        if (left.rule.userId === room.highestBidderId) return -1;
        return left.rule.createdAt.getTime() - right.rule.createdAt.getTime()
          || left.rule.id.localeCompare(right.rule.id);
      })[0];
      if (!selected) {
        const dormant = evaluations.length > 0
          && evaluations.every(({ evaluation }) => evaluation.reason === "SNIPER_DORMANT");
        const analystRejected = evaluations.some(({ evaluation }) => evaluation.reason === "OVERPRICED_VS_MARKET");
        return {
          success: true,
          reason: analystRejected
            ? "OVERPRICED_VS_MARKET" as const
            : dormant ? "SNIPER_DORMANT" as const : "EQUILIBRIUM_REACHED" as const,
          auctionRoom: room,
          bid: null,
        };
      }

      const amount = forcedTieAmounts.get(selected.rule.id) ?? selected.evaluation.amount!;
      if (amount <= room.currentHighestBid) {
        return { success: true, reason: "EQUILIBRIUM_REACHED" as const, auctionRoom: room, bid: null };
      }
      const sequence = (previousBid?.sequence ?? 0) + 1;
      const incrementAmountCents = Math.round((amount - room.currentHighestBid + Number.EPSILON) * 100);
      const feeCents = room.platformFeeEnabled ? feeForAcceptedBid(sequence, incrementAmountCents) : 0;
      const bid = await tx.bid.create({
        data: {
          auctionRoomId,
          bidderId: selected.rule.userId,
          sequence,
          amount,
          incrementAmountCents,
          strategyMetadata: {
            ...(selected.evaluation.metadata ?? { strategy: selected.rule.strategy }),
            incrementCurve: increment.curveUsed,
            incrementAmount: increment.increment,
            incrementFallback: increment.usedFallback,
          } as Prisma.InputJsonValue,
        },
      });

      await tx.auctionWatchlistItem.updateMany({
        where: {
          auctionRoomId,
          autoBidEnabled: true,
          maxBid: { lte: amount },
        },
        data: { autoBidEnabled: false },
      });

      const timeRemainingMs = room.endsAt.getTime() - dbNow.getTime();
      const needsAntiSnipeExtension = timeRemainingMs <= config.antiSnipeWindowMs;
      const updatedEndsAt = needsAntiSnipeExtension
        ? new Date((selected.rule.strategy === "SNIPER" ? dbNow.getTime() : room.endsAt.getTime()) + config.antiSnipeExtensionMs)
        : room.endsAt;
      const updatedRoom = await tx.auctionRoom.update({
        where: { id: auctionRoomId },
        data: {
          currentHighestBid: amount,
          platformFeeCents: room.platformFeeCents + feeCents,
          highestBidderId: selected.rule.userId,
          endsAt: updatedEndsAt,
        },
      });

      await tx.cartItem.upsert({
        where: { userId_postId: { userId: selected.rule.userId, postId: room.postId } },
        create: { userId: selected.rule.userId, postId: room.postId, auctionRoomId },
        update: { auctionRoomId, quantity: 1 },
      });
      if (room.highestBidderId && room.highestBidderId !== selected.rule.userId) {
        await tx.cartItem.deleteMany({
          where: { userId: room.highestBidderId, auctionRoomId },
        });
      }
      domainEvents.push({
        type: "AUCTION_AUTO_BID_PLACED",
        payload: {
          auctionRoomId,
          postId: room.postId,
          postTitle: room.postTitle,
          winningBid: bid,
          sellerId: room.sellerId,
          winningBidderId: selected.rule.userId,
          outbidUserIds: room.highestBidderId && room.highestBidderId !== selected.rule.userId
            ? [room.highestBidderId]
            : [],
          extendedEndsAt: needsAntiSnipeExtension ? updatedEndsAt : null,
        },
      });
      return { success: true, auctionRoom: updatedRoom, bid };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
  );

  if (transactionResult.success && domainEvents.length > 0) {
    for (const event of domainEvents) auctionEventBus.emit(event.type, event.payload);
  }
  return {
    success: transactionResult.success,
    auctionRoom: transactionResult.auctionRoom,
    bid: transactionResult.bid,
    reason: transactionResult.reason,
  };
}

export async function processDueSniperBids(): Promise<void> {
  if (sniperScanInProgress) return;
  sniperScanInProgress = true;
  try {
    const dueRooms = await prisma.$queryRaw<Array<{ auctionRoomId: string }>>`
      SELECT DISTINCT item."auctionRoomId"
      FROM "AuctionWatchlistItem" item
      INNER JOIN "AuctionRoom" room ON room."id" = item."auctionRoomId"
      INNER JOIN "User" account ON account."id" = item."userId"
      WHERE item."autoBidEnabled" = true
        AND item."strategy" = 'SNIPER'
        AND room."status" = 'ACTIVE'
        AND room."endsAt" > NOW()
        AND room."endsAt" <= NOW() + item."sniperWindowSeconds" * INTERVAL '1 second'
        AND (account."biddingSuspendedUntil" IS NULL OR account."biddingSuspendedUntil" <= NOW())
      ORDER BY item."auctionRoomId"
    `;
    for (let offset = 0; offset < dueRooms.length; offset += 20) {
      const batch = dueRooms.slice(offset, offset + 20);
      const results = await Promise.allSettled(
        batch.map(({ auctionRoomId }) => processAuctionAutoBid(auctionRoomId)),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error("Scheduled sniper evaluation failed.", {
            auctionRoomId: batch[index].auctionRoomId,
            error: result.reason,
          });
        }
      });
    }
  } finally {
    sniperScanInProgress = false;
  }
}
