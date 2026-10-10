import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { Router, type Request } from "express";
import { prisma } from "../lib/prisma.js";
import { requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";

const router = Router();
const challengeLifetimeMs = 3 * 60 * 1000;
const actionVerificationLifetimeMs = 90 * 1000;
const knownTransports = new Set<AuthenticatorTransport>(["usb", "nfc", "ble", "hybrid", "internal"]);

function currentUser(request: Request) {
  const user = (request as AuthenticatedRequest).marketplaceUser;
  if (!user) throw new Error("Authenticated user was not attached to the request.");
  return user;
}

function webAuthnConfig() {
  const originValues = (process.env.WEBAUTHN_ORIGIN ?? process.env.FRONTEND_URL ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (originValues.length === 0) throw new Error("At least one WebAuthn origin must be configured.");
  const origins = originValues.map((origin) => new URL(origin).origin);
  const rpID = process.env.WEBAUTHN_RP_ID?.trim() || new URL(origins[0]).hostname;
  if (!rpID) throw new Error("WebAuthn relying-party ID could not be determined.");
  if (process.env.NODE_ENV === "production" && origins.some((origin) => new URL(origin).protocol !== "https:")) {
    throw new Error("WebAuthn origins must use HTTPS in production.");
  }
  return { origins, rpID };
}

function transportsFor(transports: string[]): AuthenticatorTransport[] {
  return transports.filter((transport): transport is AuthenticatorTransport =>
    knownTransports.has(transport as AuthenticatorTransport));
}

async function saveChallenge(userId: string, challenge: string, purpose: "REGISTRATION" | "AUTHENTICATION") {
  const now = new Date();
  await prisma.passkeyChallenge.deleteMany({ where: { userId, expiresAt: { lte: now } } });
  await prisma.passkeyChallenge.deleteMany({ where: { userId, purpose } });
  await prisma.passkeyChallenge.create({
    data: { userId, challenge, purpose, expiresAt: new Date(now.getTime() + challengeLifetimeMs) },
  });
}

async function consumeChallenge(userId: string, challenge: string, purpose: "REGISTRATION" | "AUTHENTICATION") {
  const now = new Date();
  const stored = await prisma.passkeyChallenge.findFirst({
    where: { userId, challenge, purpose, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (!stored) return false;
  const consumed = await prisma.passkeyChallenge.deleteMany({
    where: { id: stored.id, userId, challenge, purpose, expiresAt: { gt: now } },
  });
  return consumed.count === 1;
}

function challengeFromClientData(clientDataJSON: string): string | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && "challenge" in value
      && typeof value.challenge === "string") return value.challenge;
    return null;
  } catch {
    return null;
  }
}

router.use("/passkeys", requireSupabaseUser);

router.get("/passkeys/status", async (request, response) => {
  const user = currentUser(request);
  const count = await prisma.passkeyCredential.count({ where: { userId: user.id } });
  response.json({ hasPasskey: count > 0 });
});

router.post("/passkeys/registration/options", async (request, response) => {
  const user = currentUser(request);
  const credentials = await prisma.passkeyCredential.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });
  const { rpID } = webAuthnConfig();
  const options = await generateRegistrationOptions({
    rpName: "QuickResell",
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email ?? user.id,
    userDisplayName: user.displayName ?? user.email ?? "QuickResell user",
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transportsFor(credential.transports),
    })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
    preferredAuthenticatorType: "localDevice",
  });
  await saveChallenge(user.id, options.challenge, "REGISTRATION");
  response.json({ options });
});

router.post("/passkeys/registration/verify", async (request, response) => {
  const user = currentUser(request);
  const credentialResponse = request.body?.response as RegistrationResponseJSON | undefined;
  if (!credentialResponse || typeof credentialResponse.id !== "string"
    || typeof credentialResponse.response?.clientDataJSON !== "string") {
    response.status(400).json({ error: "A valid passkey registration response is required." });
    return;
  }
  const clientChallenge = challengeFromClientData(credentialResponse.response.clientDataJSON);
  if (!clientChallenge) {
    response.status(400).json({ error: "The passkey response contained invalid client data." });
    return;
  }

  const { origins, rpID } = webAuthnConfig();
  const verification = await verifyRegistrationResponse({
    response: credentialResponse,
    expectedChallenge: clientChallenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo?.userVerified
    || !await consumeChallenge(user.id, clientChallenge, "REGISTRATION")) {
    response.status(400).json({ error: "The passkey could not verify you. Try again with device verification enabled." });
    return;
  }

  const credential = verification.registrationInfo.credential;
  try {
    await prisma.$transaction([
      prisma.passkeyCredential.create({
        data: {
          userId: user.id,
          credentialId: credential.id,
          publicKey: credential.publicKey,
          counter: BigInt(credential.counter),
          transports: transportsFor(credentialResponse.response.transports ?? []),
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { passkeyVerifiedUntil: new Date(Date.now() + actionVerificationLifetimeMs) },
      }),
    ]);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      response.status(409).json({ error: "This passkey is already registered to an account." });
      return;
    }
    throw error;
  }
  response.json({ verified: true });
});

router.post("/passkeys/authentication/options", async (request, response) => {
  const user = currentUser(request);
  const credentials = await prisma.passkeyCredential.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });
  if (credentials.length === 0) {
    response.status(409).json({ error: "Register a passkey before continuing with this action." });
    return;
  }
  const { rpID } = webAuthnConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transportsFor(credential.transports),
    })),
    userVerification: "required",
  });
  await saveChallenge(user.id, options.challenge, "AUTHENTICATION");
  response.json({ options });
});

router.post("/passkeys/authentication/verify", async (request, response) => {
  const user = currentUser(request);
  const credentialResponse = request.body?.response as AuthenticationResponseJSON | undefined;
  if (!credentialResponse || typeof credentialResponse.id !== "string"
    || typeof credentialResponse.response?.clientDataJSON !== "string") {
    response.status(400).json({ error: "A valid passkey authentication response is required." });
    return;
  }
  const credential = await prisma.passkeyCredential.findFirst({
    where: { userId: user.id, credentialId: credentialResponse.id },
  });
  if (!credential) {
    response.status(401).json({ error: "This passkey is not registered to your account." });
    return;
  }
  const clientChallenge = challengeFromClientData(credentialResponse.response.clientDataJSON);
  if (!clientChallenge) {
    response.status(400).json({ error: "The passkey response contained invalid client data." });
    return;
  }
  const { origins, rpID } = webAuthnConfig();
  const verification = await verifyAuthenticationResponse({
    response: credentialResponse,
    expectedChallenge: clientChallenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(credential.publicKey),
      counter: Number(credential.counter),
      transports: transportsFor(credential.transports),
    },
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified
    || !await consumeChallenge(user.id, clientChallenge, "AUTHENTICATION")) {
    response.status(401).json({ error: "Passkey verification failed. Try again." });
    return;
  }

  await prisma.$transaction([
    prisma.passkeyCredential.update({
      where: { id: credential.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passkeyVerifiedUntil: new Date(Date.now() + actionVerificationLifetimeMs) },
    }),
  ]);
  response.json({ verified: true });
});

export default router;
