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
    fees: 2,
    grossPnl: 79,
    maxDrawdown: 20,
  });
  expect(overview.days).toHaveLength(1);
  expect(overview.days[0]).toMatchObject({
    date: "2026-02-02",
    netPnl: 77,
    fees: 2,
    grossPnl: 79,
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
  expect(await save([position, { ...position, profitAndLoss: 5 }])).toMatchObject({
    ambiguousPositions: 2,
    skippedPositions: 2,
  });
  await expect(save([{ ...position, quantity: 0.3 }])).rejects.toThrow("changed its entry or size");
  expect((await getTradeByKey(key))?.netPnl).toBe(95);
});
it("materializes reported trades once, preserves annotations and survives execution rebuilds", async () => {
  expect(await save([position])).toMatchObject({ importedPositions: 1, updatedPositions: 0 });
  expect(await save([position])).toMatchObject({
    importedPositions: 0,
    updatedPositions: 0,
    unchangedPositions: 1,
  });
  const [saved] = await db.select().from(trades);
  expect(saved).toMatchObject({
    accountId: "journal",
    quantity: 0.2,
    netPnl: 97,
    executionCount: 0,
  });
  await db.transaction((tx) =>
    annotateSourceTrade(tx, saved!.key, {
      notes: "Keep my review",
      reviewedAt: "2026-02-03T00:00:00Z",
    }),
  );
  expect(await save([{ ...position, profitAndLoss: 95 }])).toMatchObject({ updatedPositions: 1 });
  const { rebuildAccount } = await import("../src/server/rebuild");
  await rebuildAccount("journal");
  expect(await db.select().from(trades)).toHaveLength(1);
  expect((await db.select().from(trades))[0]).toMatchObject({
    notes: "Keep my review",
    netPnl: 95,
  });
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

it("imports simultaneous MT5 positions separately using size/entry or provider IDs and retains keys across partial windows", async () => {
  const second = { ...position, quantity: 0.3, entry: 1.101, profitAndLoss: -20 };
  await save([position]);
  const original = (await queryTrades()).trades[0]!.key;
  await save([position]);
  const legacyKey = (await queryTrades()).rows[0]!.key;
  expect(await save([position, second])).toMatchObject({
    importedPositions: 1,
    journaledPositions: 2,
  });
  const rows = (await queryTrades()).trades;
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.quantity === 0.2)!.key).toBe(original);
  const secondKey = rows.find((row) => row.quantity === 0.3)!.key;
  await save([{ ...second, profitAndLoss: -25 }], false);
  expect((await getTradeByKey(secondKey))!.netPnl).toBe(-25);
  await save([second, position]);
  expect(await db.select().from(trades)).toHaveLength(2);
  const third = { ...position, symbol: "XAUUSD", ticket: "100" };
  await save([third, { ...third, ticket: "101" }]);
  expect((await queryTrades()).trades).toHaveLength(4);
});
it("retains ambiguous raw records for review while importing unrelated valid positions", async () => {
  const outcome = await save([
    position,
    { ...position, profitAndLoss: 5 },
    { ...position, symbol: "XAUUSD" },
  ]);
  expect(outcome).toMatchObject({
    journaledPositions: 1,
    skippedPositions: 2,
    ambiguousPositions: 2,
  });
  expect((await queryTrades()).trades.map((row) => row.symbol)).toEqual(["XAUUSD"]);
});

it("keeps distinct MT5 tickets when each arrives in a separate window", async () => {
  await save([{ ...position, ticket: "100" }]);
  const firstKey = (await queryTrades()).trades[0]!.key;
  await save([{ ...position, ticket: "101", profitAndLoss: 50 }], false);
  expect((await queryTrades()).trades).toHaveLength(2);
  await save([{ ...position, ticket: "100", profitAndLoss: 95 }], false);
  expect((await getTradeByKey(firstKey))!.netPnl).toBe(95);
  expect(await db.select().from(trades)).toHaveLength(2);
});

it("reconstructs gross from signed commission and swap without changing net, including positive swap credits", async () => {
  await save([
    { ...position, symbol: "XAUUSD", profitAndLoss: -49.33, fee: -2.08, swap: 0 },
    { ...position, symbol: "USDJPY", fee: -2, swap: 5 },
    { ...position, symbol: "AUDUSD", fee: 2, swap: 0 },
  ]);
  const rows = (await queryTrades()).rows;
  const gold = rows.find((r) => r.symbol === "XAUUSD")!;
  expect(gold.netPnl).toBe(-49.33);
  expect(gold.grossPnl).toBeCloseTo(-47.25);
  expect(gold.fees).toBe(2.08);
  const credited = rows.find((r) => r.symbol === "USDJPY")!;
  expect(credited.fees).toBe(-3);
  expect(credited.grossPnl).toBe(94);
  const rebate = rows.find((r) => r.symbol === "AUDUSD")!;
  expect(rebate.reportedFee).toBe(2);
  expect(rebate.fees).toBe(-2);
  expect(rebate.grossPnl).toBe(95);
  for (const row of rows)
    expect(row.grossPnl + row.reportedFee! + row.reportedSwap!).toBeCloseTo(row.netPnl);

  await save([{ ...position, symbol: "GBPUSD", swap: undefined }], false);
  expect((await queryTrades()).rows.find((r) => r.symbol === "GBPUSD")!.costsUnavailable).toBe(
    true,
  );
});

it("distinguishes positions with identical entry time, price and volume by verified close time and exit price, without reordering duplicates", async () => {
  const second = { ...position, closeDate: "2026-02-02T01:30:00Z", exit: 1.12, profitAndLoss: 110 };
  await save([position]);
  const legacyKey = (await queryTrades()).rows[0]!.key;
  expect(await save([position, second])).toMatchObject({
    journaledPositions: 2,
    ambiguousPositions: 0,
  });
  const keys = (await queryTrades()).rows.map((r) => r.key).sort();
  expect(keys).toContain(legacyKey);
  await save([second, position]);
  expect((await queryTrades()).rows.map((r) => r.key).sort()).toEqual(keys);
  expect(await db.select().from(trades)).toHaveLength(2);
});

it("calculates entry ROI when the owner has configured a verified contract size", async () => {
  await save([position]);
  const { rowToTrade } = await import("../src/server/trades-query");
  const row = (await queryTrades()).rows[0]!;
  const defaults = (await import("../src/server/settings")).getJournalDefaults;
  const calculated = await rowToTrade(row, {
    multipliers: { EURUSD: 100000 },
    defaults: await defaults(),
  });
  expect(calculated.quantityUnitsUnknown).toBe(false);
  expect(netReturnOnEntry(calculated)).toBeCloseTo(97 / (1.1 * 0.2 * 100000));
});
