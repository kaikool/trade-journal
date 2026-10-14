import { normalizeMarketSymbol } from "@/lib/market-normalize";
import { RESOLUTIONS } from "@/lib/market-data";
import { MarketDataError, type MarketDataProvider } from "./provider";
import { array, number, readJson, record, result, validateBars, windows } from "./http";
const BINANCE = "https://data-api.binance.vision";
const COINBASE = "https://api.exchange.coinbase.com";
export const binance: MarketDataProvider = {
  id: "binance",
  name: "Binance",
  environmentKey: "",
  async test() {
    await readJson(`${BINANCE}/api/v3/time`, {}, undefined, { cache: false });
  },
  async history(rawRequest) {
    const symbol = normalizeMarketSymbol(rawRequest.symbol, "binance");
    if (!/^[A-Z0-9]{4,30}$/.test(symbol))
      throw new MarketDataError("Use a Binance spot symbol such as BTCUSDT.");
    const request = { ...rawRequest, symbol };
    if (request.dataset)
      throw new MarketDataError("Binance uses spot candles; leave the dataset blank.");
    const info = record(
      await readJson(
        `${BINANCE}/api/v3/exchangeInfo?symbol=${encodeURIComponent(request.symbol)}`,
        {},
        request.signal,
      ),
    );
    const market = array(info.symbols)
      .map(record)
      .find((row) => row.symbol === request.symbol);
    if (!market || typeof market.quoteAsset !== "string")
      throw new MarketDataError("Binance spot symbol not found.");
    const history = await windows(request, 999, async (from, to, signal) => {
      const query = new URLSearchParams({
        symbol: request.symbol,
        interval: request.resolution,
        startTime: String(from),
        endTime: String(to - 1),
        limit: "1000",
      });
      return validateBars(
        array(await readJson(`${BINANCE}/api/v3/klines?${query}`, {}, signal)).map((item) => {
          const row = array(item);
          return {
            time: number(row[0]),
            open: number(row[1]),
            high: number(row[2]),
            low: number(row[3]),
            close: number(row[4]),
            volume: number(row[5]),
          };
        }),
      );
    });
    return result(
      this.name,
      request,
      history.bars,
      history.truncated,
      [
        "Binance spot prices may differ from other venues. Quote assets such as USDT are not converted into account currency.",
      ],
      market.quoteAsset,
    );
  },
};
export const coinbase: MarketDataProvider = {
  id: "coinbase",
  name: "Coinbase",
  environmentKey: "",
  async test() {
    await readJson(`${COINBASE}/time`, {}, undefined, { cache: false });
  },
  async history(request) {
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(request.symbol))
      throw new MarketDataError("Use a Coinbase product such as BTC-USD.");
    if (request.dataset)
      throw new MarketDataError("Coinbase uses Exchange spot candles; leave the dataset blank.");
    const history = await windows(request, 299, async (from, to, signal) => {
      const query = new URLSearchParams({
        granularity: String(RESOLUTIONS[request.resolution] / 1000),
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
      });
      return validateBars(
        array(
          await readJson(
            `${COINBASE}/products/${encodeURIComponent(request.symbol)}/candles?${query}`,
            {},
            signal,
          ),
        ).map((item) => {
          const row = array(item);
          return {
            time: number(row[0]) * 1000,
            low: number(row[1]),
            high: number(row[2]),
            open: number(row[3]),
            close: number(row[4]),
            volume: number(row[5]),
          };
        }),
      );
    });
    return result(
      this.name,
      request,
      history.bars,
      history.truncated,
      [
        "Coinbase Exchange spot prices. Candles may be absent when no trades occurred; gaps are never filled with invented prices.",
      ],
      request.symbol.split("-")[1],
    );
  },
};
