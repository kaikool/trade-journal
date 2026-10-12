import { afterAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts } = await import("../src/db");

it("stores IBKR timezone provenance as nullable data on existing account rows", async () => {
  await db.insert(accounts).values({
    id: "old",
    name: "Original history",
    kind: "sync",
    broker: "ibkr-flex",
    createdAt: "2026-01-01",
  });
  const [account] = await db.select().from(accounts).where(eq(accounts.id, "old"));
  expect(account).toMatchObject({ name: "Original history", ibkrSyncTimeZone: null });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
