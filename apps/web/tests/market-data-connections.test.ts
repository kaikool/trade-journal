import { createMarketTransport, marketTransport } from "../src/server/market-data/transport";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";

const storageFiles = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          storageFiles.set(path, bytes);
          return { error: null };
        },
        download: async (path: string) => ({
          data: storageFiles.has(path) ? new Blob([storageFiles.get(path)! as BlobPart]) : null,
          error: null,
        }),
        remove: async (paths: string[]) => {
          for (const path of paths) storageFiles.delete(path);
          return { error: null };
        },
      }),
    },
  }),
}));
const testDatabase = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = testDatabase.db;
vi.resetModules();
const { db, settings, accounts, executions, trades, marketCsvDatasets } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { GET: savedHistory, POST: loadHistory } =
  await import("../src/app/api/trades/[key]/market-data/route");
const { GET: listCsv, POST: csvRequest } = await import("../src/app/api/market-data/csv/route");
const { GET: explorer } = await import("../src/app/api/trade-explorer/route");
const { connectionKey, connections, saveConnection } =
  await import("../src/server/market-data/connections");
const { GET, POST } = await import("../src/app/api/market-data/connections/route");
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));
const id = "oanda";
const oandaCredentials = JSON.stringify({
  apiKey: "fixture-token",
  accountId: "001-123",
  environment: "practice",
});
const oandaResponse = (minutes: number[]) =>
  Response.json({
    instrument: "EUR_USD",
    granularity: "M1",
    candles: minutes.map((minute) => ({
      complete: true,
      time: `2026-01-02T10:0${minute}:00.000000000Z`,
      mid: { o: "100", h: "104", l: "98", c: "102" },
      volume: 1,
    })),
  });
const request = (body: unknown) =>
  new Request("http://localhost/api/market-data/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(async () => {
  storageFiles.clear();
  vi.stubEnv("SUPABASE_URL", "https://storage.fixture.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-storage-fixture");
  await db.delete(settings);
  await db.delete(marketCsvDatasets);
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(accounts);
  for (const name of ["OANDA_API_TOKEN", "OANDA_ACCOUNT_ID", "OANDA_ENVIRONMENT"])
    vi.stubEnv(name, "");
  vi.stubEnv("JOURNAL_PASSWORD", "authenticated-test-fixture");
  session.token = (await import("../src/server/auth")).sessionToken();
  vi.stubEnv("JOURNAL_SECRET", "fixture-market-data-secret");
});

describe("trade history endpoint", () => {
  const body = {
    provider: "oanda",
    symbol: "EUR_USD",
    resolution: "1m",
    basisConfirmed: true,
  };
  async function seed(assetClass: "forex" | "option" = "forex") {
    await db
      .insert(accounts)
      .values({ id: "fixture", name: "Fixture", kind: "manual", createdAt: "2026-01-01" });
    await insertExecutions(
      "fixture",
      [
        {
          symbol: "EUR_USD",
          side: "buy",
          quantity: 10,
          price: 100,
          fee: 0,
          executedAt: "2026-01-02T10:00:00Z",
          assetClass,
        },
        {
          symbol: "EUR_USD",
          side: "sell",
          quantity: 10,
          price: 102,
          fee: 0,
          executedAt: "2026-01-02T10:03:00Z",
          assetClass,
        },
      ],
      "manual",
    );
    return (await db.select().from(trades))[0]!.key;
  }
  it("loads candles for reported positions with unknown contract units while leaving monetary estimates unavailable", async () => {
    await seed();
    await db.delete(trades);
    await db.delete(executions);
    const { setSetting } = await import("../src/server/settings");
    const { saveJournalPositions } = await import("../src/server/the5ers/journal");
    const { queryTrades } = await import("../src/server/trades-query");
    await setSetting("the5ers:journal-links", JSON.stringify({ source: "fixture" }));
    await db.transaction((tx) =>
      saveJournalPositions(
        tx,
        "source",
        "USD",
        "2026-01-03T00:00:00Z",
        [
          {
            symbol: "EUR_USD",
            side: "Buy",
            isClosed: true,
            openDate: "2026-01-02T10:00:00Z",
            closeDate: "2026-01-02T10:03:00Z",
            entry: 100,
            exit: 102,
            quantity: 0.25,
            profitAndLoss: 2,
            fee: 0,
            swap: 0,
          },
        ],
        true,
      ),
    );
    const trade = (await queryTrades()).rows[0]!;
    expect(trade.quantityUnitsUnknown).toBe(true);
    await saveConnection(id, oandaCredentials);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oandaResponse([0, 1, 2])),
    );
    const before = await db.select().from(trades);
    const response = await loadHistory(request(body), {
      params: Promise.resolve({ key: trade.key }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bars).toHaveLength(3);
    expect(result.estimate).toMatchObject({ mae: null, mfe: null });
    expect(result.estimate.warnings.join(" ")).toContain("contract size");
    expect(await db.select().from(trades)).toEqual(before);
    expect(await db.select().from(executions)).toHaveLength(0);
  });
  it("persists provider candles in the existing dataset table and storage, then restores a chart with the connection disabled", async () => {
    const key = await seed();
    const { providerFor } = await import("../src/server/market-data/connections");
    const providerRead = vi.spyOn(providerFor(id), "history");
    await saveConnection(id, oandaCredentials);
    const fetcher = vi.fn(async () => oandaResponse([0, 1, 2]));
    vi.stubGlobal("fetch", fetcher);
    const first = await loadHistory(request({ ...body, basisConfirmed: false }), {
      params: Promise.resolve({ key }),
    });
    expect(first.status).toBe(200);
    const loaded = await first.json();
    const datasets = await db.select().from(marketCsvDatasets);
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.id).toMatch(/^provider_cache_/);
    expect(datasets[0]!.barCount).toBe(3);
    expect(
      JSON.parse(Buffer.from(storageFiles.get(datasets[0]!.storagePath)!).toString("utf8")),
    ).toHaveLength(3);
    const calls = fetcher.mock.calls.length;
    await loadHistory(request({ ...body, basisConfirmed: false }), {
      params: Promise.resolve({ key }),
    });
    expect(fetcher.mock.calls).toHaveLength(calls);
    expect(providerRead).toHaveBeenCalledOnce();
    expect(await db.select().from(marketCsvDatasets)).toHaveLength(1);
    await saveConnection(id, null);
    fetcher.mockImplementation(async () => {
      throw new Error("Provider unavailable");
    });
    const reopened = await savedHistory(request({}), { params: Promise.resolve({ key }) });
    expect((await reopened.json()).history.bars).toEqual(loaded.bars);
    expect(fetcher.mock.calls).toHaveLength(calls);
    const manual = await listCsv();
    expect((await manual.json()).datasets).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(settings))).not.toContain("fixture-token");
    providerRead.mockRestore();
  });
  it("extends recent candle coverage by fetching only the tail and retains old candles on a delayed reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-02T10:06:00Z"));
      const { cachedHistory } = await import("../src/server/market-data/cache");
      const open = Date.parse("2026-01-02T10:00:00Z");
      const bar = (time: number) => ({
        time,
        open: 100,
        high: 104,
        low: 98,
        close: 102,
        volume: 1,
      });
      const history = vi.fn(
        async (query: import("../src/server/market-data/provider").HistoryRequest) => ({
          provider: "Fixture",
          symbol: query.symbol,
          resolution: query.resolution,
          bars: [bar(open)],
          fetchedAt: new Date().toISOString(),
          truncated: false,
          warnings: [],
        }),
      );
      const provider = {
        id: "fixture",
        name: "Fixture",
        environmentKey: "",
        test: async () => {},
        history,
      };
      await cachedHistory(
        provider,
        { symbol: "TEST", resolution: "1m", from: open, to: open + 180000 },
        "private-fixture",
      );
      vi.setSystemTime(new Date("2026-01-02T10:17:00Z"));
      history.mockImplementation(async (query) => ({
        provider: "Fixture",
        symbol: query.symbol,
        resolution: query.resolution,
        bars: [bar(open + 900000)],
        fetchedAt: new Date().toISOString(),
        truncated: false,
        warnings: [],
      }));
      const result = await cachedHistory(
        provider,
        { symbol: "TEST", resolution: "1m", from: open, to: open + 960000 },
        "private-fixture",
      );
      expect(history.mock.calls).toHaveLength(2);
      expect(history.mock.calls[1]![0]).toMatchObject({ from: Date.parse("2026-01-02T09:56:00Z") });
      expect(result.history.bars.map((bar) => bar.time)).toEqual([open, open + 900000]);
      expect(await db.select().from(marketCsvDatasets)).toHaveLength(1);
      history.mockRejectedValue(new Error("Source failed"));
      vi.setSystemTime(new Date("2026-01-02T10:19:00Z"));
      const stale = await cachedHistory(
        provider,
        { symbol: "TEST", resolution: "1m", from: open, to: open + 960000 },
        "private-fixture",
      );
      expect(stale.history.bars).toEqual(result.history.bars);
      expect(stale.history.warnings.join(" ")).toContain("Showing saved");
    } finally {
      vi.useRealTimers();
    }
  });
  it("loads candles and estimates without changing journal facts or exposing credentials", async () => {
    const key = await seed();
    await saveConnection(id, oandaCredentials);
    await db.insert(settings).values({ key: "multipliers", value: JSON.stringify({ EUR_USD: 1 }) });
    const before = await db.select().from(trades);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oandaResponse([0, 1, 2])),
    );
    const response = await loadHistory(request(body), { params: Promise.resolve({ key }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const result = await response.json();
    expect(result.estimate).toMatchObject({ mae: 20, mfe: 40 });
    expect(result.bars).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    expect(await db.select().from(trades)).toEqual(before);
    const saved = await (
      await savedHistory(request({}), { params: Promise.resolve({ key }) })
    ).json();
    expect(saved.saved.estimate).toMatchObject({ mae: 20, mfe: 40 });
    const report = await (
      await explorer(new Request("http://localhost/api/trade-explorer?accounts=fixture"))
    ).json();
    expect(report.points).toHaveLength(1);
    expect(report.points[0]).toMatchObject({ key, mae: 20, mfe: 40 });
    const other = await (
      await explorer(new Request("http://localhost/api/trade-explorer?accounts=other"))
    ).json();
    expect(other.points).toEqual([]);
    // Chart-only loads do not erase the earlier, explicitly confirmed estimate.
    const chartOnly = await (
      await loadHistory(request({ ...body, basisConfirmed: false }), {
        params: Promise.resolve({ key }),
      })
    ).json();
    expect(chartOnly.bars).toHaveLength(3);
    expect(chartOnly.estimate.mae).toBeNull();
    expect(
      (await (await savedHistory(request({}), { params: Promise.resolve({ key }) })).json()).saved
        .estimate.mae,
    ).toBe(20);
    await db
      .update(settings)
      .set({ value: JSON.stringify({ EUR_USD: 2 }) })
      .where(eq(settings.key, "multipliers"));
    expect(
      (await (await savedHistory(request({}), { params: Promise.resolve({ key }) })).json()).saved,
    ).toBeNull();
    await db
      .update(settings)
      .set({ value: JSON.stringify({ EUR_USD: 1 }) })
      .where(eq(settings.key, "multipliers"));
    // Account currency and execution changes invalidate derived values, even without a rebuild.
    await db.update(accounts).set({ currency: "EUR" }).where(eq(accounts.id, "fixture"));
    expect(
      (await (await savedHistory(request({}), { params: Promise.resolve({ key }) })).json()).saved,
    ).toBeNull();
    await db.update(accounts).set({ currency: "USD" }).where(eq(accounts.id, "fixture"));
    await db.update(executions).set({ price: 101 }).where(eq(executions.side, "buy"));
    const stale = await (await explorer(new Request("http://localhost/api/trade-explorer"))).json();
    expect(stale.points[0]).toMatchObject({ mae: null, mfe: null });
  });
  it("loads a small range from a large CSV and reuses decoded candles", async () => {
    const { importCsvDataset, marketCsv, csvDatasets, removeCsvDataset } =
      await import("../src/server/market-data/csv");
    const start = Date.parse("2025-01-01T00:00:00Z");
    const id = await importCsvDataset({
      name: "large.csv",
      symbol: "TEST",
      resolution: "1m",
      currency: "USD",
      priceBasis: "raw",
      content:
        "time,open,high,low,close\n" +
        Array.from({ length: 50_000 }, (_, i) => `${start + i * 60_000},100,104,98,102`).join("\n"),
    });
    expect((await csvDatasets())[0]?.count).toBe(50_000);
    const request = {
      symbol: "TEST",
      resolution: "1m" as const,
      from: start + 40_000 * 60_000 + 1000,
      to: start + 40_003 * 60_000,
    };
    const first = await marketCsv.history(request, "");
    expect(first.bars.map((bar) => bar.time)).toEqual(
      [40_000, 40_001, 40_002].map((i) => start + i * 60_000),
    );
    const query = vi.spyOn(testDatabase.client, "query");
    try {
      expect((await marketCsv.history(request, "")).bars).toEqual(first.bars);
      expect(query.mock.calls.every(([sql]) => !String(sql).includes('"bars_json"'))).toBe(true);
    } finally {
      query.mockRestore();
    }
    await removeCsvDataset(id);
    await expect(marketCsv.history(request, "")).rejects.toThrow("No CSV dataset");
  });
  it("validates hundreds of saved estimates with bounded database reads", async () => {
    const { estimateFingerprint, savedEstimates } =
      await import("../src/server/market-data/estimates");
    const { rowToTrade } = await import("../src/server/trades-query");
    const { tradeExcursions } = await import("../src/db");
    await db
      .insert(accounts)
      .values({ id: "batch", name: "Batch", kind: "manual", createdAt: "2025-01-01" });
    const start = Date.parse("2025-01-01T10:00:00Z");
    await insertExecutions(
      "batch",
      Array.from({ length: 401 }, (_, index) => [
        {
          symbol: "TEST",
          side: "buy" as const,
          quantity: 10,
          price: 100,
          fee: 0,
          assetClass: "equity" as const,
          executedAt: new Date(start + index * 86_400_000).toISOString(),
        },
        {
          symbol: "TEST",
          side: "sell" as const,
          quantity: 10,
          price: 102,
          fee: 0,
          assetClass: "equity" as const,
          executedAt: new Date(start + index * 86_400_000 + 180_000).toISOString(),
        },
      ]).flat(),
      "manual",
    );
    const selected = await Promise.all(
      (await db.select().from(trades)).map((row) => rowToTrade(row)),
    );
    expect(selected).toHaveLength(401);
    for (const trade of selected) {
      const fingerprint = await estimateFingerprint(trade);
      await db.insert(tradeExcursions).values({
        tradeKey: trade.key,
        fingerprint,
        provider: "Fixture",
        symbol: "TEST",
        resolution: "1m",
        fetchedAt: "2026-01-01",
        estimateJson: JSON.stringify({ mae: 20, mfe: 40, warnings: [] }),
      });
    }
    const query = vi.spyOn(testDatabase.client, "query");
    try {
      expect((await savedEstimates(selected)).size).toBe(401);
      expect(query.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      query.mockRestore();
    }
  }, 15_000);
  it("rejects missing trades, invalid resolutions, and options before requesting data", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await loadHistory(request(body), { params: Promise.resolve({ key: "missing" }) })).status,
    ).toBe(404);
    const key = await seed("option");
    expect(
      (
        await loadHistory(request({ ...body, resolution: "tick" }), {
          params: Promise.resolve({ key }),
        })
      ).status,
    ).toBe(400);
    expect((await loadHistory(request(body), { params: Promise.resolve({ key }) })).status).toBe(
      400,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await testDatabase.close();
});

describe("market data credential lifecycle", () => {
  it("starts sources disabled without contacting providers", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const state = await connections();
    expect(state).toHaveLength(2);
    expect(state.every((item) => !item.configured && item.source === null)).toBe(true);
    expect(state.map((item) => item.name)).toEqual(
      state.map((item) => item.name).sort((a, b) => a.localeCompare(b)),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    for (const provId of ["binance", "oanda"])
      await expect(connectionKey(provId)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("encrypts saved keys and never returns them from status or save responses", async () => {
    const response = await POST(
      request({
        provider: "oanda",
        action: "save",
        credentials: { apiKey: "fixture-token", accountId: "001-123", environment: "practice" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("fixture-token");
    expect(JSON.stringify(await db.select().from(settings))).not.toContain("fixture-token");
    expect(JSON.parse(await connectionKey("oanda"))).toEqual({
      apiKey: "fixture-token",
      accountId: "001-123",
      environment: "practice",
    });
    expect(await (await GET()).json()).toEqual({
      connections: expect.arrayContaining([
        { id: "oanda", name: "OANDA", configured: true, source: "saved" },
      ]),
    });
    expect((await POST(request({ provider: "oanda", action: "remove" }))).status).toBe(200);
    expect((await connections()).find((c) => c.id === "oanda")?.configured).toBe(false);
    await expect(connectionKey("oanda")).rejects.toThrow("Add a market data API key");
  });
  it("encrypts multi-field credentials, validates complete sets and leaves partial environment configs unavailable", async () => {
    expect(
      (
        await POST(
          request({
            provider: "oanda",
            action: "save",
            credentials: { apiKey: "fixture-token" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({
            provider: "oanda",
            action: "save",
            credentials: { apiKey: "fixture-token", accountId: "001-123", environment: "other" },
          }),
        )
      ).status,
    ).toBe(400);
    const response = await POST(
      request({
        provider: "oanda",
        action: "save",
        credentials: { apiKey: "fixture-token", accountId: "001-123", environment: "practice" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("fixture-token");
    expect(JSON.stringify(await db.select().from(settings))).not.toContain("fixture-token");
    expect(JSON.parse(await connectionKey("oanda"))).toEqual({
      apiKey: "fixture-token",
      accountId: "001-123",
      environment: "practice",
    });
    vi.stubEnv("OANDA_API_TOKEN", "environment-fixture");
    expect((await connections()).find((item) => item.id === "oanda")).toMatchObject({
      configured: false,
      source: "environment",
    });
    await expect(connectionKey("oanda")).rejects.toThrow("Complete all");
    expect((await POST(request({ provider: "oanda", action: "remove" }))).status).toBe(400);
  });
  it("enables and disables public sources explicitly without accepting unnecessary secrets", async () => {
    await expect(connectionKey("binance")).rejects.toThrow("Enable");
    expect(
      (await POST(request({ provider: "binance", action: "save", apiKey: "unused-secret" })))
        .status,
    ).toBe(400);
    expect((await POST(request({ provider: "binance", action: "enable" }))).status).toBe(200);
    expect(await connectionKey("binance")).toBe("");
    expect((await connections()).find((item) => item.id === "binance")).toMatchObject({
      configured: true,
      source: "public",
    });
    expect((await POST(request({ provider: "binance", action: "remove" }))).status).toBe(200);
    await expect(connectionKey("binance")).rejects.toThrow("Enable");
  });
  it("honors environment precedence and refuses misleading saves or removals", async () => {
    await saveConnection("oanda", oandaCredentials);
    vi.stubEnv("OANDA_API_TOKEN", "environment-token");
    vi.stubEnv("OANDA_ACCOUNT_ID", "001-456");
    vi.stubEnv("OANDA_ENVIRONMENT", "live");
    expect(JSON.parse(await connectionKey("oanda"))).toMatchObject({
      apiKey: "environment-token",
      accountId: "001-456",
      environment: "live",
    });
    expect((await connections()).find((item) => item.id === "oanda")?.source).toBe("environment");
    expect((await POST(request({ provider: "oanda", action: "remove" }))).status).toBe(400);
    expect(
      (
        await POST(
          request({
            provider: "oanda",
            action: "save",
            credentials: { apiKey: "replacement", accountId: "001-999", environment: "live" },
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("validates input before changing credentials", async () => {
    for (const credentials of [null, "", " ", 42, { apiKey: "a\nb" }, { apiKey: "a".repeat(4097) }])
      expect((await POST(request({ provider: "oanda", action: "save", credentials }))).status).toBe(
        400,
      );
    expect((await POST(request({ provider: "unknown", action: "remove" }))).status).toBe(400);
    expect((await connections()).find((c) => c.id === "oanda")?.configured).toBe(false);
  });
  it("tests access only on request and does not relay upstream details", async () => {
    const fetcher = vi.fn(async () => new Response("fixture-secret-token", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    await saveConnection("oanda", oandaCredentials);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await POST(request({ provider: "oanda", action: "test" }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("fixture-secret-token");
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("uses the app's authentication gate for reads and writes", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "fixture-password");
    expect((await GET()).status).toBe(401);
    expect((await listCsv()).status).toBe(401);
    expect((await csvRequest(request({ action: "remove", id: "anything" }))).status).toBe(401);
    expect(
      (await POST(request({ provider: "oanda", action: "save", credentials: { apiKey: "token" } })))
        .status,
    ).toBe(401);
    expect((await connections())[0]?.configured).toBe(false);
  });
});

afterEach(() => marketTransport.clear());

beforeEach(() => Object.assign(marketTransport, createMarketTransport({ minIntervalMs: 0 })));
