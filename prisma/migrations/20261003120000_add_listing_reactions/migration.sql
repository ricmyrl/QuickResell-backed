CREATE TYPE "ListingReactionType" AS ENUM ('LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY');

CREATE TABLE "ListingReaction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ListingReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ListingReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ListingReaction_postId_userId_key"
    ON "ListingReaction"("postId", "userId");
CREATE INDEX "ListingReaction_postId_type_idx"
    ON "ListingReaction"("postId", "type");
CREATE INDEX "ListingReaction_userId_createdAt_idx"
    ON "ListingReaction"("userId", "createdAt");

ALTER TABLE "ListingReaction"
    ADD CONSTRAINT "ListingReaction_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListingReaction"
    ADD CONSTRAINT "ListingReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
