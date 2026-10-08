CREATE TYPE "PasskeyChallengePurpose" AS ENUM ('REGISTRATION', 'AUTHENTICATION');

ALTER TABLE "User"
ADD COLUMN "passkeyVerifiedUntil" TIMESTAMP(3);

CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasskeyChallenge" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" "PasskeyChallengePurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");
CREATE INDEX "PasskeyCredential_userId_createdAt_idx" ON "PasskeyCredential"("userId", "createdAt");
CREATE UNIQUE INDEX "PasskeyChallenge_challenge_key" ON "PasskeyChallenge"("challenge");
CREATE INDEX "PasskeyChallenge_userId_purpose_expiresAt_idx" ON "PasskeyChallenge"("userId", "purpose", "expiresAt");

ALTER TABLE "PasskeyCredential"
ADD CONSTRAINT "PasskeyCredential_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasskeyChallenge"
ADD CONSTRAINT "PasskeyChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
