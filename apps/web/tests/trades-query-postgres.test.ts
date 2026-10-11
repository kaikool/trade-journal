import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts, trades } = await import("../src/db");
const { queryTrades, getTradeByKey } = await import("../src/server/trades-query");

beforeAll(async () => {
  await db.insert(accounts).values({
    id: "account",
    name: "Fixture",
    broker: "",
    kind: "manual",
    currency: "USD",
    initialBalance: 0,
    profitCalcMethod: "fifo",
    autoSync: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(trades).values({
    key: "account|ES|long|2026-01-01T00:00:00.000Z",
    accountId: "account",
    symbol: "ES",
    direction: "long",
    status: "win",
    openedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    quantity: 1,
    openQuantity: 0,
    avgEntry: 100,
    avgExit: 110,
    grossPnl: 10,
    fees: 1,
    netPnl: 9,
    executionCount: 2,
    executionIdsJson: '["entry","exit"]',
    exitsJson: "[]",
    durationMs: 3_600_000,
  });
});

describe("Postgres trade queries", () => {
  it("loads and converts filtered trades asynchronously", async () => {
    const result = await queryTrades({ accounts: "account" });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ symbol: "ES", netPnl: 9, status: "win" });
    expect((await getTradeByKey(result.trades[0]!.key))?.symbol).toBe("ES");
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
