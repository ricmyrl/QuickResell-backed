CREATE TABLE "SellerWithdrawal" (
  "id" TEXT NOT NULL,
  "sellerId" UUID NOT NULL,
  "walletId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "amountKobo" INTEGER NOT NULL,
  "recipientCode" TEXT NOT NULL,
  "transferReference" TEXT NOT NULL,
  "transferCode" TEXT,
  "status" "SellerPayoutStatus" NOT NULL DEFAULT 'PROCESSING',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "SellerWithdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerWithdrawal_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SellerWithdrawal_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SellerWithdrawalAllocation" (
  "id" TEXT NOT NULL,
  "withdrawalId" TEXT NOT NULL,
  "sellerPayoutId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerWithdrawalAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SellerWithdrawalAllocation_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "SellerWithdrawal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SellerWithdrawalAllocation_sellerPayoutId_fkey" FOREIGN KEY ("sellerPayoutId") REFERENCES "SellerPayout"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SellerWithdrawal_transferReference_key" ON "SellerWithdrawal"("transferReference");
CREATE INDEX "SellerWithdrawal_sellerId_status_createdAt_idx" ON "SellerWithdrawal"("sellerId", "status", "createdAt");
CREATE INDEX "SellerWithdrawal_status_updatedAt_idx" ON "SellerWithdrawal"("status", "updatedAt");
CREATE UNIQUE INDEX "SellerWithdrawalAllocation_withdrawalId_sellerPayoutId_key" ON "SellerWithdrawalAllocation"("withdrawalId", "sellerPayoutId");
CREATE INDEX "SellerWithdrawalAllocation_sellerPayoutId_createdAt_idx" ON "SellerWithdrawalAllocation"("sellerPayoutId", "createdAt");
