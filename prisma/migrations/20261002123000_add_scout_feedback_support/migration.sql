CREATE TABLE "ScoutFeedback" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "intent" TEXT,
    "helpful" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoutFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutFeedback_userId_messageId_key"
    ON "ScoutFeedback"("userId", "messageId");
CREATE INDEX "ScoutFeedback_intent_helpful_createdAt_idx"
    ON "ScoutFeedback"("intent", "helpful", "createdAt");
ALTER TABLE "ScoutFeedback"
    ADD CONSTRAINT "ScoutFeedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupportRequest" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportRequest_userId_createdAt_idx"
    ON "SupportRequest"("userId", "createdAt");
CREATE INDEX "SupportRequest_status_createdAt_idx"
    ON "SupportRequest"("status", "createdAt");
ALTER TABLE "SupportRequest"
    ADD CONSTRAINT "SupportRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;