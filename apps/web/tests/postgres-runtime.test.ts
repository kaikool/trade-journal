import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, folders } = await import("../src/db");

describe("Postgres runtime database", () => {
  it("accepts an injected Postgres-compatible database for isolated tests", async () => {
    const rows = await db.select().from(folders);
    expect(rows.map((row) => row.id).sort()).toEqual(
      ["all", "daily-journal", "my-notes", "session-recaps", "trade-notes"].sort(),
    );
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
