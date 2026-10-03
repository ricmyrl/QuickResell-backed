CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Wallet_balanceCents_nonnegative_check" CHECK ("balanceCents" >= 0)
);

CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "paymentReference" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paymentAmountKobo" INTEGER NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WalletTransaction_amountCents_positive_check" CHECK ("amountCents" > 0),
    CONSTRAINT "WalletTransaction_paymentAmountKobo_positive_check" CHECK ("paymentAmountKobo" > 0)
);

CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");
CREATE UNIQUE INDEX "WalletTransaction_paymentReference_key" ON "WalletTransaction"("paymentReference");
CREATE INDEX "WalletTransaction_walletId_status_createdAt_idx" ON "WalletTransaction"("walletId", "status", "createdAt");

ALTER TABLE "Wallet"
    ADD CONSTRAINT "Wallet_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletTransaction"
    ADD CONSTRAINT "WalletTransaction_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
