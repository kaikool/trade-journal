import { marketCsv } from "./csv";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, marketCsvDatasets, settings } from "@/db";
import { downloadMarketDataset, uploadMarketDataset, removeMarketDataset } from "@/server/storage";
import {
  RESOLUTIONS,
  PROVIDER_DATASET_PREFIX,
  type MarketHistory,
  type ExcursionEstimate,
} from "@/lib/market-data";
import { getSetting, setSetting } from "@/server/settings";
import { validateBars, MAX_BARS } from "./http";
import { MarketDataError, type HistoryRequest, type MarketDataProvider } from "./provider";

const DAY = 86_400_000;
const RECENT = 10 * 60_000;
interface Chunk {
  from: number;
  to: number;
  savedAt: number;
  history: MarketHistory;
  datasetId?: string;
}
const identity = (provider: string, request: HistoryRequest, key: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([1, provider, request.symbol, request.dataset ?? "", request.resolution, key]),
    )
    .digest("hex");
const cacheKey = (id: string, from: number) => `market:candles:${id}:${from}`;
function ranges(request: HistoryRequest) {
  const size = Math.max(DAY, RESOLUTIONS[request.resolution] * 100);
  const result: { from: number; to: number }[] = [];
  for (let from = Math.floor(request.from / size) * size; from < request.to; from += size) {
    if (result.length >= 100)
      throw new MarketDataError("Choose a shorter chart period or coarser resolution.");
    result.push({ from, to: Math.min(from + size, Date.now()) });
  }
  return result;
}
async function readChunk(id: string, from: number): Promise<Chunk | null> {
  const saved = await getSetting(cacheKey(id, from));
  if (!saved) return null;
  const chunk = JSON.parse(saved) as Chunk;
  if (!chunk.datasetId) return chunk;
  const [dataset] = await db
    .select()
    .from(marketCsvDatasets)
    .where(eq(marketCsvDatasets.id, chunk.datasetId));
  if (!dataset) return null;
  const json = await downloadMarketDataset(dataset.storagePath);
  if (!json) return null;
  if (createHash("sha256").update(json).digest("hex") !== dataset.checksum) return null;
  return { ...chunk, history: { ...chunk.history, bars: validateBars(JSON.parse(json)) } };
}
async function storeChunk(id: string, chunk: Chunk) {
  const datasetId = `${PROVIDER_DATASET_PREFIX}${id}_${chunk.from}`;
  const json = JSON.stringify(chunk.history.bars);
  const checksum = createHash("sha256").update(json).digest("hex");
  const path = `market-data/provider-cache/${id}/${chunk.from}/${checksum}.json`;
  if (chunk.history.bars.length) await uploadMarketDataset(path, json);
  let retired: string | undefined;
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: cacheKey(id, chunk.from), value: "null" })
      .onConflictDoNothing();
    await tx
      .select()
      .from(settings)
      .where(eq(settings.key, cacheKey(id, chunk.from)))
      .for("update");

    const [previous] = await tx
      .select()
      .from(marketCsvDatasets)
      .where(eq(marketCsvDatasets.id, datasetId))
      .for("update");
    // A slow earlier fetch must not replace newer or more complete saved coverage.
    const latest = await getSetting(cacheKey(id, chunk.from), tx);
    if (latest) {
      const current = JSON.parse(latest) as Chunk;
      if (current && (current.savedAt > chunk.savedAt || current.to > chunk.to)) return;
    }
    if (chunk.history.bars.length) {
      const row = {
        id: datasetId,
        name: `${chunk.history.provider} · ${chunk.history.symbol}`,
        symbol: chunk.history.symbol,
        resolution: chunk.history.resolution,
        currency: chunk.history.quoteCurrency ?? "",
        priceBasis: "provider-native",
        storagePath: path,
        checksum,
        formatVersion: 1,
        barCount: chunk.history.bars.length,
        firstTime: chunk.history.bars[0]!.time,
        lastTime: chunk.history.bars.at(-1)!.time,
        importedAt: new Date(chunk.savedAt).toISOString(),
      };
      await tx
        .insert(marketCsvDatasets)
        .values(row)
        .onConflictDoUpdate({ target: marketCsvDatasets.id, set: row });
      retired = previous?.storagePath !== path ? previous?.storagePath : undefined;
      await setSetting(
        cacheKey(id, chunk.from),
        JSON.stringify({ ...chunk, datasetId, history: { ...chunk.history, bars: [] } }),
        tx,
      );
    } else {
      await setSetting(cacheKey(id, chunk.from), JSON.stringify(chunk), tx);
    }
  });
  if (retired) await removeMarketDataset(retired).catch(() => {});
}

function combine(request: HistoryRequest, chunks: Chunk[], warnings: string[] = []): MarketHistory {
  const step = RESOLUTIONS[request.resolution];
  const bars = validateBars(chunks.flatMap((chunk) => chunk.history.bars)).filter(
    (bar) =>
      bar.time < request.to && bar.time + step > request.from && bar.time + step <= Date.now(),
  );
  return {
    ...chunks[0]!.history,
    bars: bars.slice(0, MAX_BARS),
    fetchedAt: new Date(Math.max(...chunks.map((c) => c.savedAt))).toISOString(),
    truncated: chunks.some((c) => c.history.truncated) || bars.length > MAX_BARS,
    warnings: [
      ...new Set([
        ...chunks.flatMap((c) => c.history.warnings),
        ...warnings,
        ...(bars.length > MAX_BARS
          ? ["Cached history reached the chart limit. Choose a coarser resolution."]
          : []),
      ]),
    ],
  };
}

/** Persist provider candles in the journal database; finalized history is reused across trades. */
export async function cachedHistory(
  provider: MarketDataProvider,
  request: HistoryRequest,
  key: string,
) {
  if (provider.id === "market-csv")
    return { history: await provider.history(request, key), cacheId: null };
  const id = identity(provider.id, request, key);
  const chunks: Chunk[] = [];
  const warnings: string[] = [];
  let persisted = true;
  for (const range of ranges(request)) {
    const saved = await readChunk(id, range.from);
    const requiredTo = Math.min(range.to, request.to);
    const historical = requiredTo <= Date.now() - RECENT;
    if (
      saved &&
      !saved.history.truncated &&
      saved.to >= requiredTo &&
      (historical || Date.now() - saved.savedAt < 60_000)
    ) {
      chunks.push(saved);
      continue;
    }
    try {
      const history = await provider.history(
        {
          ...request,
          from:
            saved && !saved.history.truncated
              ? Math.max(range.from, saved.to - RECENT)
              : range.from,
          to: range.to,
        },
        key,
      );
      // Recent feeds can revise their latest completed candles; overlap that tail on refresh.
      const chunk: Chunk = { from: range.from, to: range.to, savedAt: Date.now(), history };
      if (saved && !saved.history.truncated)
        chunk.history = {
          ...history,
          bars: validateBars([
            ...new Map(
              [...saved.history.bars, ...history.bars].map((bar) => [bar.time, bar]),
            ).values(),
          ]),
        };
      if (!history.truncated) {
        try {
          await storeChunk(id, chunk);
        } catch {
          persisted = false;
          warnings.push(
            "Candles loaded, but could not be saved to Supabase. Retry to save this chart.",
          );
        }
      }
      chunks.push(chunk);
    } catch (error) {
      if (!saved || saved.history.truncated || saved.to < requiredTo) throw error;
      chunks.push(saved);
      warnings.push("Latest candles could not be refreshed. Showing saved market data.");
    }
  }
  return { history: combine(request, chunks, warnings), cacheId: persisted ? id : null };
}

interface SavedChart {
  cacheId: string;
  request: Omit<HistoryRequest, "signal">;
  tradeIdentity: string;
  estimate?: ExcursionEstimate;
  fingerprint?: string;
  fetchedAt?: string;
}
export const chartIdentity = (trade: {
  symbol: string;
  openedAt: string;
  closedAt?: string | null;
  accountId: string;
}) => JSON.stringify([trade.accountId, trade.symbol, trade.openedAt, trade.closedAt]);
export async function rememberChart(key: string, saved: SavedChart) {
  await setSetting(`market:chart:${key}`, JSON.stringify(saved));
}
/** Loading a saved chart never contacts a provider or requires its credentials. */
export async function savedChart(
  key: string,
  tradeIdentity: string,
): Promise<
  (MarketHistory & { cacheEstimate?: ExcursionEstimate; cacheFingerprint?: string }) | null
> {
  const raw = await getSetting(`market:chart:${key}`);
  if (!raw) return null;
  const saved = JSON.parse(raw) as SavedChart;
  if (saved.tradeIdentity !== tradeIdentity) return null;
  if (saved.cacheId.startsWith("csv:")) {
    try {
      return {
        ...(await marketCsv.history({ ...saved.request, dataset: saved.cacheId.slice(4) }, "")),
        cacheEstimate: saved.estimate,
        cacheFingerprint: saved.fingerprint,
      };
    } catch {
      return null;
    }
  }
  const chunks = await Promise.all(
    ranges(saved.request).map((range) => readChunk(saved.cacheId, range.from)),
  );
  if (
    chunks.some(
      (chunk, index) =>
        !chunk ||
        chunk.history.truncated ||
        chunk.to < Math.min(ranges(saved.request)[index]!.to, saved.request.to),
    )
  )
    return null;
  const history = combine(saved.request, chunks as Chunk[]);
  return {
    ...history,
    cacheEstimate: saved.fetchedAt === history.fetchedAt ? saved.estimate : undefined,
    cacheFingerprint: saved.fingerprint,
  };
}
