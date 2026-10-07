import { randomUUID } from "node:crypto";
import axios from "axios";
import { Router, type Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";
import { prisma } from "../lib/prisma.js";
import { createPaystackTransferRecipient, normalizeNigerianIdentityNumber, normalizePaystackBanks, validatePaystackIdentityAndBankAccount } from "../services/paystack.js";
import { getPaystackSecretKey } from "../services/paystack.js";
import {
  getSellerVerificationProvider,
  getSmileConfiguration,
  getSmileJobStatus,
  hashPayoutNameMatches,
  hashVerifiedName,
  isValidSmileWebhookSignature,
  mintSmileToken,
} from "../services/sellerVerification.js";

const router = Router();
const nameHashSecret = () => {
  const secret = process.env.SELLER_VERIFICATION_HASH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("SELLER_VERIFICATION_HASH_SECRET must be configured with at least 32 characters.");
  return secret;
};

let cachedBanks: Array<{ name: string; code: string }> = [];
let banksLoadedAt = 0;

function currentUser(request: Request): User {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

router.post("/seller/verification/smile-webhook", async (request, response) => {
  let configuration;
  try {
    configuration = getSmileConfiguration();
  } catch (error) {
    console.error("Smile ID webhook configuration is unavailable.", error);
    response.status(503).json({ error: "Seller verification is temporarily unavailable." });
    return;
  }

  const timestamp = request.header("response-timestamp");
  const signature = request.header("response-signature");
  if (!isValidSmileWebhookSignature(timestamp, signature, configuration)) {
    response.status(401).json({ error: "Invalid Smile ID webhook signature." });
    return;
  }

  const payload = request.body as {
    status?: unknown;
    product?: unknown;
    job_id?: unknown;
    partner_params?: { internal_reference?: unknown; user_id?: unknown } | null;
    id_fields?: { full_name?: unknown } | null;
    antifraud?: { summary?: { fraud_detected?: unknown }; smile_secure?: { status?: unknown } | null } | null;
  };
  const reference = payload.partner_params?.internal_reference;
  const jobId = request.header("job-id") ?? payload.job_id;
  const smileUserId = request.header("user-id") ?? payload.partner_params?.user_id;
  if (typeof reference !== "string" || typeof jobId !== "string" || typeof smileUserId !== "string" || payload.product !== "biometric_kyc") {
    response.status(400).json({ error: "Smile ID webhook is missing verification correlation data." });
    return;
  }

  const verification = await prisma.sellerVerification.findUnique({ where: { identityReference: reference } });
  if (!verification || verification.identityStatus !== "PENDING") {
    response.status(200).json({ received: true });
    return;
  }
  if ((verification.identityJobId && verification.identityJobId !== jobId) ||
      (verification.smileUserId && verification.smileUserId !== smileUserId)) {
    response.status(409).json({ error: "Smile ID job does not match the pending seller verification." });
    return;
  }

  let authoritativeStatus: Awaited<ReturnType<typeof getSmileJobStatus>>;
  try {
    authoritativeStatus = await getSmileJobStatus(configuration, jobId);
  } catch (error) {
    console.error("Could not confirm Smile ID verification status.", { jobId, error });
    response.status(503).json({ error: "Could not confirm seller verification; retry the webhook." });
    return;
  }
  if (authoritativeStatus.job_id !== jobId || authoritativeStatus.user_id !== smileUserId) {
    response.status(409).json({ error: "Smile ID job status did not match the callback." });
    return;
  }
  if (!['clear', 'attention', 'block', 'error'].includes(authoritativeStatus.status)) {
    response.status(503).json({ error: "Smile ID verification is not complete; retry the webhook." });
    return;
  }

  const fraudDetected = payload.antifraud?.summary?.fraud_detected === true;
  const duplicateIdentity = payload.antifraud?.smile_secure?.status === "attention";
  let identityStatus: "VERIFIED" | "REJECTED" | "REVIEW_REQUIRED";
  let verifiedNameHash: string | null = null;
  if (authoritativeStatus.status === "clear" && !fraudDetected && !duplicateIdentity && typeof payload.id_fields?.full_name === "string") {
    try {
      verifiedNameHash = hashVerifiedName(payload.id_fields.full_name, nameHashSecret());
      identityStatus = "VERIFIED";
    } catch {
      identityStatus = "REVIEW_REQUIRED";
    }
  } else if (authoritativeStatus.status === "attention" || fraudDetected || duplicateIdentity) {
    identityStatus = "REVIEW_REQUIRED";
  } else {
    identityStatus = "REJECTED";
  }

  const updated = await prisma.sellerVerification.updateMany({
    where: {
      id: verification.id,
      identityStatus: "PENDING",
      identityReference: reference,
      AND: [
        { OR: [{ identityJobId: null }, { identityJobId: jobId }] },
        { OR: [{ smileUserId: null }, { smileUserId }] },
      ],
    },
    data: {
      identityStatus,
      identityJobId: jobId,
      smileUserId,
      verifiedNameHash,
      identityVerifiedAt: identityStatus === "VERIFIED" ? new Date() : null,
      failureCode: identityStatus === "VERIFIED" ? null : authoritativeStatus.status.toUpperCase(),
    },
  });
  if (updated.count === 0) {
    response.status(200).json({ received: true });
    return;
  }
  response.status(200).json({ received: true });
});

router.use("/seller/verification", requireSupabaseUser, requireConfirmedEmail);

router.get("/seller/verification", async (request, response) => {
  const user = currentUser(request);
  const verification = await prisma.sellerVerification.findUnique({ where: { userId: user.id } });
  response.json({ provider: getSellerVerificationProvider(), verification: verification ? {
    identityStatus: verification.identityStatus,
    payoutStatus: verification.payoutStatus,
    identityVerifiedAt: verification.identityVerifiedAt,
    payoutVerifiedAt: verification.payoutVerifiedAt,
    bankName: verification.bankName,
    bankAccountLast4: verification.bankAccountLast4,
    failureCode: verification.failureCode,
  } : null });
});

router.get("/seller/verification/banks", async (_request, response) => {
  if (cachedBanks.length && Date.now() - banksLoadedAt < 24 * 60 * 60 * 1000) {
    response.json({ banks: cachedBanks });
    return;
  }
  try {
    const result = await axios.get<{
      status?: unknown;
      data?: Array<{ name?: unknown; code?: unknown; active?: unknown }>;
    }>(
      "https://api.paystack.co/bank",
      { params: { country: "nigeria" }, timeout: 15_000 },
    );
    if (result.data.status !== true || !Array.isArray(result.data.data)) {
      throw new Error("Paystack returned an invalid Nigerian bank list.");
    }
    cachedBanks = normalizePaystackBanks(result.data.data);
    banksLoadedAt = Date.now();
    response.json({ banks: cachedBanks });
  } catch (error) {
    console.error("Paystack bank list could not be loaded.", error);
    response.status(502).json({ error: "Nigerian banks could not be loaded. Please retry." });
  }
});

router.post("/seller/verification/identity/start", async (request, response) => {
  const user = currentUser(request);
  if (request.body?.consent !== true) {
    response.status(400).json({ error: "Consent to identity verification is required to continue." });
    return;
  }

  const provider = getSellerVerificationProvider();
  if (provider === "paystack") {
    const existing = await prisma.sellerVerification.findUnique({ where: { userId: user.id } });
    if (existing?.identityStatus === "VERIFIED" && existing.payoutStatus === "VERIFIED") {
      response.status(409).json({ error: "Your identity and payout account are already verified." });
      return;
    }
    response.json({
      provider: "paystack",
      reference: randomUUID(),
      requiresManualReview: false,
      autoApproved: false,
      message: "Paystack will validate your NIN or BVN together with your legal name and payout account.",
    });
    return;
  }

  let configuration;
  let token: string;
  try {
    configuration = getSmileConfiguration();
    token = await mintSmileToken(configuration);
  } catch (error) {
    console.error("Smile ID verification could not be initialized.", error);
    response.status(503).json({ error: "Identity verification is not configured. Please contact support." });
    return;
  }

  const existing = await prisma.sellerVerification.findUnique({ where: { userId: user.id } });
  if (existing?.identityStatus === "VERIFIED") {
    response.status(409).json({ error: "Your identity is already verified." });
    return;
  }
  const reference = randomUUID();
  await prisma.sellerVerification.upsert({
    where: { userId: user.id },
    create: { userId: user.id, identityStatus: "PENDING", identityReference: reference },
    update: {
      identityStatus: "PENDING",
      payoutStatus: "NOT_STARTED",
      identityReference: reference,
      identityJobId: null,
      smileUserId: null,
      verifiedNameHash: null,
      bankCode: null,
      bankName: null,
      bankAccountLast4: null,
      failureCode: null,
      identityVerifiedAt: null,
      payoutVerifiedAt: null,
    },
  });
  response.json({
    provider: "smile",
    reference,
    token,
    environment: configuration.environment,
    callbackUrl: configuration.callbackUrl,
    partnerDetails: {
      partner_id: configuration.partnerId,
      name: configuration.partnerName,
      logo_url: configuration.logoUrl,
      policy_url: configuration.privacyPolicyUrl,
      theme_color: configuration.themeColor,
    },
    idSelection: { NG: ["NIN", "BVN"] },
    partnerParams: { internal_reference: reference },
  });
});

router.post("/seller/verification/identity/manual-review", async (request, response) => {
  const user = currentUser(request);
  if (getSellerVerificationProvider() !== "paystack") {
    response.status(409).json({ error: "Paystack identity verification is not the active verification provider." });
    return;
  }
  const legalName = request.body?.legalName;
  const idType = request.body?.idType;
  const idNumber = request.body?.idNumber;
  const bankCode = request.body?.bankCode;
  const accountNumber = request.body?.accountNumber;
  if (request.body?.consent !== true) {
    response.status(400).json({ error: "Consent to manual identity review is required to continue." });
    return;
  }
  if (typeof legalName !== "string" || !legalName.trim()) {
    response.status(400).json({ error: "Provide the name matching your legal identity document." });
    return;
  }
  if (idType !== "NIN" && idType !== "BVN") {
    response.status(400).json({ error: "Paystack verification supports a Nigerian NIN or BVN. Use Smile ID for passports." });
    return;
  }
  if (typeof idNumber !== "string" || !idNumber.trim()) {
    response.status(400).json({ error: `Enter your ${idType} number to continue.` });
    return;
  }
  if (typeof bankCode !== "string" || !/^\d{3,6}$/.test(bankCode) ||
      typeof accountNumber !== "string" || !/^\d{10}$/.test(accountNumber)) {
    response.status(400).json({ error: "Choose a bank and enter its 10-digit account number to validate your identity." });
    return;
  }
  const existing = await prisma.sellerVerification.findUnique({ where: { userId: user.id } });
  if (existing?.identityStatus === "VERIFIED" && existing.payoutStatus === "VERIFIED") {
    response.status(409).json({ error: "Your identity and payout account are already verified." });
    return;
  }

  let hashSecret: string;
  try {
    normalizeNigerianIdentityNumber(idType, idNumber);
    hashSecret = nameHashSecret();
  } catch (error) {
    const configurationError = error instanceof Error && /SELLER_VERIFICATION_HASH_SECRET/.test(error.message);
    const message = error instanceof Error ? error.message : "This identity document could not be validated.";
    response.status(configurationError ? 503 : 422).json({ error: message });
    return;
  }

  try {
    await validatePaystackIdentityAndBankAccount({
      legalName: legalName.trim(),
      idType,
      idNumber,
      accountNumber,
    });
  } catch (error) {
    const status = axios.isAxiosError(error) && error.response?.status
      ? (error.response.status === 401 || error.response.status === 403 ? 503 : error.response.status < 500 ? 422 : 502)
      : error instanceof Error && /SELLER_VERIFICATION_HASH_SECRET|PAYSTACK_SECRET_KEY/.test(error.message)
        ? 503
        : error instanceof Error && /could not validate/i.test(error.message)
          ? 422
          : 502;
    console.error("Paystack identity check failed.", {
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
      code: axios.isAxiosError(error) ? error.code : undefined,
    });
    response.status(status).json({
      error: status === 422
        ? `Paystack could not validate this ${idType} and bank account. Check the details and try again.`
        : "Paystack identity validation is temporarily unavailable. Please retry.",
    });
    return;
  }

  try {
    const secretKey = getPaystackSecretKey();
    const resolved = await axios.get<{ status?: boolean; data?: { account_name?: unknown; account_number?: unknown } }>(
      "https://api.paystack.co/bank/resolve",
      { headers: { Authorization: `Bearer ${secretKey}` }, params: { account_number: accountNumber, bank_code: bankCode }, timeout: 15_000 },
    );
    const accountName = resolved.data.data?.account_name;
    if (resolved.data.status !== true || typeof accountName !== "string" || resolved.data.data?.account_number !== accountNumber) {
      response.status(422).json({ error: "Paystack could not verify this bank account." });
      return;
    }
    if (!hashPayoutNameMatches(accountName, hashVerifiedName(legalName, hashSecret), hashSecret)) {
      response.status(422).json({ error: "The account holder name does not match your legal identity. Use an account in your own name." });
      return;
    }

    const bank = cachedBanks.find((item) => item.code === bankCode);
    const recipient = await createPaystackTransferRecipient({ name: accountName, accountNumber, bankCode });
    const now = new Date();
    const reference = randomUUID();
    const verifiedNameHash = hashVerifiedName(legalName, hashSecret);
    await prisma.sellerVerification.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        identityStatus: "VERIFIED",
        payoutStatus: "VERIFIED",
        identityReference: reference,
        verifiedNameHash,
        identityVerifiedAt: now,
        bankCode,
        bankName: bank?.name ?? "Verified Nigerian bank",
        bankAccountNumber: accountNumber,
        bankAccountName: accountName,
        bankAccountLast4: accountNumber.slice(-4),
        paystackRecipientCode: recipient.recipient_code ?? null,
        payoutVerifiedAt: now,
      },
      update: {
        identityStatus: "VERIFIED",
        payoutStatus: "VERIFIED",
        identityReference: reference,
        identityJobId: null,
        smileUserId: null,
        verifiedNameHash,
        identityVerifiedAt: now,
        bankCode,
        bankName: bank?.name ?? "Verified Nigerian bank",
        bankAccountNumber: accountNumber,
        bankAccountName: accountName,
        bankAccountLast4: accountNumber.slice(-4),
        paystackRecipientCode: recipient.recipient_code ?? null,
        payoutVerifiedAt: now,
        failureCode: null,
      },
    });

    response.json({
      status: "VERIFIED",
      provider: "paystack",
      requiresManualReview: false,
      autoApproved: true,
      payoutStatus: "VERIFIED",
      bankName: bank?.name ?? "Verified Nigerian bank",
      accountLast4: accountNumber.slice(-4),
    });
  } catch (error) {
    console.error("Paystack payout account setup failed.", {
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
      code: axios.isAxiosError(error) ? error.code : undefined,
      message: error instanceof Error && !axios.isAxiosError(error) ? error.message : undefined,
    });
    response.status(502).json({ error: "Paystack could not complete identity and bank-account validation. Please retry." });
  }

});

router.post("/seller/verification/identity/submitted", async (request, response) => {
  const user = currentUser(request);
  const { reference, jobId, smileUserId } = request.body ?? {};
  if (typeof reference !== "string" || typeof jobId !== "string" || typeof smileUserId !== "string") {
    response.status(400).json({ error: "Smile ID submission details are invalid." });
    return;
  }
  const verification = await prisma.sellerVerification.findFirst({
    where: { userId: user.id, identityReference: reference, identityStatus: "PENDING" },
  });
  if (!verification) {
    response.status(409).json({ error: "This seller verification session is no longer active." });
    return;
  }
  try {
    const configuration = getSmileConfiguration();
    const jobStatus = await getSmileJobStatus(configuration, jobId);
    if (jobStatus.job_id !== jobId || jobStatus.user_id !== smileUserId || !["processing", "clear", "attention", "block", "error"].includes(jobStatus.status)) {
      response.status(400).json({ error: "Smile ID did not confirm the submitted job." });
      return;
    }
  } catch (error) {
    console.error("Smile ID submitted job could not be confirmed.", { jobId, error });
    response.status(502).json({ error: "Smile ID submission could not be confirmed. Please retry." });
    return;
  }

  await prisma.sellerVerification.update({
    where: { id: verification.id },
    data: { identityJobId: jobId, smileUserId },
  });
  response.json({ status: "PENDING" });
});

router.post("/seller/verification/identity/cancel", async (request, response) => {
  const user = currentUser(request);
  const reference = request.body?.reference;
  if (typeof reference !== "string") {
    response.status(400).json({ error: "A verification reference is required." });
    return;
  }
  const cancelled = await prisma.sellerVerification.updateMany({
    where: {
      userId: user.id,
      identityReference: reference,
      identityStatus: "PENDING",
      identityJobId: null,
    },
    data: { identityStatus: "NOT_STARTED", identityReference: null, smileUserId: null },
  });
  if (cancelled.count === 0) {
    response.status(409).json({ error: "This verification was already submitted or is no longer active." });
    return;
  }
  response.json({ cancelled: true });
});

router.post("/seller/verification/payout-account", async (request, response) => {
  const user = currentUser(request);
  const bankCode = request.body?.bankCode;
  const accountNumber = request.body?.accountNumber;
  if (typeof bankCode !== "string" || !/^\d{3,6}$/.test(bankCode) ||
      typeof accountNumber !== "string" || !/^\d{10}$/.test(accountNumber)) {
    response.status(400).json({ error: "Choose a bank and enter its 10-digit account number." });
    return;
  }
  const verification = await prisma.sellerVerification.findUnique({ where: { userId: user.id } });
  if (!verification || verification.identityStatus !== "VERIFIED" || !verification.verifiedNameHash) {
    response.status(403).json({ error: "Complete identity verification before verifying your payout account." });
    return;
  }

  let secretKey: string;
  let hashSecret: string;
  try {
    secretKey = getPaystackSecretKey();
    hashSecret = nameHashSecret();
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : "Payout verification is not configured." });
    return;
  }

  try {
    const result = await axios.get<{ status?: boolean; data?: { account_name?: unknown; account_number?: unknown } }>(
      "https://api.paystack.co/bank/resolve",
      { headers: { Authorization: `Bearer ${secretKey}` }, params: { account_number: accountNumber, bank_code: bankCode }, timeout: 15_000 },
    );
    const accountName = result.data.data?.account_name;
    const resolvedNumber = result.data.data?.account_number;
    if (!result.data.status || typeof accountName !== "string" || resolvedNumber !== accountNumber) {
      response.status(422).json({ error: "Paystack could not verify this account number." });
      return;
    }
    if (!hashPayoutNameMatches(accountName, verification.verifiedNameHash, hashSecret)) {
      await prisma.sellerVerification.update({
        where: { id: verification.id },
        data: { payoutStatus: "REJECTED", failureCode: "PAYOUT_NAME_MISMATCH", payoutVerifiedAt: null },
      });
      response.status(422).json({ error: "The account holder name does not match your verified identity. Use an account in your own name." });
      return;
    }
    const bank = cachedBanks.find((item) => item.code === bankCode);
    const recipient = await createPaystackTransferRecipient({
      name: accountName,
      accountNumber,
      bankCode,
    });
    await prisma.sellerVerification.update({
      where: { id: verification.id },
      data: {
        payoutStatus: "VERIFIED",
        bankCode,
        bankName: bank?.name ?? "Verified Nigerian bank",
        bankAccountNumber: accountNumber,
        bankAccountName: accountName,
        bankAccountLast4: accountNumber.slice(-4),
        paystackRecipientCode: recipient.recipient_code ?? null,
        payoutVerifiedAt: new Date(),
        failureCode: null,
      },
    });
    response.json({ verified: true, bankName: bank?.name ?? "Verified Nigerian bank", accountLast4: accountNumber.slice(-4) });
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Payout account verification failed.";
    response.status(502).json({ error: message });
  }
});

export default router;
