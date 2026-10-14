"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { chartPricePoints, type ChartPricePoint } from "@/lib/trade-chart-points";
import type { Vela } from "@luxalgo/vela";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import {
  RESOLUTIONS,
  type MarketConnection,
  type ExcursionEstimate,
  type Resolution,
  type TradeMarketResult,
} from "@/lib/market-data";
import { providerInfo } from "@/lib/market-providers";
import { detectProviderForSymbol, normalizeMarketSymbol } from "@/lib/market-normalize";
import { replayFrame } from "@/lib/trade-replay";
import { uploadChartScreenshot } from "@/lib/chart-screenshot-upload";
import { useApi } from "@/lib/use-api";
import { fmtMoney } from "@/lib/utils";
import { TradeChart, type ChartExecution, type ChartTrade } from "./trade-chart";
import { usePrivacy } from "./privacy";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OptionSelect } from "./ui/option-select";

export function TradeMarketData({
  trade,
  executions,
}: {
  trade: ChartTrade & { currency: string };
  executions: ChartExecution[];
}) {
  const privacy = usePrivacy();
  const { data: saved, refresh: refreshSaved } = useApi<{
    saved: { estimate: ExcursionEstimate } | null;
    history?: TradeMarketResult | null;
  }>(`/api/trades/${encodeURIComponent(trade.key)}/market-data`);
  const { data: connections, error: connectionError } = useApi<{ connections: MarketConnection[] }>(
    "/api/market-data/connections",
  );
  const available = connections?.connections.filter((connection) => connection.configured) ?? [];

  // Auto-detect best provider and normalize symbol
  const detectedProvider = useMemo(
    () => detectProviderForSymbol(trade.symbol, trade.assetClass),
    [trade.symbol, trade.assetClass],
  );
  const autoProvider = useMemo(
    () => available.find((c) => c.id === detectedProvider)?.id ?? available[0]?.id ?? "",
    [available, detectedProvider],
  );
  const [providerOverride, setProviderOverride] = useState("");
  const provider = providerOverride || autoProvider;

  const autoSymbol = useMemo(
    () => (provider ? normalizeMarketSymbol(trade.symbol, provider) : trade.symbol),
    [trade.symbol, provider],
  );
  const [symbolOverride, setSymbolOverride] = useState("");
  const symbol = symbolOverride || autoSymbol;

  const [dataset, setDataset] = useState("");
  const [resolution, setResolution] = useState<Resolution>("15m");
  const info = providerInfo(provider);
  const [confirmed, setConfirmed] = useState(true);
  const [result, setResult] = useState<TradeMarketResult | null>(null);
  useEffect(() => {
    if (saved?.history) setResult((current) => current ?? saved.history!);
  }, [saved?.history]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const autoLoadedRef = useRef(false);
  const saveScreenshot = (dataUrl: string) =>
    uploadChartScreenshot(trade.key, trade.symbol, dataUrl);
  useEffect(() => () => controller.current?.abort(), []);
  const invalidate = () => {
    controller.current?.abort();
    setBusy(false);
    setResult(null);
    setError("");
  };
  const load = async (opts?: { resolution?: Resolution }) => {
    const res = opts?.resolution ?? resolution;
    const prov = provider;
    const sym = symbol;
    if (!prov || !available.some((item) => item.id === prov)) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch(`/api/trades/${encodeURIComponent(trade.key)}/market-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: prov,
          symbol: sym,
          dataset,
          resolution: res,
          basisConfirmed: confirmed,
        }),
        signal: request.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "History request failed.");
      if (!request.signal.aborted) {
        setResult(body);
        refreshSaved();
      }
    } catch (cause) {
      if (!request.signal.aborted)
        setError(cause instanceof Error ? cause.message : "History request failed.");
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  };

  // Auto-fetch on mount when trade is closed, provider available, and no saved data yet
  useEffect(() => {
    if (
      autoLoadedRef.current ||
      !trade.closedAt ||
      !provider ||
      !available.length ||
      saved === undefined // still loading
    ) return;
    // If we already have saved history, skip auto-fetch
    if (saved?.history) return;
    autoLoadedRef.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.closedAt, provider, available.length, saved]);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Market data & replay</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {connectionError && (
            <p role="alert" className="text-sm text-destructive">
              {connectionError}
            </p>
          )}
          {!available.length && !saved?.history && (
            <p className="text-sm text-muted-foreground">
              <a className="underline" href="/settings#market-data">
                Connect a market data provider in Settings
              </a>{" "}
              to use historical replay and estimates.
            </p>
          )}
          {!trade.closedAt ? (
            <p className="text-sm text-muted-foreground">Available after this trade closes.</p>
          ) : (
            available.length > 0 && (
              <>
                {/* Auto-detected summary */}
                <p className="text-sm text-muted-foreground">
                  Auto-detected: <strong>{provider}</strong> · <strong>{symbol}</strong> ·{" "}
                  <strong>{resolution}</strong>
                  {busy && " — Loading…"}
                </p>

                {/* Collapsible manual override */}
                <details className="rounded-md border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                    Override provider, symbol, or resolution
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="market-provider">Data provider</Label>
                      <OptionSelect
                        id="market-provider"
                        value={provider}
                        onValueChange={(value) => {
                          invalidate();
                          setProviderOverride(value);
                          setDataset("");
                        }}
                      >
                        {available.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </OptionSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="market-symbol">Provider symbol</Label>
                      <Input
                        id="market-symbol"
                        value={symbol}
                        onChange={(event) => {
                          invalidate();
                          setSymbolOverride(event.target.value);
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="market-resolution">Candle resolution</Label>
                      <OptionSelect
                        id="market-resolution"
                        value={resolution}
                        onValueChange={(value) => {
                          invalidate();
                          setResolution(value as Resolution);
                        }}
                      >
                        {Object.keys(RESOLUTIONS).map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </OptionSelect>
                    </div>
                    {info?.datasets && (
                      <div className="space-y-1">
                        <Label htmlFor="market-dataset">Data feed / dataset</Label>
                        <OptionSelect
                          id="market-dataset"
                          value={dataset}
                          onValueChange={(value) => {
                            invalidate();
                            setDataset(value);
                          }}
                        >
                          {info.datasets.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </OptionSelect>
                      </div>
                    )}
                  </div>
                  <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      className="mt-0.5"
                      onChange={(event) => {
                        invalidate();
                        setConfirmed(event.target.checked);
                      }}
                    />
                    <span>
                      Calculate and save MAE/MFE estimates ({trade.currency}).
                    </span>
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !symbol.trim() || !available.some((item) => item.id === provider)}
                      onClick={() => void load()}
                    >
                      {busy
                        ? "Loading…"
                        : confirmed
                          ? "Load & save estimates"
                          : "Load candles only"}
                    </Button>
                    {busy && (
                      <Button variant="outline" size="sm" onClick={invalidate}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </details>
              </>
            )
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      {!result && saved?.saved && (
        <p className="text-xs text-muted-foreground">
          Previously saved MAE/MFE estimates are shown below. Loading candles without the checkbox
          keeps those saved estimates; it does not calculate new ones.
        </p>
      )}
      {result && result.bars.length > 0 ? (
        <HistoricalReplay
          history={result}
          trade={trade}
          executions={executions}
          privacy={privacy}
          onSaveScreenshot={saveScreenshot}
          currentResolution={resolution}
          onResolutionChange={(res) => {
            setResolution(res);
            void load({ resolution: res });
          }}
          busy={busy}
        />
      ) : (
        <>
          <div
            className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-3"
            aria-label="Market data feature status"
          >
            <div>
              <p className="text-xs text-muted-foreground">Estimated MAE</p>
              <p className="text-sm">
                {busy
                  ? "Loading candles…"
                  : error
                    ? "Data request failed"
                    : saved?.saved
                      ? privacy
                        ? "••••"
                        : fmtMoney(saved.saved.estimate.mae!, trade.currency)
                      : "Load market data to calculate"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Estimated MFE</p>
              <p className="text-sm">
                {busy
                  ? "Loading candles…"
                  : error
                    ? "Data request failed"
                    : saved?.saved
                      ? privacy
                        ? "••••"
                        : fmtMoney(saved.saved.estimate.mfe!, trade.currency)
                      : "Load market data to calculate"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Trade replay</p>
              <p className="text-sm">
                {busy ? "Loading candles…" : "Available after candles load"}
              </p>
            </div>
          </div>
          {result && (
            <p role="status" className="text-sm text-muted-foreground">
              No candles were returned for this instrument and trade period. Check the symbol,
              dataset and plan coverage.
            </p>
          )}
          <TradeChart
            trade={trade}
            executions={executions}
            onSaveScreenshot={privacy ? undefined : saveScreenshot}
          />
        </>
      )}
    </div>
  );
}

export function HistoricalReplay({
  history,
  trade,
  executions,
  privacy,
  onSaveScreenshot,
  currentResolution,
  onResolutionChange,
  busy,
}: {
  history: TradeMarketResult;
  trade: ChartTrade & { currency: string };
  executions: ChartExecution[];
  privacy: boolean;
  onSaveScreenshot?: (dataUrl: string) => Promise<void>;
  currentResolution?: Resolution;
  onResolutionChange?: (resolution: Resolution) => void;
  busy?: boolean;
}) {
  const positionPoints = useMemo(
    () =>
      executions.length || history.estimate.priceBasisMismatch ? [] : chartPricePoints(trade, []),
    [trade, executions, history.estimate.priceBasisMismatch],
  );
  const [count, setCount] = useState(history.bars.length);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("4");
  useEffect(() => {
    setCount(history.bars.length);
    setPlaying(false);
  }, [history]);
  useEffect(() => {
    if (!playing || privacy) return;
    const timer = window.setInterval(
      () => {
        if (!document.hidden) setCount((current) => Math.min(current + 1, history.bars.length));
      },
      1000 / Number(speed),
    );
    return () => window.clearInterval(timer);
  }, [playing, privacy, speed, history.bars.length]);
  useEffect(() => {
    if (count >= history.bars.length || privacy) setPlaying(false);
  }, [count, privacy, history.bars.length]);
  const complete = count === history.bars.length;
  const frame = useMemo(
    () => replayFrame(history, history.estimate.priceBasisMismatch ? [] : executions, count),
    [history, executions, count],
  );
  return (
    <Card className="journal-replay-enter">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Historical candles</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {history.provider} · {history.symbol} · {history.resolution} ·{" "}
            {history.bars.length.toLocaleString()} candles · Retrieved{" "}
            {new Date(history.fetchedAt).toLocaleString()}
          </p>
        </div>
        {onResolutionChange && (
          <div
            className="flex items-center gap-1 rounded-md bg-muted p-1"
            role="group"
            aria-label="Timeframe selector"
          >
            {(["1m", "5m", "15m", "1h", "1d"] as const).map((tf) => (
              <Button
                key={tf}
                variant={(currentResolution ?? history.resolution) === tf ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs font-semibold"
                disabled={busy}
                onClick={() => onResolutionChange(tf)}
              >
                {tf}
              </Button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {privacy ? (
          <p className="text-sm text-muted-foreground">
            Historical prices and excursion amounts are hidden in privacy mode.
          </p>
        ) : (
          <>
            {history.estimate.priceBasisMismatch && (
              <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">
                The market candles and recorded fill prices do not match. Replay shows market
                prices; fill labels and MAE/MFE estimates are withheld. See the data limits below.
              </p>
            )}
            <ReplayChart
              history={history}
              nextFrame={frame}
              positionPoints={positionPoints}
              onSaveScreenshot={onSaveScreenshot}
            />
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2"
              role="group"
              aria-label="Candle replay controls"
            >
              <Button
                variant="outline"
                size="icon"
                aria-label="Restart replay"
                onClick={() => {
                  setPlaying(false);
                  setCount(1);
                }}
              >
                <RotateCcw />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous candle"
                disabled={count <= 1}
                onClick={() => {
                  setPlaying(false);
                  setCount((current) => Math.max(1, current - 1));
                }}
              >
                <ChevronLeft />
              </Button>
              <Button
                className="min-w-24"
                disabled={history.bars.length <= 1}
                onClick={() => {
                  if (complete) setCount(1);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause /> : <Play />}
                {playing ? "Pause" : "Play"}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next candle"
                disabled={complete}
                onClick={() => {
                  setPlaying(false);
                  setCount((current) => Math.min(current + 1, history.bars.length));
                }}
              >
                <ChevronRight />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Show all candles"
                disabled={complete}
                onClick={() => {
                  setPlaying(false);
                  setCount(history.bars.length);
                }}
              >
                <SkipForward />
              </Button>
              <span className="mx-1 text-xs tabular-nums text-muted-foreground" aria-live="off">
                {count.toLocaleString()} / {history.bars.length.toLocaleString()}
              </span>
              <OptionSelect
                aria-label="Replay speed"
                className="ml-auto w-20"
                value={speed}
                onValueChange={setSpeed}
              >
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </OptionSelect>
            </div>
            <input
              aria-label="Replay position"
              type="range"
              min={1}
              max={history.bars.length}
              value={count}
              className="w-full accent-primary"
              onChange={(event) => {
                setPlaying(false);
                setCount(Number(event.target.value));
              }}
            />
            <p className="text-xs text-muted-foreground">
              {count} / {history.bars.length} candles · Through{" "}
              {new Date(frame.through).toISOString()} (UTC). Candles are revealed at bar close; this
              is not a tick-by-tick simulation.
            </p>
          </>
        )}
        <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
          <div>
            <p className="text-xs text-muted-foreground">Estimated MAE · adverse</p>
            <p className="font-medium">
              {privacy
                ? "••••"
                : !complete
                  ? "Hidden during replay"
                  : history.estimate.mae === null
                    ? "Unavailable"
                    : fmtMoney(history.estimate.mae, trade.currency).replace(/^\+/, "")}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated MFE · favorable</p>
            <p className="font-medium">
              {privacy
                ? "••••"
                : !complete
                  ? "Hidden during replay"
                  : history.estimate.mfe === null
                    ? "Unavailable"
                    : fmtMoney(history.estimate.mfe, trade.currency).replace(/^\+/, "")}
            </p>
          </div>
        </div>
        <details className="text-xs text-muted-foreground" open>
          <summary className="cursor-pointer">Data coverage & estimate limits</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {[...history.warnings, ...history.estimate.warnings].map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}

function ReplayChart({
  positionPoints,
  history,
  nextFrame,
  onSaveScreenshot,
}: {
  history: TradeMarketResult;
  positionPoints: ChartPricePoint[];
  nextFrame: ReturnType<typeof replayFrame<ChartExecution>>;
  onSaveScreenshot?: (dataUrl: string) => Promise<void>;
}) {
  // Chart-local identity also works on HTTP LAN origins without crypto.randomUUID.
  const indicatorType = `replay-fills-${useId()}`;
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Vela | null>(null);
  const frame = useRef(nextFrame);
  const latest = useRef(nextFrame);
  latest.current = nextFrame;
  const update = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [captureMessage, setCaptureMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setError("");
    setReady(false);
    void (async () => {
      const { Vela, registerNativeIndicator, unregisterNativeIndicator } =
        await import("@luxalgo/vela");
      if (disposed || !host.current) return;
      const type = indicatorType;
      registerNativeIndicator({
        type,
        title: "Recorded fills",
        paneHint: "price",
        overlay: true,
        inputsSchema: () => [],
        defaultInputs: () => ({}),
        create: () => ({
          start(ctx) {
            ctx.emit({
              labels: [
                ...frame.current.fills.map((fill) => ({
                  ...fill,
                  label: `${fill.side.toUpperCase()} ${fill.quantity}`,
                })),
                ...positionPoints.filter(
                  (point) => Date.parse(point.executedAt) <= frame.current.through,
                ),
              ].map((fill, index) => ({
                id: `fill-${index}`,
                paneId: "price",
                xloc: "bar_time" as const,
                x: Date.parse(fill.executedAt),
                y: fill.price,
                yloc: "price" as const,
                text: fill.label,
                style: "label_left" as const,
                color: fill.side === "buy" ? "#087f23" : "#bd2626",
                textColor: "#ffffff",
                size: "small" as const,
                textAlign: "center" as const,
                fontFamily: "default" as const,
                overlay: true,
              })),
            });
            ctx.setStatus("idle");
          },
          onBars() {},
          onViewport() {},
          setInputs() {},
          suspend() {},
          resume() {},
          stop() {},
        }),
      });
      const dark = () => document.documentElement.classList.contains("dark");
      const instance = new Vela(host.current, {
        symbol: history.symbol,
        timeframe: { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "1d": "1D" }[
          history.resolution
        ],
        data: latest.current.bars,
        live: false,
        height: 420,
        theme: dark() ? "dark" : "light",
        priceStyle: "candles",
        volume: true,
        drawings: false,
      });
      chart.current = instance;
      frame.current = latest.current;
      instance.addNativeIndicator(type);
      let updating = false;
      // Coalesce rapid scrubbing/ticks instead of queuing expensive Vela reloads.
      const flush = async () => {
        if (updating || disposed) return;
        updating = true;
        try {
          do {
            frame.current = latest.current;
            await instance.setMarket({ data: frame.current.bars });
          } while (!disposed && frame.current !== latest.current);
        } catch {
          if (!disposed) setError("The replay chart could not be updated.");
        } finally {
          updating = false;
        }
      };
      update.current = () => {
        void flush();
      };
      const observer = new MutationObserver(() => instance.setTheme(dark() ? "dark" : "light"));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      cleanup = () => {
        update.current = null;
        observer.disconnect();
        instance.destroy();
        unregisterNativeIndicator(type);
        if (chart.current === instance) chart.current = null;
      };
      await instance.ready();
      if (!disposed) setReady(true);
    })().catch(() => {
      if (!disposed) setError("The historical chart could not be rendered.");
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [history, indicatorType, positionPoints]);
  useEffect(() => {
    update.current?.();
  }, [nextFrame, history]);
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div
        className="relative h-[420px] overflow-hidden rounded-lg border"
        aria-busy={!ready && !error}
      >
        {!ready && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-muted/20 text-sm text-muted-foreground"
            role="status"
          >
            Preparing candle replay…
          </div>
        )}
        <div ref={host} className={`h-full ${ready ? "journal-replay-reveal" : "invisible"}`} />
      </div>
      {onSaveScreenshot && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!ready || saving}
            onClick={async () => {
              setSaving(true);
              setCaptureMessage("");
              try {
                const image = chart.current?.renderer.screenshot();
                if (!image) throw new Error("The chart is not ready to capture.");
                await onSaveScreenshot(image);
                setCaptureMessage("Screenshot saved to trade attachments.");
              } catch (cause) {
                setCaptureMessage(cause instanceof Error ? cause.message : "Screenshot failed.");
              } finally {
                setSaving(false);
              }
            }}
          >
            <Camera />
            {saving ? "Saving…" : "Save chart screenshot"}
          </Button>
          {captureMessage && (
            <span
              role={captureMessage.includes("saved") ? "status" : "alert"}
              className="text-xs text-muted-foreground"
            >
              {captureMessage}
            </span>
          )}
        </div>
      )}
    </>
  );
}
