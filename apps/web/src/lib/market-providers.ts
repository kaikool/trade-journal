import type { Resolution } from "./market-data";

export interface CredentialField {
  key: string;
  label: string;
  environmentKey: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}
export interface ProviderInfo {
  id: string;
  name: string;
  mode: "credentials" | "public" | "csv";
  description: string;
  symbolHint: string;
  fields: CredentialField[];
  datasets?: { value: string; label: string }[];
  resolutions?: Resolution[];
}
export const MARKET_PROVIDERS: ProviderInfo[] = [
  {
    id: "binance",
    name: "Binance",
    mode: "public",
    description:
      "Public Binance spot candles. No API key required. Availability depends on your region and the listed pair.",
    symbolHint:
      "Spot pairs use BTCUSDT or ETHUSDT. USDT is not USD; account and quote currencies must match for estimates.",
    fields: [],
  },
  {
    id: "oanda",
    name: "OANDA",
    mode: "credentials",
    description:
      "Forex and CFD candles from your v20 account. Midpoint prices, UTC-aligned bars and tick-count volume; no spread or FX conversion is included.",
    symbolHint:
      "Use an OANDA instrument such as XAU_USD or EUR_USD. Set the contract multiplier in Settings to match the units in your fills.",
    fields: [
      { key: "apiKey", label: "Access token", environmentKey: "OANDA_API_TOKEN" },
      { key: "accountId", label: "v20 account ID", environmentKey: "OANDA_ACCOUNT_ID" },
      {
        key: "environment",
        label: "Environment",
        environmentKey: "OANDA_ENVIRONMENT",
        defaultValue: "practice",
        options: [
          { value: "practice", label: "Practice" },
          { value: "live", label: "Live" },
        ],
      },
    ],
  },
];
export const providerInfo = (id: string) => MARKET_PROVIDERS.find((item) => item.id === id);
