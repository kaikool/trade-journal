/**
 * Normalizes symbols for Binance and OANDA.
 * Strips broker/account-type prefixes and suffixes from MT4/MT5/cTrader,
 * and formats instruments as expected by OANDA and Binance.
 */
export function normalizeMarketSymbol(symbol: string, providerId: string): string {
  if (!symbol) return "";
  let clean = symbol.trim().toUpperCase();

  // Strip common broker/account-type prefixes or suffixes from MT4/MT5/cTrader
  // e.g., XAUUSD.m, XAUUSDpro, XAUUSDraw, EURUSD+, #EURUSD, EURUSD_i, EURUSD_sb
  clean = clean.replace(/^[#]/, "");
  clean = clean.replace(/(\.m|\.pro|\.raw|\.ecn|\.s|\.a|\.b|\+|#|_sb|_i|_pro|-m)$/i, "");

  if (providerId === "oanda") {
    // If it already matches BASE_QUOTE (e.g. XAU_USD, EUR_USD, US30_USD), keep it
    if (/^[A-Z0-9]+_[A-Z0-9]+$/.test(clean)) {
      return clean;
    }

    // Special commodity & index aliases
    const aliases: Record<string, string> = {
      GOLD: "XAU_USD",
      SILVER: "XAG_USD",
      OIL: "WTICO_USD",
      WTI: "WTICO_USD",
      USOIL: "WTICO_USD",
      BRENT: "BCO_USD",
      UKOIL: "BCO_USD",
      US30: "US30_USD",
      DJ30: "US30_USD",
      DJI: "US30_USD",
      NAS100: "NAS100_USD",
      USTEC: "NAS100_USD",
      NDX: "NAS100_USD",
      SPX500: "SPX500_USD",
      US500: "SPX500_USD",
      SP500: "SPX500_USD",
      GER30: "DE30_EUR",
      GER40: "DE30_EUR",
      DAX: "DE30_EUR",
    };
    const alias = aliases[clean];
    if (alias) return alias;

    // Remove any accidental slashes, hyphens, or dots (EUR/USD -> EURUSD)
    clean = clean.replace(/[\/\-\.]/g, "");

    // Common 6-character forex / metal pair (e.g. XAUUSD -> XAU_USD, EURUSD -> EUR_USD)
    if (/^[A-Z]{6}$/.test(clean)) {
      return `${clean.slice(0, 3)}_${clean.slice(3)}`;
    }

    // Index pairs like US30USD -> US30_USD, NAS100USD -> NAS100_USD
    if (clean.endsWith("USD") && clean.length > 3) {
      return `${clean.slice(0, -3)}_USD`;
    }

    return clean;
  }

  if (providerId === "binance") {
    // Binance spot symbol: alphanumeric uppercase without delimiters, e.g. BTCUSDT
    clean = clean.replace(/[\/\-_\.]/g, "");

    // Common single-token crypto pairs traded against USD/USDT
    const singleCrypto = [
      "BTC",
      "ETH",
      "SOL",
      "BNB",
      "XRP",
      "ADA",
      "DOGE",
      "AVAX",
      "LINK",
      "DOT",
      "NEAR",
      "LTC",
    ];
    if (singleCrypto.includes(clean)) {
      return `${clean}USDT`;
    }

    return clean;
  }

  return clean;
}

/**
 * Detects whether OANDA or Binance is best suited for this symbol / trade.
 */
export function detectProviderForSymbol(
  symbol: string,
  assetClass?: string | null,
): "binance" | "oanda" {
  const s = symbol
    .trim()
    .toUpperCase()
    .replace(/[\/\-_\.]/g, "");
  if (
    assetClass === "crypto" ||
    s.endsWith("USDT") ||
    s.endsWith("BUSD") ||
    ["BTC", "ETH", "SOL", "BNB"].some((c) => s.startsWith(c))
  ) {
    return "binance";
  }
  return "oanda";
}
