import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts, executions, settings } = await import("../src/db");
const { setSetting } = await import("../src/server/settings");
const { POST: importFile } = await import("../src/app/api/import/route");

beforeEach(async () => {
  await db.delete(executions);
  await db.delete(accounts);
  await db.delete(settings);
  await db.insert(accounts).values({
    id: "ibkr-import",
    name: "IBKR statement import",
    kind: "import",
    createdAt: "2026-01-01",
  });
  await setSetting("importTimeZone", "America/New_York");
});

it("keeps IBKR Flex CSV file imports using the configured statement timezone", async () => {
  const content =
    "ClientAccountID,Symbol,Buy/Sell,Quantity,TradePrice,Commission,Date/Time\n" +
    "U_TEST,TEST,BUY,1,100,-1,20260918;085905";
  const response = await importFile(
    new Request("http://localhost/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "commit", accountId: "ibkr-import", content }),
    }),
  );
  expect(response.status).toBe(200);
  const [fill] = await db.select().from(executions).limit(1);
  expect(fill).toMatchObject({ source: "import", executedAt: "2026-09-18T12:59:05.000Z" });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});

// Route fixtures authenticate with a real signed session.
vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
vi.mock("next/headers", async () => {
  const { createHmac } = await import("node:crypto");
  return {
    cookies: async () => ({
      get: () => ({
        value: createHmac("sha256", "authenticated-test-fixture")
          .update("session-v1")
          .digest("hex"),
      }),
    }),
  };
});
