CREATE TABLE "ProductCommentReaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCommentReaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductComment"
    ADD COLUMN "parentId" TEXT;

CREATE INDEX "ProductComment_parentId_createdAt_idx"
    ON "ProductComment"("parentId", "createdAt");
CREATE UNIQUE INDEX "ProductCommentReaction_commentId_userId_key"
    ON "ProductCommentReaction"("commentId", "userId");
CREATE INDEX "ProductCommentReaction_userId_createdAt_idx"
    ON "ProductCommentReaction"("userId", "createdAt");

ALTER TABLE "ProductComment"
    ADD CONSTRAINT "ProductComment_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "ProductComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCommentReaction"
    ADD CONSTRAINT "ProductCommentReaction_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "ProductComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCommentReaction"
    ADD CONSTRAINT "ProductCommentReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
