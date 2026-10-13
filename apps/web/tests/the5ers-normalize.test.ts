import { describe, expect, it } from "vitest";
import {
  normalizePosition,
  normalizePurchase,
  sourceInstant,
  sourceMoney,
} from "../src/lib/the5ers-normalize";
const position = {
  symbol: "EURUSD",
  side: "Buy",
  isClosed: true,
  openDate: "2026-02-01T23:30:00+07:00",
  closeDate: "2026-02-02T00:30:00+07:00",
  entry: 1.1,
  exit: 1.11,
  quantity: 0.2,
  profitAndLoss: 97,
  fee: -2,
  swap: 1,
};
describe("The5ers source normalization", () => {
  it("preserves reported net P&L without subtracting fee/swap or converting lots", () => {
    expect(normalizePosition(position)).toMatchObject({
      openedAt: "2026-02-01T16:30:00.000Z",
      closedAt: "2026-02-01T17:30:00.000Z",
      quantity: 0.2,
      netPnl: 97,
      fee: -2,
      swap: 1,
    });
  });
  it.each([
    "2026-02-30T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-02-01T24:00:00Z",
    "2026-02-01 10:00:00",
    "2026-02-01T10:00:00",
    "yesterday",
  ])("rejects ambiguous or invalid time %s", (value) =>
    expect(sourceInstant(value)).toBeUndefined(),
  );
  it("does not invent exit facts or treat a missing P&L as zero", () => {
    expect(normalizePosition({ ...position, profitAndLoss: undefined })).toBeUndefined();
    expect(normalizePosition({ ...position, closeDate: undefined })).toBeUndefined();
    expect(normalizePosition({ ...position, side: "Correction" })).toBeUndefined();
    expect(normalizePosition({ ...position, isClosed: false })).toMatchObject({
      closedAt: null,
      netPnl: 0,
    });
  });
  it("imports one order in its paid currency, not both price and priceUsd", () => {
    expect(
      normalizePurchase({
        placedAt: "2026-02-01T10:00:00Z",
        status: "completed",
        currency: "EUR",
        price: 180,
        priceUsd: 211.65,
      }),
    ).toMatchObject({ currency: "EUR", amountMinor: 18000, cashVerified: true });
  });
  it("uses line USD netPaid after credits and never guesses an FX cash conversion", () => {
    const order = {
      placedAt: "2026-02-01T10:00:00Z",
      status: "completed",
      currency: "USD",
      price: 100,
      items: [
        { creditsApplied: 20, netPaid: 71.1 },
        { creditsApplied: 0, netPaid: 1.2 },
      ],
    };
    expect(normalizePurchase(order)).toMatchObject({ amountMinor: 7230, cashVerified: true });
    expect(normalizePurchase({ ...order, currency: "EUR" })).toMatchObject({ cashVerified: false });
  });
  it("rejects missing currency, excess precision and unsafe amounts", () => {
    expect(normalizePurchase({ placedAt: "2026-02-01T10:00:00Z", price: 100 })).toBeUndefined();
    expect(sourceMoney(1.001, "USD")).toBeUndefined();
    expect(sourceMoney(123, "JPY")).toBe(123);
    expect(sourceMoney(1.234, "KWD")).toBe(1234);
  });
});
