import { decompress } from "lzma";
import { DUKASCOPY_PRICE_FACTORS } from "@/lib/dukascopy-instruments";
import { RESOLUTIONS, type MarketBar } from "@/lib/market-data";
import { dukascopySymbol } from "@/lib/market-providers";
import { MarketDataError, type MarketDataProvider } from "./provider";
import { readJson, record, array, number, validateBars, result } from "./http";
const ROOT = "https://jetta.dukascopy.com/v1";

/** Decode provider delta columns, preserving real gaps instead of inventing flat candles. */
export function decodeDukascopy(value: unknown): MarketBar[] {
  const data = record(value);
  const times = array(data.times);
  const columns = ["opens", "highs", "lows", "closes", "volumes"].map((key) => array(data[key]));
  if (columns.some((column) => column.length !== times.length))
    throw new MarketDataError("Dukascopy returned inconsistent candle columns.");
  if (!times.length) return [];
  const multiplier = number(data.multiplier),
    shift = number(data.shift);
  let time = number(data.timestamp);
  const units = ["open", "high", "low", "close"].map((key) =>
    Math.round(number(data[key]) / multiplier),
  );
  if (
    !Number.isFinite(multiplier) ||
    multiplier <= 0 ||
    !Number.isSafeInteger(shift) ||
    shift <= 0 ||
    !Number.isSafeInteger(time) ||
    units.some((v) => !Number.isFinite(v))
  )
    throw new MarketDataError("Dukascopy returned invalid candle metadata.");
  const bars = times.map((delta, index) => {
    if (!Number.isSafeInteger(delta) || Number(delta) < 0)
      throw new MarketDataError("Dukascopy returned invalid candle timestamps.");
    time += Number(delta) * shift;
    for (let c = 0; c < 4; c++) {
      const value = number(columns[c]![index]);
      if (!Number.isSafeInteger(value))
        throw new MarketDataError("Dukascopy returned invalid price deltas.");
      units[c]! += value;
    }
    const prices = units.map((unit) => Number((unit * multiplier).toPrecision(14)));
    return {
      time,
      open: prices[0]!,
      high: prices[1]!,
      low: prices[2]!,
      close: prices[3]!,
      volume: number(columns[4]![index]),
    };
  });
  return validateBars(bars);
}
export function decodeArchive(
  compressed: Buffer,
  start: number,
  factor: number,
  periodSeconds = 86400,
  barSeconds = 60,
): MarketBar[] {
  if (!compressed.length) return [];
  if (compressed.length < 13 || compressed.readUInt32LE(1) > 16 * 1024 * 1024)
    throw new MarketDataError("Invalid Dukascopy archive header.");
  const declaredSize = compressed.readBigUInt64LE(5);
  if (declaredSize !== 0xffffffffffffffffn && declaredSize > 1440n * 24n)
    throw new MarketDataError("Dukascopy archive exceeds the candle limit.");
  let buffer: Buffer;
  try {
    const decoded = decompress(compressed);
    buffer = typeof decoded === "string" ? Buffer.from(decoded, "utf8") : Buffer.from(decoded);
    if (buffer.length > 1440 * 24) throw new Error("Archive exceeds candle limit");
  } catch {
    throw new MarketDataError("Dukascopy candle archive could not be decoded.");
  }
  if (buffer.length % 24) throw new MarketDataError("Invalid Dukascopy candle records.");
  const bars: MarketBar[] = [];
  for (let offset = 0; offset < buffer.length; offset += 24) {
    const seconds = buffer.readUInt32BE(offset);
    if (seconds >= periodSeconds || seconds % barSeconds)
      throw new MarketDataError("Invalid Dukascopy candle timestamp.");
    bars.push({
      time: start + seconds * 1000,
      open: buffer.readUInt32BE(offset + 4) / factor,
      close: buffer.readUInt32BE(offset + 8) / factor,
      low: buffer.readUInt32BE(offset + 12) / factor,
      high: buffer.readUInt32BE(offset + 16) / factor,
      volume: buffer.readFloatBE(offset + 20),
    });
  }
  return validateBars(bars);
}
async function archiveDay(
  symbol: string,
  date: Date,
  signal?: AbortSignal,
  source: "minute" | "hour" | "day" = "minute",
) {
  const next = new Date(+date);
  if (source === "minute") next.setUTCDate(next.getUTCDate() + 1);
  else if (source === "hour") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  const month = String(date.getUTCMonth()).padStart(2, "0"),
    day = String(date.getUTCDate()).padStart(2, "0");
  const suffix =
    source === "day"
      ? "BID_candles_day_1.bi5"
      : source === "hour"
        ? `${month}/BID_candles_hour_1.bi5`
        : `${month}/${day}/BID_candles_min_1.bi5`;
  const url = `https://datafeed.dukascopy.com/datafeed/${symbol}/${date.getUTCFullYear()}/${suffix}`;
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
  } catch {
    throw new MarketDataError(
      "Dukascopy archive request failed or timed out. Saved charts are retained.",
    );
  }
  if (response.status === 404) return [];
  if (!response.ok || !response.body)
    throw new MarketDataError(
      "Dukascopy candle archive is unavailable. Saved charts are retained; try again later.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024)
        throw new MarketDataError("Dukascopy archive exceeds the download limit.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return decodeArchive(
    Buffer.concat(chunks),
    +date,
    DUKASCOPY_PRICE_FACTORS[symbol]!,
    (+next - +date) / 1000,
    source === "day" ? 86400 : source === "hour" ? 3600 : 60,
  );
}
export const dukascopy: MarketDataProvider = {
  id: "dukascopy",
  name: "Dukascopy",
  environmentKey: "",
  async test() {
    await this.history(
      { symbol: "EURUSD", resolution: "1m", from: Date.now() - 3600000, to: Date.now() },
      "",
    );
  },
  async history(request) {
    const symbol = dukascopySymbol(request.symbol);
    if (!symbol)
      throw new MarketDataError("Use a supported forex or metals pair such as EURUSD or XAUUSD.");
    if (request.dataset)
      throw new MarketDataError("Dukascopy uses bid candles; leave the dataset blank.");
    const step = RESOLUTIONS[request.resolution];
    const source =
      request.resolution === "1d" ? "day" : request.resolution === "1h" ? "hour" : "minute";
    const cursor = new Date(request.from);
    cursor.setUTCHours(0, 0, 0, 0);
    if (source === "hour") cursor.setUTCDate(1);
    if (source === "day") cursor.setUTCMonth(0, 1);
    const bars: MarketBar[] = [];
    let pages = 0;
    while (+cursor < request.to && pages++ < 80) {
      const next = new Date(+cursor);
      if (source === "minute") next.setUTCDate(next.getUTCDate() + 1);
      else if (source === "hour") next.setUTCMonth(next.getUTCMonth() + 1);
      else next.setUTCFullYear(next.getUTCFullYear() + 1);
      let rows: MarketBar[];
      if (+next <= Date.now() || source !== "minute")
        rows = await archiveDay(symbol, cursor, request.signal, source);
      else {
        try {
          rows = decodeDukascopy(
            await readJson(
              `${ROOT}/candles/minute/${symbol.slice(0, 3)}-${symbol.slice(3)}/BID?from=${+cursor}`,
              {},
              request.signal,
              { cache: false },
            ),
          );
        } catch {
          rows = await archiveDay(symbol, cursor, request.signal);
        }
      }
      bars.push(...rows);
      cursor.setTime(+next);
    }
    const groups = new Map<number, MarketBar>();
    for (const bar of bars) {
      const time = Math.floor(bar.time / step) * step;
      const previous = groups.get(time);
      groups.set(
        time,
        previous
          ? {
              ...previous,
              high: Math.max(previous.high, bar.high),
              low: Math.min(previous.low, bar.low),
              close: bar.close,
              volume: previous.volume + bar.volume,
            }
          : { ...bar, time },
      );
    }
    return result(
      this.name,
      request,
      [...groups.values()],
      +cursor < request.to,
      ["Dukascopy bid prices may differ from your broker. Latest candles can arrive with a delay."],
      symbol.slice(3),
    );
  },
};
