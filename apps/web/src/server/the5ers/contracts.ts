import { RequestError } from "@/server/api";

export const MCP_URL = "https://mcp.the5ers.com/mcp";
export const READ_SCOPES = [
  "accounts",
  "balance",
  "performance",
  "programs",
  "consistency",
  "payouts",
  "positions",
  "credits",
  "coupons",
  "achievements",
  "notifications",
  "contests",
  "purchases",
  "affiliate",
].map((scope) => `mcp:${scope}.read`);
/** Pinned read-only allowlist. Inspect current provider schemas with tools/list; no caller-supplied tool names. */
export const READ_TOOLS = {
  catalogue: { name: "the5ers_catalogue", operations: ["programs"] },
  contest: {
    name: "the5ers_contest",
    operations: [
      "upcoming",
      "overview",
      "leaderboard",
      "performance",
      "balance_chart",
      "mine",
      "winners",
    ],
  },
  account: {
    name: "the5ers_account",
    operations: [
      "list",
      "balance",
      "statistics",
      "balance_chart",
      "midnight_history",
      "daily_performance",
      "health",
      "compare",
    ],
  },
  positions: { name: "the5ers_positions", operations: ["list", "trades", "detail", "analysis"] },
  program: { name: "the5ers_program", operations: ["rules", "progression", "journey"] },
  consistency: { name: "the5ers_consistency", operations: ["list", "breakdown"] },
  payout: { name: "the5ers_payout", operations: ["eligibility", "history", "explain"] },
  wallet: { name: "the5ers_wallet", operations: ["credits_expiry", "coupons", "overview"] },
  achievements: {
    name: "the5ers_achievements",
    operations: ["earned", "requirements", "verified_progress", "certificate_settings"],
  },
  alerts: { name: "the5ers_alerts", operations: ["list"] },
  purchase: { name: "the5ers_purchase", operations: ["list", "accounts"] },
  affiliate: { name: "the5ers_affiliate", operations: ["overview", "commissions", "faq"] },
} as const;
export type ReadTool = keyof typeof READ_TOOLS;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(
      "The5ers returned an unsupported response. No journal trades were changed.",
    );
  return value as Record<string, unknown>;
}
export function officialAuthUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new RequestError("The5ers OAuth is not configured on this server.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RequestError("Invalid The5ers OAuth endpoint configuration.");
  }
  if (url.origin !== "https://auth.hub.the5ers.com" || url.username || url.password || url.hash)
    throw new RequestError("The5ers OAuth endpoints must use the official authorization server.");
  return url.href;
}
/** Provider data is untrusted text, not instructions. Never return credentials or ephemeral refs. */
export function publicData(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[nested data omitted]";
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => publicData(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/token|password|secret|authorization|credential|cookie|(?:^|_)ref$|^ref$|^_meta$/i.test(
              key,
            ),
        )
        .slice(0, 200)
        .map(([key, item]) => [key, publicData(item, depth + 1)]),
    );
  if (typeof value === "string")
    return value.replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]{20,}\b/g, "[redacted]").slice(0, 10000);
  return value;
}
