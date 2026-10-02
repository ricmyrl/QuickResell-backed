import { Router } from "express";
import { getExchangeRates } from "../services/exchangeRates.js";

const router = Router();

router.get("/currency/rates", async (_request, response) => {
  try {
    response.json(await getExchangeRates());
  } catch {
    response.status(503).json({ error: "Currency rates are temporarily unavailable." });
  }
});

export default router;