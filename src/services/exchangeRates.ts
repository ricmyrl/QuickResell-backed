type ExchangeRates = { base: "NGN"; rates: { NGN: 1 }; updatedAt: string };

export const legacyUsdToNgnRate = 1_331.267014;

export async function getExchangeRates(): Promise<ExchangeRates> {
  return { base: "NGN", rates: { NGN: 1 }, updatedAt: new Date().toISOString() };
}