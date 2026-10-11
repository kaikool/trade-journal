import { readFilters } from "@luxalgo/journal-core";
import { accounts, db } from "@/db";
import { tradeExplorerPoints } from "@/lib/trade-explorer";
import { handler, ok } from "@/server/api";
import { getTimeZone } from "@/server/settings";
import { queryTrades } from "@/server/trades-query";

import { savedEstimates } from "@/server/market-data/estimates";

export const GET = handler(async (request: Request) => {
  const [{ trades }, timeZone, accountRows] = await Promise.all([
    queryTrades(readFilters(new URL(request.url).searchParams)),
    getTimeZone(),
    db.select({ id: accounts.id, currency: accounts.currency }).from(accounts),
  ]);
  const currencies = new Map(accountRows.map((account) => [account.id, account.currency]));
  const estimates = await savedEstimates(trades);
  return ok({
    points: tradeExplorerPoints(trades, timeZone).map((point) => ({
      ...point,
      mae: estimates.get(point.key)?.estimate.mae ?? null,
      mfe: estimates.get(point.key)?.estimate.mfe ?? null,
    })),
    currencies: [
      ...new Set(
        trades
          .filter((trade) => trade.status !== "open" && trade.closedAt)
          .map((trade) => currencies.get(trade.accountId) ?? "USD"),
      ),
    ],
    timeZone,
  });
});
