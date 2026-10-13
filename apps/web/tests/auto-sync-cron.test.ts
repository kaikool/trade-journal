import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const syncMocks = vi.hoisted(() => ({ syncAccount: vi.fn() }));
vi.mock("@/server/sync", () => syncMocks);

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, accounts } = await import("../src/db");
const { GET } = await import("../src/app/api/cron/broker-sync/route");

const request = (authorization?: string) =>
  new Request("https://journal.example/api/cron/broker-sync", {
    headers: authorization ? { authorization } : {},
  });

beforeEach(async () => {
  vi.stubEnv("JOURNAL_PASSWORD", "fixture-cron-password");
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
  syncMocks.syncAccount
    .mockReset()
    .mockImplementation(async (accountId: string) => ({ accountId }));
  await db.delete(accounts);
  await db.insert(accounts).values([
    {
      id: "auto-active",
      name: "Auto",
      kind: "sync",
      broker: "topstep",
      autoSync: true,
      createdAt: "2026-01-01",
    },
    {
      id: "manual-active",
      name: "Manual",
      kind: "sync",
      broker: "topstep",
      autoSync: false,
      createdAt: "2026-01-02",
    },
    {
      id: "auto-archived",
      name: "Archived",
      kind: "sync",
      broker: "topstep",
      autoSync: true,
      archivedAt: "2026-01-03",
      createdAt: "2026-01-03",
    },
    {
      id: "auto-manual-kind",
      name: "Manual account",
      kind: "manual",
      broker: "",
      autoSync: true,
      createdAt: "2026-01-04",
    },
    {
      id: "auto-removed-broker",
      name: "Removed broker",
      kind: "sync",
      broker: "alpaca",
      autoSync: true,
      createdAt: "2026-01-05",
    },
  ]);
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
  vi.unstubAllEnvs();
});

describe("daily broker auto-sync cron", () => {
  it.each([undefined, "", "   "])(
    "blocks sync without a journal password (%s)",
    async (password) => {
      vi.stubEnv("JOURNAL_PASSWORD", password);
      const query = vi.spyOn(db, "select");
      try {
        expect((await GET(request("Bearer cron-secret-for-tests"))).status).toBe(503);
        expect(query).not.toHaveBeenCalled();
        expect(syncMocks.syncAccount).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    },
  );
  it("rejects requests without the configured bearer secret", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(syncMocks.syncAccount).not.toHaveBeenCalled();
  });

  it("syncs only active sync accounts with auto-sync enabled", async () => {
    const response = await GET(request("Bearer cron-secret-for-tests"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checked: 1, synced: 1, failed: 0 });
    expect(syncMocks.syncAccount).toHaveBeenCalledExactlyOnceWith("auto-active");
  });

  it("continues through failures and reports partial completion", async () => {
    await db.insert(accounts).values({
      id: "auto-active-2",
      name: "Auto 2",
      kind: "sync",
      broker: "bybit",
      autoSync: true,
      createdAt: "2026-01-06",
    });
    syncMocks.syncAccount.mockImplementation(async (accountId: string) => {
      if (accountId === "auto-active") throw new Error("broker unavailable");
      return { accountId };
    });
    const response = await GET(request("Bearer cron-secret-for-tests"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ checked: 2, synced: 1, failed: 1 });
    expect(syncMocks.syncAccount).toHaveBeenCalledTimes(2);
  });

  it("fails closed when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(request("Bearer anything"));
    expect(response.status).toBe(503);
    expect(syncMocks.syncAccount).not.toHaveBeenCalled();
  });
});
