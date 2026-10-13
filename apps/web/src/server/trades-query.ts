import { asc, eq, inArray } from "drizzle-orm";
import { matchesFilters, type AnalysisFilters, type AnnotatedTrade } from "@luxalgo/journal-core";
import { getTimeZone, getMultipliers, getJournalDefaults } from "./settings";
import { sourceTradeRows, sourceJournalData } from "./the5ers/journal";
import { db, trades } from "@/db";

export type TradeFilters = AnalysisFilters & { accountIds?: string[] };

export type TradeRow = typeof trades.$inferSelect & {
  source?: "the5ers";
  costsUnavailable?: boolean;
  quantityUnitsUnknown?: boolean;
  reportedFee?: number;
  reportedSwap?: number;
};

const parseJsonArray = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

const context = async () => ({
  multipliers: await getMultipliers(),
  defaults: await getJournalDefaults(),
});
export const rowToTrade = async (
  row: TradeRow,
  config?: Awaited<ReturnType<typeof context>>,
): Promise<AnnotatedTrade> => {
  const resolved = config ?? (await context());
  const multiplier = resolved.multipliers[row.symbol];
  const defaults = resolved.defaults;
  const missingMultiplier =
    multiplier == null && ["futures", "option", "forex", "cfd"].includes(row.assetClass ?? "");
  const notional = missingMultiplier
    ? 0
    : Math.abs(row.avgEntry * row.quantity * (multiplier ?? 1));
  const tolerance =
    row.quantityUnitsUnknown && defaults.breakevenMode === "percent"
      ? 0
      : defaults.breakevenMode === "percent"
        ? (notional * defaults.breakeven) / 100
        : defaults.breakeven;
  const status =
    row.status === "open"
      ? "open"
      : Math.abs(row.netPnl) <= Math.max(1e-9, tolerance)
        ? "breakeven"
        : row.netPnl > 0
          ? "win"
          : "loss";
  return {
    key: row.key,
    accountId: row.accountId,
    symbol: row.symbol,
    assetClass: (row.assetClass ?? undefined) as AnnotatedTrade["assetClass"],
    direction: row.direction,
    status,
    contractMultiplier: row.quantityUnitsUnknown ? undefined : multiplier,
    costsUnavailable: row.costsUnavailable,
    quantityUnitsUnknown: row.quantityUnitsUnknown,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? undefined,
    quantity: row.quantity,
    openQuantity: row.openQuantity,
    avgEntry: row.avgEntry,
    avgExit: row.avgExit ?? undefined,
    grossPnl: row.grossPnl,
    fees: row.fees,
    netPnl: row.netPnl,
    executionCount: row.executionCount,
    executionIds: parseJsonArray(row.executionIdsJson),
    exits: JSON.parse(row.exitsJson) as AnnotatedTrade["exits"],
    durationMs: row.durationMs ?? undefined,
    annotations: {
      tags: parseJsonArray(row.tagsJson),
      mistakes: parseJsonArray(row.mistakesJson),
      playbook: row.playbookId ?? undefined,
      rating: row.rating ?? undefined,
      stopLoss: row.stopLoss ?? undefined,
      profitTarget: row.profitTarget ?? undefined,
      reviewed: row.reviewedAt !== null,
    },
  };
};

/**
 * Narrow the account scope before decoding rows. Native/source deduplication
 * precedes annotation filters so a filtered-out native duplicate cannot reappear.
 * The core predicate remains authoritative for timezone, risk and breakeven semantics.
 */
export const queryTrades = async (
  filters: TradeFilters = {},
): Promise<{
  rows: TradeRow[];
  trades: AnnotatedTrade[];
  sourceCoverage: {
    accountId: string;
    complete: boolean;
    retrievedAt: string;
    positions: number;
  }[];
}> => {
  const effective = { ...filters, accounts: filters.accounts ?? filters.accountIds?.join(",") };
  const accountIds = effective.accounts
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const native = await db
    .select()
    .from(trades)
    .where(accountIds?.length ? inArray(trades.accountId, accountIds) : undefined)
    .orderBy(asc(trades.openedAt));
  const projection = await sourceJournalData();
  const source = projection.rows;
  const signature = (row: TradeRow) =>
    JSON.stringify([
      row.accountId,
      row.symbol,
      row.direction,
      Date.parse(row.openedAt),
      row.closedAt ? Date.parse(row.closedAt) : null,
      row.quantity,
      row.avgEntry,
      row.avgExit,
    ]);
  const saved = new Set(native.map(signature));
  const all = [...native, ...source.filter((row) => !saved.has(signature(row)))].sort(
    (a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.key.localeCompare(b.key),
  );
  const [timeZone, config] = await Promise.all([getTimeZone(), context()]);
  const pairs = (
    await Promise.all(all.map(async (row) => ({ row, trade: await rowToTrade(row, config) })))
  ).filter(({ trade }) => matchesFilters(trade, effective, timeZone));
  return {
    rows: pairs.map(({ row, trade }) => ({ ...row, status: trade.status })),
    trades: pairs.map((p) => p.trade),
    sourceCoverage: projection.coverage.filter(
      (c) => !accountIds?.length || accountIds.includes(c.accountId),
    ),
  };
};

export const getTradeByKey = async (key: string): Promise<TradeRow | undefined> => {
  const [row] = await db.select().from(trades).where(eq(trades.key, key)).limit(1);
  return (
    row ??
    (key.startsWith("the5ers_")
      ? (await sourceTradeRows()).find((row) => row.key === key)
      : undefined)
  );
};

/** Navigate chronologically within the active filters, with a stable tie-break for equal entries. */
export const getAdjacentTradeKeys = async (
  currentKey: string,
  filters: TradeFilters = {},
  accountId?: string,
) => {
  const ordered = (await queryTrades(filters)).trades
    .filter((trade) => !accountId || trade.accountId === accountId)
    .sort((a, b) => {
      const time = Date.parse(a.openedAt) - Date.parse(b.openedAt);
      return time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
  const index = ordered.findIndex((trade) => trade.key === currentKey);
  return {
    prevKey: index > 0 ? (ordered[index - 1]?.key ?? null) : null,
    nextKey: index >= 0 ? (ordered[index + 1]?.key ?? null) : null,
    position: index >= 0 ? index + 1 : null,
    total: ordered.length,
  };
};
