import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { netReturnOnEntry } from "@luxalgo/journal-core";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();

const { db, accounts, trades, settings } = await import("../src/db");
const { setSetting } = await import("../src/server/settings");
const { GET } = await import("../src/app/api/trades/route");
const { GET: detail } = await import("../src/app/api/trades/[key]/route");

beforeEach(async () => {
  vi.stubEnv("JOURNAL_PASSWORD", "");
  await db.delete(trades);
  await db.delete(accounts);
  await db.delete(settings);
  await db.insert(accounts).values({ id: "a", name: "Test", kind: "manual", createdAt: "2026-01-01" });
  await setSetting("multipliers", JSON.stringify({ MNQ: 2, SPREAD: 100 }));
  const fixtures = [
    { symbol: "MNQ", assetClass: "futures", avgEntry: 31157.25, quantity: 4, netPnl: 283 },
    { symbol: "SPREAD", assetClass: "option", avgEntry: -2.47, quantity: 1, netPnl: -1.3 },
    { symbol: "UNKNOWN", assetClass: "futures", avgEntry: 100, quantity: 1, netPnl: 10 },
    { symbol: "STOCK", assetClass: "equity", avgEntry: 100, quantity: 1, netPnl: 10 },
  ];
  await db.insert(trades).values(
    fixtures.map((trade, index) => ({
      key: trade.symbol,
      accountId: "a",
      direction: "long" as const,
      status: "win" as const,
      openedAt: `2026-10-0${index + 1}T10:00:00Z`,
      closedAt: `2026-10-0${index + 1}T11:00:00Z`,
      openQuantity: 0,
      grossPnl: trade.netPnl + 1.3,
      fees: 1.3,
      executionCount: 2,
      executionIdsJson: "[]",
      exitsJson: "[]",
      ...trade,
    })),
  );
});

afterAll(async () => {
  await testDatabase.close();
  vi.unstubAllEnvs();
});

it.each(["", "view=list"])(
  "provides matching ROI inputs on the list and detail APIs (%s)",
  async (query) => {
    const response = await GET(new Request(`http://localhost/api/trades?${query}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.trades.map((trade: { contractMultiplier: number | null }) => trade.contractMultiplier),
    ).toEqual([2, 100, null, null]);
    const expected = [283 / 249258, -1.3 / 247, null, 0.1];
    for (const [index, trade] of body.trades.entries()) {
      const result = await detail(new Request(`http://localhost/api/trades/${trade.key}`), {
        params: Promise.resolve({ key: trade.key }),
      });
      expect(result.status).toBe(200);
      const full = (await result.json()).trade;
      expect(netReturnOnEntry(trade)).toEqual(expected[index]);
      expect(netReturnOnEntry(full)).toEqual(expected[index]);
      expect(trade.netPnl).toBe(full.netPnl);
    }
  },
);

it("keeps multipliers attached to their symbols after filtering", async () => {
  const response = await GET(new Request("http://localhost/api/trades?view=list&symbol=SPREAD"));
  const body = await response.json();
  expect(body.trades).toHaveLength(1);
  expect(body.trades[0]).toMatchObject({ symbol: "SPREAD", contractMultiplier: 100 });
});
