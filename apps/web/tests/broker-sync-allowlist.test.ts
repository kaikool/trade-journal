import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.stubEnv("JOURNAL_SECRET", "fixture-broker-allowlist-secret");
vi.resetModules();
const { db, accounts } = await import("../src/db");
const { GET: listBrokers } = await import("../src/app/api/brokers/route");
const { POST: createAccount } = await import("../src/app/api/accounts/route");
const { syncAccount } = await import("../src/server/sync");

beforeAll(async () => {
  await db.delete(accounts);
});

describe("enabled broker sync roster", () => {
  it("lists only the four brokers retained for this app", async () => {
    const response = await listBrokers();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.brokers.map((broker: { id: string }) => broker.id)).toEqual([
      "binance",
      "bybit",
      "okx",
      "topstep",
    ]);
  });

  it("rejects creating a sync account for a broker removed from the roster", async () => {
    const response = await createAccount(
      new Request("http://localhost/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unsupported account",
          kind: "sync",
          broker: "alpaca",
          credentials: { apiKey: "fixture", apiSecret: "fixture" },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await db.select().from(accounts)).toEqual([]);
  });

  it("blocks synchronization of stored accounts for removed brokers", async () => {
    await db.insert(accounts).values({
      id: "legacy-sync",
      name: "Legacy",
      kind: "sync",
      broker: "alpaca",
      credentialsEnc: "encrypted-fixture",
      createdAt: "2026-01-01",
    });
    await expect(syncAccount("legacy-sync")).rejects.toThrow("not available for synchronization");
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});

// Route fixtures authenticate with a real signed session.
vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
vi.mock("next/headers", async () => {
  const { sessionToken } = await import("../src/server/auth");
  return {
    cookies: async () => ({
      get: () => ({
        value: sessionToken(),
      }),
    }),
  };
});
