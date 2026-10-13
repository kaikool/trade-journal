import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";
import { eq } from "drizzle-orm";
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
const { db, settings, accounts, executions, trades, propEntries, propAudit } =
  await import("../src/db");
const { saveJournalPositions, reconcilePurchases, annotateSourceTrade } =
  await import("../src/server/the5ers/journal");
const { queryTrades, getTradeByKey } = await import("../src/server/trades-query");
const { computeOverview, intradayCurve, netReturnOnEntry } = await import("@luxalgo/journal-core");
const position = {
  symbol: "EURUSD",
  side: "Buy",
  isClosed: true,
  openDate: "2026-02-01T23:30:00Z",
  closeDate: "2026-02-02T00:30:00Z",
  entry: 1.1,
  exit: 1.11,
  quantity: 0.2,
  profitAndLoss: 97,
  fee: -2,
  swap: 1,
};
const purchase = {
  placedAt: "2026-02-01T23:30:00Z",
  status: "completed",
  price: 211.65,
  priceUsd: 211.65,
  currency: "USD",
  items: [{ name: "Evaluation", productType: "evaluation", creditsApplied: 0, netPaid: 211.65 }],
};
beforeEach(async () => {
  await db.delete(settings);
  await db.delete(propAudit);
  await db.delete(propEntries);
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db.insert(accounts).values({
    id: "journal",
    name: "The5ers",
    kind: "import",
    currency: "USD",
    initialBalance: 50000,
    createdAt: "2026-01-01T00:00:00Z",
  });
  await db
    .insert(settings)
    .values({ key: "the5ers:journal-links", value: JSON.stringify({ source: "journal" }) });
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await fixture.close();
});
const save = (rows: unknown[], complete = true) =>
  db.transaction((tx) =>
    saveJournalPositions(tx, "source", "USD", "2026-02-03T00:00:00Z", rows, complete),
  );
it("calculates net analytics, calendar and intraday from reported positions without invented fills or duplicated costs", async () => {
  await save([position, { ...position, symbol: "GBPUSD", profitAndLoss: -20 }]);
  const result = await queryTrades();
  const overview = computeOverview(result.trades, {
    timeZone: "Asia/Ho_Chi_Minh",
    initialBalance: 50000,
  });
  expect(overview.metrics).toMatchObject({
    closedTrades: 2,
    netPnl: 77,
    winRate: 0.5,
    fees: null,
    grossPnl: null,
    maxDrawdown: 20,
  });
  expect(overview.days).toHaveLength(1);
  expect(overview.days[0]).toMatchObject({
    date: "2026-02-02",
    netPnl: 77,
    fees: null,
    grossPnl: null,
  });
  expect(
    intradayCurve(result.trades, new Map(), "2026-02-02", "Asia/Ho_Chi_Minh").at(-1)?.cumNetPnl,
  ).toBe(77);
  expect(netReturnOnEntry(result.trades[0]!)).toBeNull();
  expect(await db.select().from(executions)).toHaveLength(0);
});
it("retains history across partial windows, updates a position once, and rejects ambiguous identities atomically", async () => {
  await save([position]);
  const key = (await queryTrades()).trades[0]!.key;
  await save([{ ...position, profitAndLoss: 95 }], false);
  expect((await queryTrades()).trades).toHaveLength(1);
  expect((await getTradeByKey(key))?.netPnl).toBe(95);
  await save([], false);
  expect((await queryTrades()).trades).toHaveLength(1);
  await expect(save([position, { ...position, profitAndLoss: 5 }])).rejects.toThrow(
    "indistinguishable",
  );
  await expect(save([{ ...position, quantity: 0.3 }])).rejects.toThrow("changed its entry or size");
  expect((await getTradeByKey(key))?.netPnl).toBe(95);
});
it("keeps source annotations and filters and does not double count matching native history", async () => {
  await save([position]);
  const { rows } = await queryTrades();
  const key = rows[0]!.key;
  await db.transaction((tx) =>
    annotateSourceTrade(tx, key, {
      tagsJson: JSON.stringify(["review"]),
      reviewedAt: "2026-02-03T00:00:00Z",
    }),
  );
  expect(
    (await queryTrades({ tag: "review", accounts: "journal", reviewed: "yes" })).trades,
  ).toHaveLength(1);
  expect((await queryTrades({ accounts: "other" })).trades).toHaveLength(0);
  const { source, costsUnavailable, quantityUnitsUnknown, reportedFee, reportedSwap, ...native } =
    rows[0]!;
  await db.insert(trades).values({ ...native, key: "native", grossPnl: 100, fees: 3 });
  expect((await queryTrades()).trades).toHaveLength(1);
  expect((await queryTrades()).trades[0]!.key).toBe("native");
});
it("persists local deletion without deleting provider history or reviving it on refresh", async () => {
  await save([position]);
  const key = (await queryTrades()).trades[0]!.key;
  await db.transaction((tx) => annotateSourceTrade(tx, key, { excluded: true }));
  await save([position]);
  expect((await queryTrades()).trades).toHaveLength(0);
});
it("posts one purchase to the audited ledger using local date and integer minor units, and remains idempotent", async () => {
  const reconcile = () =>
    db.transaction((tx) => reconcilePurchases(tx, [purchase], "Asia/Ho_Chi_Minh"));
  expect(await reconcile()).toEqual({ imported: 1, matched: 0, pending: 0 });
  expect(await reconcile()).toEqual({ imported: 0, matched: 1, pending: 0 });
  const saved = await db.select().from(propEntries);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    amountMinor: 21165,
    currency: "USD",
    occurredOn: "2026-02-02",
    category: "evaluation",
    kind: "expense",
  });
  expect(await db.select().from(propAudit)).toHaveLength(1);
  expect(
    await db.transaction((tx) =>
      reconcilePurchases(tx, [{ ...purchase, price: 200 }], "Asia/Ho_Chi_Minh"),
    ),
  ).toEqual({ imported: 0, matched: 0, pending: 1 });
  expect(await db.select().from(propEntries)).toHaveLength(1);
});
it("does not duplicate manual costs, post pending/refunded cash, or merge indistinguishable orders", async () => {
  await db.transaction((tx) => reconcilePurchases(tx, [purchase], "UTC"));
  const [saved] = await db.select().from(propEntries);
  await db
    .update(propEntries)
    .set({ id: "manual", reference: "manual-entry" })
    .where(eq(propEntries.id, saved!.id));
  expect(
    await db.transaction((tx) =>
      reconcilePurchases(
        tx,
        [
          purchase,
          { ...purchase, placedAt: "2026-02-02T00:00:00Z", status: "pending" },
          {
            ...purchase,
            placedAt: "2026-02-03T00:00:00Z",
            items: [{ ...purchase.items[0], refunded: true }],
          },
        ],
        "UTC",
      ),
    ),
  ).toEqual({ imported: 0, matched: 0, pending: 3 });
  await expect(
    db.transaction((tx) => reconcilePurchases(tx, [purchase, purchase], "UTC")),
  ).rejects.toThrow("cannot be distinguished");
  expect(await db.select().from(propEntries)).toHaveLength(1);
});
