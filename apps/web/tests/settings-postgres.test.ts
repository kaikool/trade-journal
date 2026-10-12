import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.stubEnv("JOURNAL_SECRET", "fixture-settings-secret");
vi.stubEnv("ANTHROPIC_API_KEY", "");
vi.stubEnv("OPENAI_API_KEY", "");
vi.resetModules();
const { db, settings } = await import("../src/db");
const {
  deleteSetting,
  getAiKey,
  getAiProvider,
  getJournalDefaults,
  getSetting,
  setAiKey,
  setSetting,
} = await import("../src/server/settings");

beforeAll(async () => {
  await db.delete(settings);
});

describe("Postgres settings", () => {
  it("uses the supplied transaction for setting writes and rolls them back together", async () => {
    await expect(
      db.transaction(async (tx) => {
        const guard = vi.spyOn(db, "insert").mockImplementation(() => {
          throw new Error("Global writes forbidden");
        });
        try {
          await setSetting("transactionFixture", "pending", tx);
          expect(await getSetting("transactionFixture", tx)).toBe("pending");
          throw new Error("Fixture rollback");
        } finally {
          guard.mockRestore();
        }
      }),
    ).rejects.toThrow("Fixture rollback");
    expect(await getSetting("transactionFixture")).toBeNull();
  });
  it("reads defaults and round-trips a setting asynchronously", async () => {
    expect((await getJournalDefaults()).breakeven).toBe(0);
    await setSetting("timeZone", "Asia/Ho_Chi_Minh");
    expect(await getSetting("timeZone")).toBe("Asia/Ho_Chi_Minh");
    await deleteSetting("timeZone");
    expect(await getSetting("timeZone")).toBeNull();
  });

  it("encrypts saved AI keys and resolves the selected provider", async () => {
    await setAiKey("openai", "fixture-openai");
    expect(await getAiKey("openai")).toBe("fixture-openai");
    expect(await getAiProvider()).toBe("openai");
    const stored = await db.select().from(settings);
    expect(JSON.stringify(stored)).not.toContain("fixture-openai");
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await testDatabase.close();
});
