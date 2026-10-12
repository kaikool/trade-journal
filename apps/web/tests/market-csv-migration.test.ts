import { afterAll, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, marketCsvDatasets } = await import("../src/db");
const { csvDatasets } = await import("../src/server/market-data/csv");
it("reads CSV dataset metadata from the current Postgres storage schema", async () => {
  await db.insert(marketCsvDatasets).values({
    id: "legacy",
    name: "legacy.csv",
    symbol: "TEST",
    resolution: "1m",
    currency: "USD",
    priceBasis: "raw",
    storagePath: "market-data/legacy.json",
    checksum: "fixture-checksum",
    formatVersion: 1,
    importedAt: "2025-01-01T00:00:00.000Z",
    barCount: 1,
    firstTime: 1735689600000,
    lastTime: 1735689600000,
  });
  expect(await csvDatasets()).toMatchObject([
    {
      id: "legacy",
      count: 1,
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-01-01T00:01:00.000Z",
    },
  ]);
  const [stored] = await db.select().from(marketCsvDatasets);
  expect(stored).toMatchObject({ storagePath: "market-data/legacy.json", barCount: 1 });
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});
