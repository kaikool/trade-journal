import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts, executions, journalDays, playbooks, tradeRuleChecks, trades } =
  await import("../src/db");
const journalRoute = await import("../src/app/api/journal/route");
const journalDayRoute = await import("../src/app/api/journal/[date]/route");
const playbooksRoute = await import("../src/app/api/playbooks/route");
const playbookRoute = await import("../src/app/api/playbooks/[id]/route");
const rulesRoute = await import("../src/app/api/trades/[key]/rules/route");

const jsonRequest = (url: string, body: unknown, method = "POST") =>
  new Request(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await db.delete(tradeRuleChecks);
  await db.delete(journalDays);
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(playbooks);
  await db.delete(accounts);
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
});

const seedTrade = async (playbookId: string | null = null) => {
  await db.insert(executions).values([
    {
      id: "entry",
      accountId: "account",
      symbol: "ES",
      side: "buy",
      quantity: 1,
      price: 100,
      fee: 0,
      executedAt: "2026-01-02T13:00:00.000Z",
      source: "manual",
      contentHash: "entry-hash",
      createdAt: "2026-01-02T13:00:00.000Z",
    },
    {
      id: "exit",
      accountId: "account",
      symbol: "ES",
      side: "sell",
      quantity: 1,
      price: 110,
      fee: 0,
      executedAt: "2026-01-02T14:00:00.000Z",
      source: "manual",
      contentHash: "exit-hash",
      createdAt: "2026-01-02T14:00:00.000Z",
    },
  ]);
  await db.insert(trades).values({
    key: "trade-key",
    accountId: "account",
    symbol: "ES",
    direction: "long",
    status: "win",
    openedAt: "2026-01-02T13:00:00.000Z",
    closedAt: "2026-01-02T14:00:00.000Z",
    quantity: 1,
    openQuantity: 0,
    avgEntry: 100,
    avgExit: 110,
    grossPnl: 10,
    fees: 0,
    netPnl: 10,
    executionCount: 2,
    executionIdsJson: '["entry","exit"]',
    exitsJson: "[]",
    durationMs: 3_600_000,
    playbookId,
  });
};

describe("Postgres journal, playbook, and rule routes", () => {
  it("upserts day notes and returns chronology with trade stats", async () => {
    await seedTrade();
    const save = await journalDayRoute.PUT(
      jsonRequest("http://test.local/api/journal/2026-01-02", { note: "Review day" }, "PUT"),
      { params: Promise.resolve({ date: "2026-01-02" }) },
    );
    expect(save.status).toBe(200);

    const detail = await journalDayRoute.GET(
      new Request("http://test.local/api/journal/2026-01-02"),
      { params: Promise.resolve({ date: "2026-01-02" }) },
    );
    const detailPayload = (await detail.json()) as { note: string; trades: unknown[] };
    expect(detailPayload.note).toBe("Review day");
    expect(detailPayload.trades).toHaveLength(1);

    const list = await journalRoute.GET(new Request("http://test.local/api/journal"));
    const listPayload = (await list.json()) as { days: Array<{ date: string; hasNote: boolean }> };
    expect(listPayload.days[0]).toMatchObject({ date: "2026-01-02", hasNote: true });
  });

  it("manages playbooks and trade rule checks", async () => {
    const created = await playbooksRoute.POST(
      jsonRequest("http://test.local/api/playbooks", {
        name: "Breakout",
        description: "Momentum",
        rules: ["Wait for close", "Respect stop", "Wait for close"],
      }),
    );
    const { id } = (await created.json()) as { id: string };
    await seedTrade(id);

    const saveRule = await rulesRoute.POST(
      jsonRequest("http://test.local/api/trades/trade-key/rules", {
        rule: "Wait for close",
        followed: true,
      }),
      { params: Promise.resolve({ key: "trade-key" }) },
    );
    expect(saveRule.status).toBe(200);

    const rules = await rulesRoute.GET(
      new Request("http://test.local/api/trades/trade-key/rules"),
      {
        params: Promise.resolve({ key: "trade-key" }),
      },
    );
    expect(await rules.json()).toMatchObject({
      name: "Breakout",
      rules: [
        { rule: "Wait for close", followed: true },
        { rule: "Respect stop", followed: null },
      ],
    });

    const list = await playbooksRoute.GET();
    const payload = (await list.json()) as { playbooks: Array<{ id: string; tradeCount: number }> };
    expect(payload.playbooks.find((row) => row.id === id)?.tradeCount).toBe(1);

    const patch = await playbookRoute.PATCH(
      jsonRequest("http://test.local/api/playbooks/" + id, { rules: ["Respect stop"] }, "PATCH"),
      { params: Promise.resolve({ id }) },
    );
    expect(patch.status).toBe(200);

    const removeRule = await rulesRoute.POST(
      jsonRequest("http://test.local/api/trades/trade-key/rules", {
        rule: "Respect stop",
        followed: null,
      }),
      { params: Promise.resolve({ key: "trade-key" }) },
    );
    expect(removeRule.status).toBe(200);

    const removePlaybook = await playbookRoute.DELETE(
      new Request("http://test.local/api/playbooks/" + id),
      { params: Promise.resolve({ id }) },
    );
    expect(removePlaybook.status).toBe(200);
    expect(
      (await db.select().from(trades).where(eq(trades.key, "trade-key")).limit(1))[0],
    ).toMatchObject({ playbookId: null });
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
