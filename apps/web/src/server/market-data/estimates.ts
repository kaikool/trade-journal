import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AnnotatedTrade } from "@luxalgo/journal-core";
import { accounts, db, tradeExcursions, marketCsvDatasets, executions } from "@/db";
import type { ExcursionEstimate, TradeMarketResult } from "@/lib/market-data";
import { listExecutions } from "@/server/executions";

type FingerprintContext = {
  currencies: Map<string, string>;
  fills: Map<string, typeof executions.$inferSelect>;
};
const chunks = <T>(items: T[], size = 400): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

/** Invalidate derived values when fills, reconstruction, currency or multiplier change. */
export async function estimateFingerprint(
  trade: AnnotatedTrade,
  context?: FingerprintContext,
): Promise<string> {
  let currency: string | undefined;
  if (context) {
    currency = context.currencies.get(trade.accountId);
  } else {
    const [acc] = await db
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(eq(accounts.id, trade.accountId))
      .limit(1);
    currency = acc?.currency;
  }
  const fills = trade.executionIds.length
    ? (context
        ? [...new Set(trade.executionIds)].flatMap((id) => {
            const fill = context.fills.get(id);
            return fill?.accountId === trade.accountId ? [fill] : [];
          })
        : await listExecutions(trade.accountId, trade.executionIds)
      )
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, side, quantity, price, executedAt }) => ({
          id,
          side,
          quantity,
          price,
          executedAt,
        }))
    : [];
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        accountId: trade.accountId,
        symbol: trade.symbol,
        direction: trade.direction,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        assetClass: trade.assetClass,
        multiplier: trade.contractMultiplier ?? null,
        currency,
        fills,
      }),
    )
    .digest("hex");
}

export async function saveEstimate(
  trade: AnnotatedTrade,
  history: TradeMarketResult,
  fingerprint: string,
) {
  // A chart-only load must not erase a previously confirmed estimate.
  if (history.estimate.mae === null || history.estimate.mfe === null) return;
  if ((await estimateFingerprint(trade)) !== fingerprint) return;
  if (history.datasetId) {
    const [dataset] = await db
      .select({ id: marketCsvDatasets.id })
      .from(marketCsvDatasets)
      .where(eq(marketCsvDatasets.id, history.datasetId))
      .limit(1);
    if (!dataset) return;
  }
  const values = {
    tradeKey: trade.key,
    fingerprint,
    provider: history.provider,
    symbol: history.symbol,
    resolution: history.resolution,
    fetchedAt: history.fetchedAt,
    datasetId: history.datasetId ?? null,
    estimateJson: JSON.stringify({ ...history.estimate, datasetId: history.datasetId }),
  };
  await db
    .insert(tradeExcursions)
    .values(values)
    .onConflictDoUpdate({ target: tradeExcursions.tradeKey, set: values });
}

export async function savedEstimates(trades: AnnotatedTrade[]) {
  const tradeKeys = trades.map((trade) => trade.key);
  const storedList = (
    await Promise.all(
      chunks(tradeKeys).map((keys) =>
        db.select().from(tradeExcursions).where(inArray(tradeExcursions.tradeKey, keys)),
      ),
    )
  ).flat();
  const stored = new Map(storedList.map((row) => [row.tradeKey, row]));
  const relevant = trades.filter((trade) => stored.has(trade.key));
  const accountIds = [...new Set(relevant.map((trade) => trade.accountId))];
  const executionIds = [...new Set(relevant.flatMap((trade) => trade.executionIds))];

  const currenciesList = (
    await Promise.all(
      chunks(accountIds).map((ids) =>
        db
          .select({ id: accounts.id, currency: accounts.currency })
          .from(accounts)
          .where(inArray(accounts.id, ids)),
      ),
    )
  ).flat();

  const fillsList = (
    await Promise.all(
      chunks(executionIds).map((ids) =>
        db.select().from(executions).where(inArray(executions.id, ids)),
      ),
    )
  ).flat();

  const context: FingerprintContext = {
    currencies: new Map(currenciesList.map((row) => [row.id, row.currency])),
    fills: new Map(fillsList.map((row) => [row.id, row])),
  };
  const datasetIds = new Set(
    (await db.select({ id: marketCsvDatasets.id }).from(marketCsvDatasets)).map((row) => row.id),
  );

  const results: [
    string,
    {
      estimate: ExcursionEstimate;
      provider: string;
      symbol: string;
      resolution: string;
      fetchedAt: string;
    },
  ][] = [];
  for (const trade of trades) {
    const row = stored.get(trade.key);
    if (!row) continue;
    const fp = await estimateFingerprint(trade, context);
    if (row.fingerprint !== fp) continue;
    const estimate = JSON.parse(row.estimateJson) as ExcursionEstimate & { datasetId?: string };
    if (estimate.datasetId && !datasetIds.has(estimate.datasetId)) continue;
    if (
      estimate.mae === null ||
      estimate.mfe === null ||
      !Number.isFinite(estimate.mae) ||
      !Number.isFinite(estimate.mfe)
    )
      continue;
    results.push([
      trade.key,
      {
        estimate,
        provider: row.provider,
        symbol: row.symbol,
        resolution: row.resolution,
        fetchedAt: row.fetchedAt,
      },
    ]);
  }
  return new Map(results);
}
