import { expect, it } from "vitest";
import { chartPricePoints } from "../src/lib/trade-chart-points";
const trade = {
  direction: "long",
  openedAt: "2026-01-02T10:00:00Z",
  closedAt: "2026-01-02T10:03:00Z",
  avgEntry: 100,
  avgExit: 102,
};
it("shows reported entry and exit prices without inventing execution quantities", () => {
  const points = chartPricePoints(trade, []);
  expect(points.map((p) => [p.label, p.side, p.price])).toEqual([
    ["ENTRY", "buy", 100],
    ["EXIT", "sell", 102],
  ]);
  expect(points.every((p) => !("quantity" in p))).toBe(true);
  expect(chartPricePoints({ ...trade, direction: "short" }, []).map((p) => p.side)).toEqual([
    "sell",
    "buy",
  ]);
});
it("keeps actual fills when available and omits missing exit prices", () => {
  const fills = [{ executedAt: trade.openedAt, side: "buy" as const, price: 99, quantity: 0.25 }];
  expect(chartPricePoints(trade, fills)).toEqual([{ ...fills[0], label: "BUY 0.25" }]);
  expect(chartPricePoints({ ...trade, avgExit: null }, [])).toHaveLength(1);
});
