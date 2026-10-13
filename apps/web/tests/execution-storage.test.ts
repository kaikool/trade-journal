import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts, executions, trades } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { rebuildAccount } = await import("../src/server/rebuild");
const { POST } = await import("../src/app/api/executions/route");
const { GET: getTrade } = await import("../src/app/api/trades/[key]/route");
const rows: ImportedExecution[] = [
  {
    symbol: "TEST",
    side: "buy",
    quantity: 10,
    price: 100,
    fee: 0,
    executedAt: "2026-09-01T10:00:00Z",
  },
  {
    symbol: "TEST",
    side: "sell",
    quantity: 10,
    price: 102,
    fee: 0,
    executedAt: "2026-09-01T11:00:00Z",
  },
];

beforeEach(async () => {
  vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db
    .insert(accounts)
    .values({ id: "test", name: "Test", kind: "manual", createdAt: "2026-01-01" });
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});

describe("execution storage preserves a coherent journal", () => {
  it("rejects missing accounts and invalid fills before inserting data", async () => {
    await expect(insertExecutions("missing", rows, "manual")).rejects.toThrow("Account not found");
    for (const invalid of [
      { quantity: Infinity },
      { quantity: 0 },
      { fee: NaN },
      { executedAt: "invalid" },
      { side: "hold" },
      { symbol: " " },
    ]) {
      await expect(
        insertExecutions(
          "test",
          [rows[0]!, { ...rows[1]!, ...invalid } as ImportedExecution],
          "manual",
        ),
      ).rejects.toThrow();
    }
    expect(await db.select().from(executions)).toHaveLength(0);
  });

  it("rolls back the fills if calculating their trades fails", async () => {
    await testDatabase.client.exec(`
      CREATE FUNCTION reject_trade_fixture() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test storage failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_trade BEFORE INSERT ON trades
      FOR EACH ROW EXECUTE FUNCTION reject_trade_fixture();
    `);
    try {
      await expect(insertExecutions("test", rows, "manual")).rejects.toThrow();
      expect(await db.select().from(executions)).toHaveLength(0);
      expect(await db.select().from(trades)).toHaveLength(0);
    } finally {
      await testDatabase.client.exec(
        "DROP TRIGGER fail_trade ON trades; DROP FUNCTION reject_trade_fixture();",
      );
    }
  });

  it("deduplicates repeated imports while keeping the calculated total", async () => {
    expect(await insertExecutions("test", rows, "manual")).toMatchObject({
      inserted: 2,
      duplicates: 0,
    });
    expect(await insertExecutions("test", rows, "manual")).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    expect(await db.select().from(executions)).toHaveLength(2);
    expect((await db.select().from(trades))[0]?.netPnl).toBe(20);
  });

  it("saves Markdown notes with manual trades and preserves them through a rebuild and retry", async () => {
    const notes = "## Setup\n\nWaited for **confirmation**.\n- Followed the plan.";
    const response = await POST(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "test", executions: rows, notes }),
      }),
    );
    expect(response.status).toBe(200);
    const [trade] = await db.select().from(trades).limit(1);
    const detail = await getTrade(new Request("http://localhost/api/trades/fixture"), {
      params: Promise.resolve({ key: trade!.key }),
    });
    expect((await detail.json()).trade.notes).toBe(notes);
    await rebuildAccount("test");
    expect(await insertExecutions("test", rows, "manual", notes)).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    const [rebuilt] = await db.select().from(trades).limit(1);
    expect(rebuilt?.notes).toBe(notes);
  });

  it("appends exit notes to the correct position without changing unrelated trade notes", async () => {
    await insertExecutions("test", [rows[0]!], "manual", "Entry plan");
    await insertExecutions(
      "test",
      rows.map((row) => ({ ...row, symbol: "OTHER" })),
      "manual",
      "Unrelated note",
    );
    await insertExecutions("test", [rows[1]!], "manual", "Exit review");
    const saved = await db.select().from(trades);
    expect(saved.find((row) => row.symbol === "TEST")).toMatchObject({
      notes: "Entry plan\n\nExit review",
      netPnl: 20,
    });
    expect(saved.find((row) => row.symbol === "OTHER")?.notes).toBe("Unrelated note");
  });

  it("keeps existing notes when a manual exit has no notes", async () => {
    await insertExecutions("test", [rows[0]!], "manual", "Keep this plan");
    await insertExecutions("test", [rows[1]!], "manual", "   ");
    const [saved] = await db.select().from(trades).limit(1);
    expect(saved?.notes).toBe("Keep this plan");
  });

  it("saves notes for an already-recorded trade without duplicating fills or repeated notes", async () => {
    await insertExecutions("test", rows, "manual", "Entry plan");
    expect(await insertExecutions("test", rows, "manual", "Later review")).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    await insertExecutions("test", rows, "manual", "Later review");
    expect(await db.select().from(executions)).toHaveLength(2);
    const [saved] = await db.select().from(trades).limit(1);
    expect(saved?.notes).toBe("Entry plan\n\nLater review");
  });

  it("attaches a batch note to each trade formed by its new executions", async () => {
    await insertExecutions(
      "test",
      [
        ...rows,
        ...rows.map((row) => ({ ...row, executedAt: row.executedAt.replace("09-01", "09-02") })),
      ],
      "manual",
      "Session review",
    );
    const saved = await db.select().from(trades);
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.notes === "Session review")).toBe(true);
  });

  it("rejects invalid notes before inserting executions", async () => {
    for (const notes of [null, 42, {}, ["note"], "a".repeat(100001)]) {
      const response = await POST(
        new Request("http://localhost/api/executions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: "test", executions: rows, notes }),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(await db.select().from(executions)).toHaveLength(0);
    expect(await db.select().from(trades)).toHaveLength(0);
  });

  it("rolls back new executions if appending notes exceeds the existing notes limit", async () => {
    const existing = "a".repeat(100000);
    await insertExecutions("test", [rows[0]!], "manual", existing);
    await expect(insertExecutions("test", [rows[1]!], "manual", "Exit review")).rejects.toThrow(
      "Combined trade notes",
    );
    expect(await db.select().from(executions)).toHaveLength(1);
    const [saved] = await db.select().from(trades).limit(1);
    expect(saved).toMatchObject({ notes: existing, status: "open" });
  });
});

vi.mock("next/headers", async () => {
  const { createHmac } = await import("node:crypto");
  return {
    cookies: async () => ({
      get: () =>
        process.env.JOURNAL_PASSWORD === "authenticated-test-fixture"
          ? {
              value: createHmac("sha256", "authenticated-test-fixture")
                .update("session-v1")
                .digest("hex"),
            }
          : undefined,
    }),
  };
});
