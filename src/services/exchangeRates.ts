import axios from "axios";

type ExchangeRates = { base: "USD"; rates: Record<string, number>; updatedAt: string };
type OpenExchangeRateResponse = { result?: string; time_last_update_utc?: string; rates?: Record<string, number> };

let cachedRates: ExchangeRates | null = null;
let cachedAt = 0;
const cacheDurationMs = 6 * 60 * 60 * 1000;

export async function getExchangeRates(): Promise<ExchangeRates> {
  if (cachedRates && Date.now() - cachedAt < cacheDurationMs) return cachedRates;

  const response = await axios.get<OpenExchangeRateResponse>("https://open.er-api.com/v6/latest/USD", { timeout: 8_000 });
  const rates = response.data?.rates;
  if (response.data?.result !== "success" || !rates || !Number.isFinite(rates.NGN) || rates.NGN <= 0) {
    throw new Error("A valid USD exchange rate response was not received.");
  }

  cachedRates = {
    base: "USD",
    rates,
    updatedAt: response.data.time_last_update_utc ?? new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedRates;
}

export async function usdToNgnKobo(usdAmount: number): Promise<number> {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) throw new Error("The USD amount must be positive.");
  const { rates } = await getExchangeRates();
  const nairaAmount = usdAmount * rates.NGN;
  const koboAmount = Math.round(nairaAmount * 100);
  if (!Number.isSafeInteger(koboAmount) || koboAmount <= 0) throw new Error("The converted payment amount is invalid.");
  return koboAmount;
}