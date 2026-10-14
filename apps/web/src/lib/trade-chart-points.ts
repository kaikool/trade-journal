interface PositionPrices {
  openedAt: string;
  closedAt?: string | null;
  avgEntry: number;
  avgExit?: number | null;
  direction: string;
}
interface FillPrice {
  executedAt: string;
  price: number;
  side: "buy" | "sell";
  quantity: number;
}
export interface ChartPricePoint {
  executedAt: string;
  price: number;
  side: "buy" | "sell";
  label: string;
}
/** Display reported position prices without fabricating execution records or units. */
export function chartPricePoints(trade: PositionPrices, fills: FillPrice[]): ChartPricePoint[] {
  if (fills.length)
    return fills.map((fill) => ({ ...fill, label: `${fill.side.toUpperCase()} ${fill.quantity}` }));
  const points: ChartPricePoint[] = [];
  if (Number.isFinite(Date.parse(trade.openedAt)) && Number.isFinite(trade.avgEntry))
    points.push({
      executedAt: trade.openedAt,
      price: trade.avgEntry,
      side: trade.direction === "long" ? "buy" : "sell",
      label: "ENTRY",
    });
  if (
    trade.closedAt &&
    Number.isFinite(Date.parse(trade.closedAt)) &&
    trade.avgExit != null &&
    Number.isFinite(trade.avgExit)
  )
    points.push({
      executedAt: trade.closedAt,
      price: trade.avgExit,
      side: trade.direction === "long" ? "sell" : "buy",
      label: "EXIT",
    });
  return points;
}
