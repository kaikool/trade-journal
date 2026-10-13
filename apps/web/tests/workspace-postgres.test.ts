import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const {
  db,
  accounts,
  missedTrades,
  noteTemplates,
  playbooks,
  progressChecks,
  progressRules,
  settings,
} = await import("../src/db");
const workspaceRoute = await import("../src/app/api/workspace/[resource]/route");

const request = (resource: string, body?: unknown, method = "POST") =>
  new Request("http://test.local/api/workspace/" + resource, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await db.delete(settings);
  await db.delete(missedTrades);
  await db.delete(progressChecks);
  await db.delete(progressRules);
  await db.delete(noteTemplates);
  await db.delete(playbooks);
  await db.delete(accounts);
});

describe("Postgres workspace routes", () => {
  it("manages templates, progress routines, and missed trades", async () => {
    const template = await workspaceRoute.POST(
      request("templates", {
        name: "Plan",
        content: "Checklist",
      }),
      { params: Promise.resolve({ resource: "templates" }) },
    );
    expect(template.status).toBe(200);

    const progress = await workspaceRoute.POST(
      request("progress", {
        title: "Review risk",
        stage: "Before trading",
        weekdays: [0, 1, 2, 3, 4, 5, 6, 6],
      }),
      { params: Promise.resolve({ resource: "progress" }) },
    );
    expect(progress.status).toBe(200);
    const { id: ruleId } = (await progress.json()) as { id: string };

    const progressList = await workspaceRoute.GET(request("progress", undefined, "GET"), {
      params: Promise.resolve({ resource: "progress" }),
    });
    const progressPayload = (await progressList.json()) as {
      rules: Array<{ id: string; weekdays: number[] }>;
      today: string;
    };
    expect(progressPayload.rules).toEqual([
      expect.objectContaining({ id: ruleId, weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    ]);

    const check = await workspaceRoute.POST(
      request("progress", {
        ruleId,
        date: progressPayload.today,
        done: true,
      }),
      { params: Promise.resolve({ resource: "progress" }) },
    );
    expect(check.status).toBe(200);
    expect(await db.select().from(progressChecks)).toEqual([
      expect.objectContaining({ ruleId, date: progressPayload.today, done: true }),
    ]);

    await db.insert(playbooks).values({
      id: "book",
      name: "Breakout",
      description: "",
      rulesJson: "[]",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const missed = await workspaceRoute.POST(
      request("missed", {
        symbol: " es ",
        direction: "long",
        observedAt: "2026-01-03T10:00:00.000Z",
        playbookId: "book",
        entry: 100,
        notes: "Chased",
      }),
      { params: Promise.resolve({ resource: "missed" }) },
    );
    expect(missed.status).toBe(200);
    const { id: missedId } = (await missed.json()) as { id: string };

    const missedList = await workspaceRoute.GET(request("missed", undefined, "GET"), {
      params: Promise.resolve({ resource: "missed" }),
    });
    expect((await missedList.json()) as unknown).toMatchObject({
      trades: [expect.objectContaining({ id: missedId, symbol: "ES" })],
    });

    const archive = await workspaceRoute.DELETE(request("missed", { id: missedId }, "DELETE"), {
      params: Promise.resolve({ resource: "missed" }),
    });
    expect(archive.status).toBe(200);
    expect(
      (await db.select().from(missedTrades).where(eq(missedTrades.id, missedId)).limit(1))[0]
        ?.archivedAt,
    ).toBeTruthy();
  });

  it("persists journal defaults after validating account references", async () => {
    await db.insert(accounts).values({
      id: "account",
      name: "Fixture",
      broker: "",
      kind: "manual",
      currency: "USD",
      initialBalance: 0,
      profitCalcMethod: "fifo",
      autoSync: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const save = await workspaceRoute.POST(
      request("defaults", {
        breakeven: 1,
        breakevenMode: "money",
        feeRules: [{ id: "fee", accountId: "account", symbol: "ES", amount: 2, mode: "execution" }],
        riskRules: [
          {
            id: "risk",
            accountId: "account",
            symbol: "ES",
            stop: 5,
            target: 10,
            mode: "price",
          },
        ],
      }),
      { params: Promise.resolve({ resource: "defaults" }) },
    );
    expect(save.status).toBe(200);

    const defaults = await workspaceRoute.GET(request("defaults", undefined, "GET"), {
      params: Promise.resolve({ resource: "defaults" }),
    });
    expect(await defaults.json()).toMatchObject({ breakeven: 1, feeRules: [{ id: "fee" }] });
  });
});

afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
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
