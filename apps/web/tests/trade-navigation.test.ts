import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();

const { db, accounts, trades, executions, settings } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { setSetting } = await import("../src/server/settings");
const { queryTrades } = await import("../src/server/trades-query");
const { GET } = await import("../src/app/api/trades/[key]/navigation/route");

const add = (account: string, symbol: string, time: string, exit = 110) =>
  insertExecutions(
    account,
    [
      { symbol, side: "buy", quantity: 1, price: 100, fee: 0, executedAt: time },
      {
        symbol,
        side: "sell",
        quantity: 1,
        price: exit,
        fee: 0,
        executedAt: new Date(Date.parse(time) + 60_000).toISOString(),
      },
    ],
    "manual",
  );
const key = async (symbol: string) =>
  (await queryTrades()).trades.find((trade) => trade.symbol === symbol)!.key;
const navigate = (tradeKey: string, query = "") =>
  GET(
    new Request(`http://localhost/api/trades/${encodeURIComponent(tradeKey)}/navigation?${query}`),
    { params: Promise.resolve({ key: tradeKey }) },
  );

beforeEach(async () => {
  vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db.delete(settings);
  await db.insert(accounts).values(
    ["a", "b"].map((id) => ({
      id,
      name: id,
      kind: "manual" as const,
      createdAt: "2026-01-01",
    })),
  );
  await setSetting("timeZone", "America/Jamaica");
  // Insert out of chronological order, including two entries at exactly the same time.
  await add("b", "MIDDLE", "2026-09-02T14:00:00Z", 90);
  await add("a", "LATE", "2026-09-03T14:00:00Z");
  await add("a", "EARLY", "2026-09-01T14:00:00Z");
  await add("a", "TIE", "2026-09-02T14:00:00Z");
});

afterAll(async () => {
  await testDatabase.close();
  vi.unstubAllEnvs();
});

it("walks entries in deterministic chronological order in both directions", async () => {
  const order = await Promise.all(["EARLY", "TIE", "MIDDLE", "LATE"].map(key));
  for (let index = 0; index < order.length; index++) {
    const response = await navigate(order[index]!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      prevKey: order[index - 1] ?? null,
      nextKey: order[index + 1] ?? null,
      position: index + 1,
      total: 4,
    });
  }
});

it("restricts same-account navigation without dropping the active date filter", async () => {
  const [tieKey, lateKey] = await Promise.all([key("TIE"), key("LATE")]);
  const response = await navigate(tieKey, "tradeScope=account&from=2026-09-02");
  expect(await response.json()).toEqual({
    prevKey: null,
    nextKey: lateKey,
    position: 1,
    total: 2,
  });
});

it("honors account and status filters, including a one-trade result", async () => {
  const middleKey = await key("MIDDLE");
  const response = await navigate(middleKey, "accounts=b&status=loss");
  expect(await response.json()).toEqual({ prevKey: null, nextKey: null, position: 1, total: 1 });
});

it("does not navigate outside filters when the current trade is excluded", async () => {
  const middleKey = await key("MIDDLE");
  const response = await navigate(middleKey, "accounts=a");
  expect(await response.json()).toEqual({ prevKey: null, nextKey: null, position: null, total: 3 });
  const earlyKey = await key("EARLY");
  const empty = await navigate(earlyKey, "from=2027-01-01");
  expect(await empty.json()).toEqual({ prevKey: null, nextKey: null, position: null, total: 0 });
});

it("uses the journal timezone for date boundaries", async () => {
  await add("a", "OVERNIGHT", "2026-09-02T02:00:00Z");
  const [earlyKey, overnightKey] = await Promise.all([key("EARLY"), key("OVERNIGHT")]);
  const response = await navigate(earlyKey, "from=2026-09-01&to=2026-09-01");
  expect(await response.json()).toEqual({
    prevKey: null,
    nextKey: overnightKey,
    position: 1,
    total: 2,
  });
});

it("returns 404 for an unknown trade", async () => {
  expect((await navigate("missing")).status).toBe(404);
});

vi.mock("next/headers", async () => {
  const { sessionToken } = await import("../src/server/auth");
  return {
    cookies: async () => ({
      get: () =>
        process.env.JOURNAL_PASSWORD === "authenticated-test-fixture"
          ? {
              value: sessionToken(),
            }
          : undefined,
    }),
  };
});
