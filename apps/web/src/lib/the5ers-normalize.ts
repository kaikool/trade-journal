import { currencyDigits, toMinor, EXPENSE_CATEGORIES } from "./prop-firms";

export const sourceObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const sourceNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  const row = sourceObject(value);
  const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
  const side = typeof row.side === "string" ? row.side.toLowerCase() : "";
  const direction = side === "buy" ? "long" : side === "sell" ? "short" : undefined;
  const openedAt = sourceInstant(row.openDate),
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
    typeof row.isClosed !== "boolean"
  )
    return;
  const closedAt = row.isClosed ? sourceInstant(row.closeDate) : null;
  const exit = row.isClosed ? sourceNumber(row.exit) : null;
  const netPnl = row.isClosed ? sourceNumber(row.profitAndLoss) : 0;
  if (
    netPnl === undefined ||
    (row.isClosed &&
      (!closedAt || exit === undefined || Date.parse(closedAt) < Date.parse(openedAt)))
  )
    return;
  return {
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
    isValid: typeof row.isValid === "boolean" ? row.isValid : undefined,
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
  const row = sourceObject(value),
    placedAt = sourceInstant(row.placedAt),
    currency = sourceCurrency(row.currency);
  if (!placedAt || !currency) return;
  const items = Array.isArray(row.items) ? row.items.map(sourceObject) : [];
  let amount = sourceNumber(row.price);
  let cashVerified = amount !== undefined;
  if (
    items.some(
      (i) => sourceNumber(i.creditsApplied) !== undefined && Number(i.creditsApplied) !== 0,
    )
  ) {
    // Line netPaid is cash in USD even when the order was paid in another currency.
    cashVerified = currency === "USD" && items.every((i) => sourceNumber(i.netPaid) !== undefined);
    if (cashVerified) {
      const minor = items.map((i) => sourceMoney(i.netPaid, "USD"));
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
    status: typeof row.status === "string" ? row.status.toLowerCase() : "unknown",
    name:
      items
        .map((i) => (typeof i.name === "string" ? i.name : ""))
        .filter(Boolean)
        .join(", ")
        .slice(0, 200) || "Program purchase",
    category:
      items.length &&
      items.every((i) => i.productType === items[0]!.productType) &&
      EXPENSE_CATEGORIES.includes(items[0]!.productType as (typeof EXPENSE_CATEGORIES)[number])
        ? String(items[0]!.productType)
        : "other",
    refunded: items.some((i) => i.refunded === true),
    cashVerified,
  };
}
