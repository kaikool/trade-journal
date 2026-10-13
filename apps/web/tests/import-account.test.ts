import { afterAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
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
const { POST, GET } = await import("../src/app/api/accounts/route");
const { db, executions, trades } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");

it("creates an import destination with the chosen currency/balance and accepts fills under its returned id", async () => {
  const response = await POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Import verification",
        kind: "import",
        currency: "USD",
        initialBalance: 50000,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { id } = await response.json();
  const listed = await (await GET(new Request("http://localhost/api/accounts"))).json();
  expect(listed.accounts).toMatchObject([
    { id, name: "Import verification", kind: "import", currency: "USD", initialBalance: 50000 },
  ]);
  await insertExecutions(
    id,
    [
      {
        symbol: "TEST",
        side: "buy",
        quantity: 10,
        price: 100,
        fee: 0.35,
        executedAt: "2026-01-02T14:30:00Z",
        assetClass: "equity",
      },
      {
        symbol: "TEST",
        side: "sell",
        quantity: 10,
        price: 101,
        fee: 0.35,
        executedAt: "2026-01-02T15:30:00Z",
        assetClass: "equity",
      },
    ],
    "import",
  );
  expect(await db.select().from(executions)).toHaveLength(2);
  expect(await db.select().from(trades)).toMatchObject([
    { accountId: id, status: "win", netPnl: 9.3 },
  ]);
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});
