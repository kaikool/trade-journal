import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { createTestDatabase } from "./helpers/postgres";
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
vi.mock("next/headers", async () => {
  const { sessionToken } = await import("../src/server/auth");
  return { cookies: async () => ({ get: () => ({ value: sessionToken() }), set: vi.fn() }) };
});
const { db, accounts, trades, executions, settings, notes, attachments, tradeRuleChecks } =
  await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { POST: createAccount } = await import("../src/app/api/accounts/route");
const { POST: action } = await import("../src/app/api/accounts/[id]/actions/route");
const { PATCH: saveSettings } = await import("../src/app/api/settings/route");
const request = (body: unknown, url = "https://journal.example/api/accounts") =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function account(id: string) {
  await db.insert(accounts).values({ id, name: id, kind: "manual", createdAt: "2026-01-01" });
  return id;
}
const fills = [
  {
    symbol: "TEST",
    side: "buy" as const,
    quantity: 1,
    price: 100,
    fee: 0,
    executedAt: "2026-01-01T10:00:00Z",
  },
  {
    symbol: "TEST",
    side: "sell" as const,
    quantity: 1,
    price: 110,
    fee: 0,
    executedAt: "2026-01-01T11:00:00Z",
  },
];
async function closed(id: string) {
  await account(id);
  await insertExecutions(id, fills, "manual");
  return (await db.select().from(trades).where(eq(trades.accountId, id)))[0]!;
}
async function failRebuild() {
  await fixture.client.exec(
    "CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated rebuild failure'; END $$; CREATE TRIGGER audit_failure BEFORE INSERT ON trades FOR EACH ROW EXECUTE FUNCTION audit_fail();",
  );
}
async function restoreRebuild() {
  await fixture.client.exec("DROP TRIGGER audit_failure ON trades; DROP FUNCTION audit_fail();");
}
beforeEach(async () => {
  await db.delete(tradeRuleChecks);
  await db.delete(attachments);
  await db.delete(notes);
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  await db.delete(settings);
  vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
});
it("rolls back fills and annotations when transfer rebuild fails", async () => {
  await closed("source");
  await account("destination");
  await db.update(trades).set({ notes: "keep this review" }).where(eq(trades.accountId, "source"));
  await failRebuild();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      (
        await action(request({ action: "transfer", toAccountId: "destination" }), {
          params: Promise.resolve({ id: "source" }),
        })
      ).status,
    ).toBe(500);
  } finally {
    await restoreRebuild();
    log.mockRestore();
  }
  expect(await db.select().from(executions).where(eq(executions.accountId, "source"))).toHaveLength(
    2,
  );
  expect(
    await db.select().from(executions).where(eq(executions.accountId, "destination")),
  ).toHaveLength(0);
  expect(await db.select().from(trades).where(eq(trades.accountId, "source"))).toMatchObject([
    { notes: "keep this review" },
  ]);
});
it("moves annotations, attachment ownership, note links and rule checks together", async () => {
  const trade = await closed("source");
  await account("destination");
  await db
    .update(trades)
    .set({ notes: "review", tagsJson: '["tag"]' })
    .where(eq(trades.key, trade.key));
  await db.insert(notes).values({
    id: "note",
    folderId: "my-notes",
    tradeKey: trade.key,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  });
  await db.insert(attachments).values({
    id: "attachment",
    ownerType: "trade",
    ownerId: trade.key,
    name: "image.png",
    mime: "image/png",
    size: 100,
    storagePath: "attachments/fixture.png",
    status: "ready",
    createdAt: "2026-01-01",
  });
  await db
    .insert(tradeRuleChecks)
    .values({ id: "check", tradeKey: trade.key, playbookId: "book", rule: "rule", followed: true });
  expect(
    (
      await action(request({ action: "transfer", toAccountId: "destination" }), {
        params: Promise.resolve({ id: "source" }),
      })
    ).status,
  ).toBe(200);
  const newKey = "destination" + trade.key.slice("source".length);
  expect(await db.select().from(trades)).toMatchObject([
    { key: newKey, notes: "review", tagsJson: '["tag"]' },
  ]);
  expect(await db.select().from(notes)).toMatchObject([{ tradeKey: newKey }]);
  expect(await db.select().from(attachments)).toMatchObject([{ ownerId: newKey }]);
  expect(await db.select().from(tradeRuleChecks)).toMatchObject([
    { tradeKey: newKey, id: JSON.stringify([newKey, "book", "rule"]) },
  ]);
});
it("rejects history merges without changing either account", async () => {
  await closed("source");
  await account("destination");
  await insertExecutions(
    "destination",
    [
      { ...fills[0]!, executedAt: "2026-01-01T09:00:00Z" },
      { ...fills[1]!, executedAt: "2026-01-01T12:00:00Z" },
    ],
    "manual",
  );
  expect(
    (
      await action(request({ action: "transfer", toAccountId: "destination" }), {
        params: Promise.resolve({ id: "source" }),
      })
    ).status,
  ).toBe(400);
  expect(await db.select().from(trades)).toHaveLength(2);
  expect(await db.select().from(executions).where(eq(executions.accountId, "source"))).toHaveLength(
    2,
  );
});
it("rolls back multipliers and all account valuations after a rebuild failure", async () => {
  await closed("source");
  await failRebuild();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await saveSettings(request({ multipliers: { TEST: 10 } }))).status).toBe(500);
  } finally {
    await restoreRebuild();
    log.mockRestore();
  }
  expect(await db.select().from(settings).where(eq(settings.key, "multipliers"))).toHaveLength(0);
  expect(await db.select().from(trades)).toMatchObject([{ grossPnl: 10 }]);
  expect((await saveSettings(request({ multipliers: { TEST: 10 } }))).status).toBe(200);
  expect(await db.select().from(trades)).toMatchObject([{ grossPnl: 100 }]);
});
it("preserves multiplicity and fee corrections without duplicating a repeated snapshot", async () => {
  await account("sync");
  const input = [{ ...fills[0]! }, { ...fills[0]! }, { ...fills[1]!, quantity: 2 }];
  expect((await insertExecutions("sync", input, "sync")).inserted).toBe(3);
  expect((await insertExecutions("sync", input, "sync")).inserted).toBe(0);
  expect(await db.select().from(executions)).toHaveLength(3);
  expect(await db.select().from(trades)).toMatchObject([{ quantity: 2, grossPnl: 20 }]);
  await insertExecutions(
    "sync",
    input.map((fill) => ({ ...fill, fee: 1 })),
    "sync",
  );
  expect(await db.select().from(trades)).toMatchObject([{ netPnl: 17 }]);
  await insertExecutions(
    "sync",
    input.map((fill) => ({ ...fill, fee: 0, feeReported: false })),
    "sync",
  );
  expect(await db.select().from(trades)).toMatchObject([{ netPnl: 17 }]);
});
it("rejects malformed account configuration and bulk annotations before writing", async () => {
  for (const body of [
    { profitCalcMethod: "bogus" },
    { kind: "bogus" },
    { initialBalance: -1 },
    { currency: "invalid" },
    { autoSync: "yes" },
  ])
    expect(
      (await createAccount(request({ name: "account", kind: "manual", ...body }))).status,
    ).toBe(400);
  expect(await db.select().from(accounts)).toHaveLength(0);
  const trade = await closed("source");
  const { POST: bulk } = await import("../src/app/api/trades/bulk/route");
  expect(
    (await bulk(request({ keys: [trade.key], action: "tag", tag: { bad: true } }))).status,
  ).toBe(400);
  expect(
    (await bulk(request({ keys: [trade.key], action: "playbook", playbookId: "missing" }))).status,
  ).toBe(400);
  expect(await db.select().from(trades)).toMatchObject([{ tagsJson: null, playbookId: null }]);
});
it("rejects market CSV commits without configured durable storage", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  const { importCsvDataset, csvDatasets } = await import("../src/server/market-data/csv");
  await expect(
    importCsvDataset({
      name: "data",
      symbol: "TEST",
      resolution: "1m",
      currency: "USD",
      priceBasis: "raw",
      content: "time,open,high,low,close\n2026-01-01T10:00:00Z,100,101,99,100",
    }),
  ).rejects.toThrow("Configure Supabase Storage");
  expect(await csvDatasets()).toHaveLength(0);
});
it("enforces session expiration, signed framing, and password rotation in Node and Edge", async () => {
  const { sessionToken, verifySession } = await import("../src/server/auth");
  const { middleware } = await import("../src/middleware");
  const token = sessionToken();
  expect(verifySession(token)).toBe(true);
  expect(sessionToken()).not.toBe(token);
  const req = () =>
    new NextRequest("https://journal.example/api/trades", {
      headers: { cookie: `journal_session=${token}` },
    });
  expect((await middleware(req())).headers.get("x-middleware-next")).toBe("1");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31 * 86400_000);
  try {
    expect(verifySession(token)).toBe(false);
    expect((await middleware(req())).status).toBe(401);
  } finally {
    vi.useRealTimers();
  }
  expect(verifySession(token.replace(/^v2\.[0-9]+/, "v2.1999999999"))).toBe(false);
  vi.stubEnv("JOURNAL_PASSWORD", "rotated");
  expect(verifySession(token)).toBe(false);
});
it("throttles login attempts across module reloads and resets the shared window", async () => {
  const { POST: login } = await import("../src/app/api/auth/route");
  for (let i = 0; i < 10; i++)
    expect((await login(request({ password: "wrong" }))).status).toBe(401);
  vi.resetModules();
  const { POST: anotherInstance } = await import("../src/app/api/auth/route");
  const blocked = await anotherInstance(request({ password: "authenticated-test-fixture" }));
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  const { takeLoginAttempt } = await import("../src/server/login-throttle");
  expect(await takeLoginAttempt(Date.now() + 61_000)).toBe(0);
});
it("escapes spreadsheet formulas in the actual exported CSV while keeping numbers numeric", async () => {
  const trade = await closed("source");
  await db.update(trades).set({ notes: "=1+1" }).where(eq(trades.key, trade.key));
  const { GET } = await import("../src/app/api/export/route");
  const text = await (
    await GET(new Request("https://journal.example/api/export?format=csv"))
  ).text();
  expect(text).toContain(",'=1+1");
  const { csvCell } = await import("../src/lib/csv-export");
  expect(csvCell(" \t@SUM(A1)")).toBe("' \t@SUM(A1)");
  expect(csvCell(-10)).toBe("-10");
  expect(csvCell("a,b")).toBe('"a,b"');
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  vi.unstubAllEnvs();
  await fixture.close();
});
