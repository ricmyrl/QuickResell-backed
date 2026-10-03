import { ListingReactionType } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export type ListingReactionCounts = Record<ListingReactionType, number>;

export function emptyListingReactionCounts(): ListingReactionCounts {
  return Object.fromEntries(
    Object.values(ListingReactionType).map((type) => [type, 0]),
  ) as ListingReactionCounts;
}

export async function getListingReactionCounts(postIds: string[]): Promise<Map<string, ListingReactionCounts>> {
  const countsByPost = new Map<string, ListingReactionCounts>();
  if (postIds.length === 0) return countsByPost;

  const groupedReactions = await prisma.listingReaction.groupBy({
    by: ["postId", "type"],
    where: { postId: { in: postIds } },
    _count: { _all: true },
  });

  for (const { postId, type, _count } of groupedReactions) {
    const counts = countsByPost.get(postId) ?? emptyListingReactionCounts();
    counts[type] = _count._all;
    countsByPost.set(postId, counts);
  }
  return countsByPost;
}
