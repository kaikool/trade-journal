import {
  currencyDigits,
  toMinor,
  EXPENSE_CATEGORIES,
  PROP_PROGRAMS,
  PROP_STATES,
} from "./prop-firms";

export const sourceObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const sourceNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** Provider labels may use camelCase, snake_case, PascalCase or display names. */
export function sourceFields(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sourceObject(value)).map(([key, item]) => [
      key.replace(/[ _-]/g, "").toLowerCase(),
      item,
    ]),
  );
}
const sourceBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["yes", "true"].includes(value.trim().toLowerCase())) return true;
    if (["no", "false"].includes(value.trim().toLowerCase())) return false;
  }
};
export function sourceProgram(value: unknown): (typeof PROP_PROGRAMS)[number] | undefined {
  if (typeof value !== "string") return;
  const phase = /(?:^|\s)High Stakes\s*-\s*([12])$/i.exec(value.trim());
  if (phase) return phase[1] === "1" ? "evaluation" : "verification";
  const name = value
    .trim()
    .toLowerCase()
    .replace(/[ _-]+/g, "_");
  const alias: Record<string, (typeof PROP_PROGRAMS)[number]> = {
    phase_1: "evaluation",
    phase1: "evaluation",
    challenge: "evaluation",
    phase_2: "verification",
    phase2: "verification",
    instantfunded: "instant_funded",
  };
  return PROP_PROGRAMS.includes(name as (typeof PROP_PROGRAMS)[number])
    ? (name as (typeof PROP_PROGRAMS)[number])
    : alias[name];
}
export function sourcePropStatus(value: unknown): (typeof PROP_STATES)[number] | undefined {
  if (typeof value !== "string") return;
  const name = value.trim().toLowerCase();
  const alias: Record<string, (typeof PROP_STATES)[number]> = {
    available: "active",
    failed: "breached",
    inactive: "closed",
    disabled: "inactive",
    terminated: "closed",
  };
  return PROP_STATES.includes(name as (typeof PROP_STATES)[number])
    ? (name as (typeof PROP_STATES)[number])
    : alias[name];
}

/** Require an explicit offset; never interpret broker wall time in the server's timezone. */
export function sourceInstant(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return;
  const calendar = value.slice(0, 10);
  const day = Date.parse(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== calendar) return;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}
export function sourceCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    currencyDigits(value);
    return value;
  } catch {
    return;
  }
}
export function sourceMoney(value: unknown, currency: string): number | undefined {
  const number = sourceNumber(value);
  if (number === undefined || number < 0) return;
  try {
    return toMinor(String(number), currency);
  } catch {
    return;
  }
}
export interface SourcePosition {
  identityDiscriminator?: string;
  providerId?: string;
  symbol: string;
  direction: "long" | "short";
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  entry: number;
  exit: number | null;
  netPnl: number;
  fee?: number;
  swap?: number;
  isValid?: boolean;
}
export function normalizePosition(value: unknown): SourcePosition | undefined {
  const row = sourceFields(value);
  const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
  const side = typeof row.side === "string" ? row.side.toLowerCase() : "";
  const direction = side === "buy" ? "long" : side === "sell" ? "short" : undefined;
  const openedAt = sourceInstant(row.opendate),
    quantity = sourceNumber(row.quantity),
    entry = sourceNumber(row.entry);
  if (
    !symbol ||
    symbol.length > 100 ||
    !direction ||
    !openedAt ||
    quantity === undefined ||
    quantity <= 0 ||
    entry === undefined ||
    sourceBoolean(row.isclosed) === undefined
  )
    return;
  const closedAt = sourceBoolean(row.isclosed) ? sourceInstant(row.closedate) : null;
  const exit = sourceBoolean(row.isclosed) ? sourceNumber(row.exit) : null;
  const netPnl = sourceBoolean(row.isclosed) ? sourceNumber(row.profitandloss) : 0;
  if (
    netPnl === undefined ||
    (sourceBoolean(row.isclosed) &&
      (!closedAt || exit === undefined || Date.parse(closedAt) < Date.parse(openedAt)))
  )
    return;
  const providerId = row.positionid ?? row.ticket ?? row.id;
  return {
    providerId:
      typeof providerId === "string" || typeof providerId === "number"
        ? String(providerId)
        : undefined,
    symbol,
    direction,
    openedAt,
    closedAt: closedAt ?? null,
    quantity,
    entry,
    exit: exit ?? null,
    netPnl,
    fee: sourceNumber(row.fee),
    swap: sourceNumber(row.swap),
    isValid: sourceBoolean(row.isvalid),
  };
}
export interface SourcePurchase {
  placedAt: string;
  currency: string;
  amountMinor: number;
  status: string;
  name: string;
  refunded: boolean;
  cashVerified: boolean;
  category: string;
}
/** One order is one cash payment. USD conversion and line totals are never extra charges. */
export function normalizePurchase(value: unknown): SourcePurchase | undefined {
  const row = sourceFields(value),
    placedAt = sourceInstant(row.placedat),
    currency = sourceCurrency(row.currency);
  if (!placedAt || !currency) return;
  const items = Array.isArray(row.items) ? row.items.map(sourceFields) : [];
  let amount = sourceNumber(row.price);
  let cashVerified = amount !== undefined;
  if (
    items.some(
      (i) => sourceNumber(i.creditsapplied) !== undefined && Number(i.creditsapplied) !== 0,
    )
  ) {
    // Line netpaid is cash in USD even when the order was paid in another currency.
    cashVerified = currency === "USD" && items.every((i) => sourceNumber(i.netpaid) !== undefined);
    if (cashVerified) {
      const minor = items.map((i) => sourceMoney(i.netpaid, "USD"));
      cashVerified = minor.every((v) => v !== undefined);
      if (cashVerified) amount = minor.reduce<number>((sum, v) => sum + v!, 0) / 100;
    }
  }
  const amountMinor = sourceMoney(amount, currency);
  if (amountMinor === undefined) return;
  return {
    placedAt,
    currency,
    amountMinor,
    status: typeof row.status === "string" ? row.status.trim().toLowerCase() : "unknown",
    name:
      items
        .map((i) => (typeof i.name === "string" ? i.name : ""))
        .filter(Boolean)
        .join(", ")
        .slice(0, 200) || "Program purchase",
    category:
      items.length &&
      items.every((i) => i.producttype === items[0]!.producttype) &&
      EXPENSE_CATEGORIES.includes(items[0]!.producttype as (typeof EXPENSE_CATEGORIES)[number])
        ? String(items[0]!.producttype)
        : "other",
    refunded:
      sourceBoolean(row.refunded ?? row.isrefunded) === true ||
      items.some((i) => sourceBoolean(i.refunded ?? i.isrefunded) === true),
    cashVerified,
  };
}
