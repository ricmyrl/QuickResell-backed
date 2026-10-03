CREATE TABLE "ProductComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "content" VARCHAR(1000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductComment_postId_createdAt_idx"
    ON "ProductComment"("postId", "createdAt");
CREATE INDEX "ProductComment_userId_createdAt_idx"
    ON "ProductComment"("userId", "createdAt");

ALTER TABLE "ProductComment"
    ADD CONSTRAINT "ProductComment_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductComment"
    ADD CONSTRAINT "ProductComment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
