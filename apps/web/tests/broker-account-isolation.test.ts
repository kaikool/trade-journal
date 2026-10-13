import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./helpers/postgres";
const upstream = vi.hoisted(() => ({
  snapshot: {
    accounts: [] as Array<{
      id: string;
      currency: string;
      equity: number;
      positions: unknown[];
      trades: unknown[];
    }>,
    fetchedAt: "2026-01-01T12:00:00Z",
  },
}));
vi.mock("@luxalgo/broker-sdk", async () => ({
  ...(await vi.importActual<object>("@luxalgo/broker-sdk")),
  connect: () => ({ fetchSnapshot: async () => upstream.snapshot }),
}));
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
const { db, accounts, executions, trades, settings } = await import("../src/db");
const { syncAccount } = await import("../src/server/sync");
const { encryptJson } = await import("../src/server/crypto");
const buy = {
  symbol: "TEST",
  side: "buy",
  quantity: 1,
  price: 100,
  fee: 0,
  executedAt: "2026-01-01T10:00:00Z",
};
beforeEach(async () => {
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db.delete(settings);
  vi.stubEnv("JOURNAL_SECRET", "broker-account-fixture");
  await db.insert(accounts).values({
    id: "journal",
    name: "journal",
    kind: "sync",
    broker: "topstep",
    credentialsEnc: encryptJson({}),
    createdAt: "2026-01-01",
  });
  upstream.snapshot.accounts = [
    { id: "A", currency: "USD", equity: 100, positions: [], trades: [buy] },
    {
      id: "B",
      currency: "EUR",
      equity: 200,
      positions: [],
      trades: [{ ...buy, side: "sell", price: 110, executedAt: "2026-01-01T11:00:00Z" }],
    },
  ];
});
it("refuses to net histories or add balances from unselected broker accounts", async () => {
  await expect(syncAccount("journal")).rejects.toThrow("multiple broker accounts");
  expect(await db.select().from(executions)).toHaveLength(0);
  expect(await db.select().from(trades)).toHaveLength(0);
});
it("syncs only the selected account and retains its currency and provenance across snapshots", async () => {
  await db.insert(settings).values({ key: "brokerAccount:journal", value: "B" });
  expect(await syncAccount("journal")).toMatchObject({ equity: 200, inserted: 1 });
  expect(await db.select().from(trades)).toMatchObject([{ direction: "short", status: "open" }]);
  expect(await db.select().from(accounts)).toMatchObject([{ currency: "EUR" }]);
  upstream.snapshot.accounts.reverse();
  expect((await syncAccount("journal")).inserted).toBe(0);
  upstream.snapshot.accounts = upstream.snapshot.accounts.filter((a) => a.id !== "B");
  await expect(syncAccount("journal")).rejects.toThrow("unavailable");
  expect(await db.select().from(executions)).toHaveLength(1);
});
it("automatically binds a single-account connection and refuses later currency drift", async () => {
  upstream.snapshot.accounts = upstream.snapshot.accounts.slice(0, 1);
  await syncAccount("journal");
  expect(await db.select().from(settings)).toMatchObject([
    { key: "brokerAccount:journal", value: "A" },
  ]);
  upstream.snapshot.accounts[0]!.currency = "EUR";
  await expect(syncAccount("journal")).rejects.toThrow("currency changed");
  expect(await db.select().from(accounts)).toMatchObject([{ currency: "USD" }]);
});
it("does not silently bind legacy mixed history to a newly selected broker account", async () => {
  const { insertExecutions } = await import("../src/server/executions");
  await insertExecutions("journal", [{ ...buy, side: "buy", fee: 0 }], "sync");
  upstream.snapshot.accounts = upstream.snapshot.accounts.slice(0, 1);
  await expect(syncAccount("journal")).rejects.toThrow("legacy account");
  expect(await db.select().from(settings)).toHaveLength(0);
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await fixture.close();
});
