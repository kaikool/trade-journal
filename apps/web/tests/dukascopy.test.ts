import { afterEach, expect, it, vi } from "vitest";
import { compress } from "lzma";
import { dukascopy, decodeArchive, decodeDukascopy } from "../src/server/market-data/dukascopy";
import { dukascopySymbol } from "../src/lib/market-providers";
const start = Date.parse("2025-09-19T00:00:00Z");
function archive(seconds = [0, 60]) {
  const buffer = Buffer.alloc(seconds.length * 24);
  for (const [i, sec] of seconds.entries()) {
    const offset = i * 24;
    buffer.writeUInt32BE(sec, offset);
    buffer.writeUInt32BE(4169000 + i * 1000, offset + 4);
    buffer.writeUInt32BE(4170000 + i * 1000, offset + 8);
    buffer.writeUInt32BE(4168000 + i * 1000, offset + 12);
    buffer.writeUInt32BE(4171000 + i * 1000, offset + 16);
    buffer.writeFloatBE(2, offset + 20);
  }
  return Buffer.from(compress(buffer, 1));
}
afterEach(() => vi.unstubAllGlobals());
it("decodes the public archive's big-endian OHLC records with the gold price scale", () => {
  const bars = decodeArchive(archive(), start, 1000);
  expect(bars).toHaveLength(2);
  expect(bars[0]).toEqual({
    time: start,
    open: 4169,
    close: 4170,
    low: 4168,
    high: 4171,
    volume: 2,
  });
  expect(bars[1]?.time).toBe(start + 60000);
  expect(() => decodeArchive(Buffer.alloc(13, 255), start, 1000)).toThrow();
});
it("decodes delta columns without synthesizing prices for missing minutes", () => {
  const bars = decodeDukascopy({
    timestamp: start,
    shift: 60000,
    multiplier: 0.001,
    open: 4169,
    high: 4171,
    low: 4168,
    close: 4170,
    times: [0, 3],
    opens: [0, 1000],
    highs: [0, 1000],
    lows: [0, 1000],
    closes: [0, 1000],
    volumes: [2, 2],
  });
  expect(bars.map((bar) => bar.time)).toEqual([start, start + 180000]);
  expect(bars[1]?.open).toBe(4170);
});
it("loads historical candles from the public archive with zero-based months and aggregates timeframes", async () => {
  const fetcher = vi.fn(async (_url: string) => new Response(archive()));
  vi.stubGlobal("fetch", fetcher);
  const history = await dukascopy.history(
    { symbol: "XAUUSD", resolution: "5m", from: start, to: start + 300000 },
    "",
  );
  expect(fetcher.mock.calls[0]?.[0]).toContain("/XAUUSD/2025/08/19/BID_candles_min_1.bi5");
  expect(history.bars).toEqual([
    { time: start, open: 4169, high: 4172, low: 4168, close: 4171, volume: 4 },
  ]);
  expect(history.quoteCurrency).toBe("USD");
  expect(dukascopySymbol("XAU/USD")).toBe("XAUUSD");
  expect(dukascopySymbol("AAPL")).toBeNull();
  expect(dukascopySymbol("USDXAU")).toBeNull();
});
it("reports unavailable archives without inventing candles", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Blocked", { status: 403 })),
  );
  await expect(
    dukascopy.history({ symbol: "XAUUSD", resolution: "1m", from: start, to: start + 60000 }, ""),
  ).rejects.toThrow("archive is unavailable");
});

it.each(["1h", "1d"] as const)(
  "loads the native %s archive instead of downloading months of minute files",
  async (resolution) => {
    const origin = resolution === "1h" ? Date.UTC(2025, 8, 1) : Date.UTC(2025, 0, 1);
    const step = resolution === "1h" ? 3600000 : 86400000;
    const offset = (start - origin) / 1000;
    const fetcher = vi.fn(
      async (_url: string) => new Response(archive([offset, offset + step / 1000])),
    );
    vi.stubGlobal("fetch", fetcher);
    const history = await dukascopy.history(
      { symbol: "XAUUSD", resolution, from: start, to: start + 2 * step },
      "",
    );
    expect(history.bars.map((bar) => bar.time)).toEqual([start, start + step]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toContain(
      resolution === "1h" ? "/2025/08/BID_candles_hour_1.bi5" : "/2025/BID_candles_day_1.bi5",
    );
  },
);
