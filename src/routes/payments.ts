import axios from "axios";
import { Router } from "express";
import { requireConfirmedEmail, requireSupabaseUser, type AuthenticatedRequest } from "../middleware/requireSupabaseUser.js";

const router = Router();

router.use("/payments", requireSupabaseUser, requireConfirmedEmail);

router.post("/payments/initialize", async (request, response) => {
  const buyer = (request as AuthenticatedRequest).marketplaceUser;
  const { amount, email, metadata } = request.body ?? {};

  if (!buyer) {
    response.status(401).json({ error: "Unauthorized." });
    return;
  }

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    response.status(400).json({ error: "amount must be a positive number." });
    return;
  }

  const paystackEmail = typeof email === "string" && email.trim().length > 0 ? email.trim() : buyer.email ?? null;
  if (!paystackEmail) {
    response.status(400).json({ error: "A valid email is required to initialize payment." });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  const reference = `QR-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: paystackEmail,
        amount: Math.round(amount * 100),
        currency: "NGN",
        reference,
        metadata: {
          userId: buyer.id,
          ...(metadata ?? {}),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    const data = paystackResponse.data?.data;
    if (!data?.authorization_url || !data?.reference) {
      response.status(502).json({ error: "Payment gateway initialization failed." });
      return;
    }

    response.json({
      status: "success",
      authorization_url: data.authorization_url,
      access_code: data.access_code,
      reference: data.reference,
    });
  } catch (error: unknown) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Failed to initialize Paystack payment.";
    response.status(500).json({ error: message });
  }
});

router.get("/payments/verify/:reference", async (request, response) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    response.status(500).json({ error: "PAYSTACK_SECRET_KEY is not configured." });
    return;
  }

  const reference = request.params.reference;
  if (!reference) {
    response.status(400).json({ error: "reference is required." });
    return;
  }

  try {
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );

    const data = paystackResponse.data?.data;
    if (!data) {
      response.status(400).json({ error: "Transaction could not be verified." });
      return;
    }

    if (data.status !== "success") {
      response.status(400).json({ error: "Payment is not yet successful." });
      return;
    }

    response.json({
      verified: true,
      status: data.status,
      reference: data.reference,
      amount: data.amount / 100,
      currency: data.currency,
      metadata: data.metadata ?? {},
    });
  } catch (error: unknown) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message ?? error.message : "Failed to verify Paystack payment.";
    response.status(500).json({ error: message });
  }
});

export default router;
