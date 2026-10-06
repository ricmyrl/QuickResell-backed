CREATE TYPE "SellerCheckStatus" AS ENUM (
  'NOT_STARTED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'REVIEW_REQUIRED'
);

CREATE TABLE "SellerVerification" (
  "id" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "identityStatus" "SellerCheckStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "payoutStatus" "SellerCheckStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "identityReference" TEXT,
  "identityJobId" TEXT,
  "smileUserId" TEXT,
  "verifiedNameHash" TEXT,
  "bankCode" TEXT,
  "bankName" TEXT,
  "bankAccountLast4" TEXT,
  "failureCode" TEXT,
  "identityVerifiedAt" TIMESTAMP(3),
  "payoutVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerVerification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SellerVerification_userId_key" ON "SellerVerification"("userId");
CREATE UNIQUE INDEX "SellerVerification_identityReference_key" ON "SellerVerification"("identityReference");
CREATE UNIQUE INDEX "SellerVerification_identityJobId_key" ON "SellerVerification"("identityJobId");
CREATE INDEX "SellerVerification_identityStatus_payoutStatus_idx"
  ON "SellerVerification"("identityStatus", "payoutStatus");