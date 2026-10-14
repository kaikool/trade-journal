// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { TradeMarketResult } from "../src/lib/market-data";
const state = vi.hoisted(() => ({
  saved: { saved: null, history: null as TradeMarketResult | null },
  connections: {
    connections: [{ id: "binance", name: "Binance", configured: true, source: "public" }],
  },
  create: vi.fn(),
}));
vi.mock("../src/lib/use-api", () => ({
  useApi: (url: string | null) => ({
    data: url === null ? null : url.includes("connections") ? state.connections : state.saved,
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../src/components/privacy", () => ({ usePrivacy: () => false }));
vi.mock("../src/components/trade-chart", () => ({ TradeChart: () => null }));
vi.mock("@luxalgo/vela", () => ({
  registerNativeIndicator: vi.fn(),
  unregisterNativeIndicator: vi.fn(),
  Vela: class {
    constructor(...args: unknown[]) {
      state.create(...args);
    }
    addNativeIndicator() {}
    ready() {
      return Promise.resolve();
    }
    setTheme() {}
    destroy() {}
    setMarket() {
      return Promise.resolve();
    }
  },
}));
const { TradeMarketData } = await import("../src/components/trade-market-data");
const trade = {
  key: "reported",
  symbol: "BTCUSDT",
  assetClass: "crypto",
  direction: "long",
  openedAt: "2025-09-19T10:00:00Z",
  closedAt: "2025-09-19T10:01:00Z",
  avgEntry: 4169,
  avgExit: 4170,
  netPnl: 1,
  currency: "USDT",
};
const history: TradeMarketResult = {
  provider: "Saved source",
  symbol: "BTCUSDT",
  resolution: "1m",
  fetchedAt: "2025-09-19T11:00:00Z",
  bars: [
    { time: Date.parse(trade.openedAt), open: 4169, high: 4171, low: 4168, close: 4170, volume: 1 },
  ],
  truncated: false,
  warnings: [],
  estimate: { mae: null, mfe: null, sampledBars: 0, excludedBars: 0, warnings: [] },
};
afterEach(() => {
  state.saved.history = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([false, true])(
  "restores saved candles when cached, or auto-fetches when unrendered (cached=%s)",
  async (cached) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    await import("@luxalgo/vela");
    state.saved.history = cached ? history : null;
    const fetcher = vi.fn(async () => Response.json(history));
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(
            TooltipProvider,
            null,
            createElement(TradeMarketData, { trade, executions: [] }),
          ),
        );
      });
      if (cached) {
        expect(container.textContent).toContain("Historical candles");
        expect(state.create.mock.calls[0]?.[1].data).toEqual(history.bars);
        expect(fetcher).not.toHaveBeenCalled();
      } else {
        expect(fetcher).toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
