import { analyzeAdherence, readFilters } from "@luxalgo/journal-core";
import { db, playbooks, tradeRuleChecks, accounts } from "@/db";
import { queryTrades } from "@/server/trades-query";
import { handler, ok } from "@/server/api";

export const GET = handler(async (request: Request) => {
  const [{ trades }, checks, bookRows, accountRows] = await Promise.all([
    queryTrades(readFilters(new URL(request.url).searchParams)),
    db.select().from(tradeRuleChecks),
    db.select().from(playbooks),
    db.select({ id: accounts.id, currency: accounts.currency }).from(accounts),
  ]);
  const books = bookRows.map((book) => ({
    id: book.id,
    rules: JSON.parse(book.rulesJson) as string[],
  }));
  const currencies = new Map(accountRows.map((a) => [a.id, a.currency]));
  return ok({
    books: analyzeAdherence(trades, books, checks).map(({ accountIds, ...book }) => ({
      ...book,
      currencies: [...new Set(accountIds.map((id) => currencies.get(id) ?? "USD"))],
    })),
  });
});
