import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts, executions, trades } = await import("../src/db");
const { rebuildAccount } = await import("../src/server/rebuild");
const { insertExecutions, deleteExecutionsForTrades, listExecutions } =
  await import("../src/server/executions");

beforeEach(async () => {
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db
    .insert(accounts)
    .values({ id: "fixture", name: "Fixture", kind: "manual", createdAt: "2026-01-01" });
  await db.insert(executions).values([
    {
      id: "entry",
      accountId: "fixture",
      symbol: "TEST",
      side: "buy",
      quantity: 10,
      price: 100,
      fee: 1,
      executedAt: "2026-01-01T10:00:00Z",
      source: "manual",
      contentHash: "entry",
      createdAt: "2026-01-01",
    },
    {
      id: "exit",
      accountId: "fixture",
      symbol: "TEST",
      side: "sell",
      quantity: 10,
      price: 102,
      fee: 1,
      executedAt: "2026-01-01T11:00:00Z",
      source: "manual",
      contentHash: "exit",
      createdAt: "2026-01-01",
    },
  ]);
});

describe("Postgres round-trip rebuilding", () => {
  it("rolls back inserted fills if materializing their trades fails", async () => {
    await db.delete(executions);
    await testDatabase.client.exec(`
      CREATE FUNCTION reject_trade_fixture() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fixture storage failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_trade_fixture BEFORE INSERT ON trades
      FOR EACH ROW EXECUTE FUNCTION reject_trade_fixture();
    `);
    try {
      await expect(
        insertExecutions(
          "fixture",
          [
            {
              symbol: "TEST",
              side: "buy",
              quantity: 1,
              price: 100,
              fee: 1,
              executedAt: "2026-01-01T10:00:00Z",
            },
          ],
          "manual",
        ),
      ).rejects.toThrow();
      expect(await db.select().from(executions)).toEqual([]);
      expect(await db.select().from(trades)).toEqual([]);
    } finally {
      await testDatabase.client.exec(
        "DROP TRIGGER reject_trade_fixture ON trades; DROP FUNCTION reject_trade_fixture();",
      );
    }
  });

  it("deletes an exit and rebuilds the still-open position without losing its review", async () => {
    await rebuildAccount("fixture");
    const [trade] = await db.select().from(trades);
    await db.update(trades).set({ notes: "Keep review" }).where(eq(trades.key, trade!.key));
    await deleteExecutionsForTrades("fixture", ["exit"]);
    expect(await listExecutions("fixture")).toHaveLength(1);
    expect(await db.select().from(trades)).toEqual([
      expect.objectContaining({
        key: trade!.key,
        status: "open",
        openQuantity: 10,
        notes: "Keep review",
      }),
    ]);
  });

  it("rejects missing accounts without inserting any fills", async () => {
    await expect(
      insertExecutions(
        "missing",
        [
          {
            symbol: "TEST",
            side: "buy",
            quantity: 1,
            price: 100,
            fee: 1,
            executedAt: "2026-01-01T10:00:00Z",
          },
        ],
        "manual",
      ),
    ).rejects.toThrow("Account not found");
    expect(await db.select().from(executions)).toHaveLength(2);
  });

  it("deduplicates fills and atomically rebuilds a manual trade with retry-safe notes", async () => {
    await db.delete(executions);
    const fills = [
      {
        symbol: "TEST",
        side: "buy" as const,
        quantity: 10,
        price: 100,
        fee: 1,
        executedAt: "2026-01-01T10:00:00Z",
      },
      {
        symbol: "TEST",
        side: "sell" as const,
        quantity: 10,
        price: 102,
        fee: 1,
        executedAt: "2026-01-01T11:00:00Z",
      },
    ];
    expect(await insertExecutions("fixture", fills, "manual", "Review")).toMatchObject({
      inserted: 2,
      duplicates: 0,
    });
    expect(await insertExecutions("fixture", fills, "manual", "Review")).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    expect(await db.select().from(executions)).toHaveLength(2);
    expect(await db.select().from(trades)).toEqual([
      expect.objectContaining({ notes: "Review", netPnl: 18 }),
    ]);
  });
  it("rebuilds executions asynchronously and preserves annotations on retry", async () => {
    await rebuildAccount("fixture");
    const [trade] = await db.select().from(trades);
    expect(trade).toMatchObject({ netPnl: 18, fees: 2, status: "win" });
    await db
      .update(trades)
      .set({ notes: "Keep review", rating: 5 })
      .where(eq(trades.key, trade!.key));
    await rebuildAccount("fixture");
    expect(await db.select().from(trades)).toEqual([
      expect.objectContaining({ key: trade!.key, notes: "Keep review", rating: 5, netPnl: 18 }),
    ]);
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
