import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ privacy: false, hasPayouts: true, cashComplete: true }));
vi.mock("../src/components/privacy", () => ({
  usePrivacy: () => state.privacy,
  MonetaryValue: ({ children }: { children: React.ReactNode }) =>
    state.privacy ? "Hidden" : children,
}));
vi.mock("../src/lib/use-api", () => ({
  postJson: vi.fn(),
  useApi: () => ({
    loading: false,
    error: null,
    refresh: vi.fn(),
    data: {
      configured: true,
      connected: true,
      canRefresh: true,
      selection: [
        { id: "account", journalAccountId: "account", label: "Account •1234", autoSync: true },
      ],
      cash: { complete: state.cashComplete, failures: [] },
      cashSelection: [
        ...Array.from({ length: 108 }, (_, i) => ({
          id: `empty-${i}`,
          label: `Empty account ${i}`,
          journalAccountId: `empty-${i}`,
          autoSync: false,
        })),
        {
          id: "closed",
          label: "Closed funded account",
          journalAccountId: "historical",
          autoSync: false,
        },
      ],
      cashSnapshots: [
        ...Array.from({ length: 108 }, (_, i) => ({
          account: { id: `empty-${i}`, label: `Empty account ${i}` },
          sections: { payoutHistory: { available: true, data: { rows: [] } } },
        })),
        {
          account: { id: "closed", label: "Closed funded account" },
          retrievedAt: "2026-02-02T00:00:00Z",
          complete: false,
          sections: {
            payoutHistory: {
              available: true,
              data: {
                rows: state.hasPayouts
                  ? [
                      {
                        key: "receipt",
                        source: { amount: 100, currency: "USD" },
                        status: "pending",
                      },
                    ]
                  : [],
              },
            },
          },
          warnings: [],
        },
      ],
      snapshots: [
        {
          account: { id: "account" },
          retrievedAt: "2026-10-13T00:00:00Z",
          complete: false,
          sections: {
            balance: {
              available: true,
              data: { currency: "USD", balance: 12345.67, message: "<script>alert(1)</script>" },
            },
            positions: { available: false, error: "Unsupported platform" },
          },
        },
      ],
    },
  }),
}));
import {
  The5ersConnection,
  The5ersLinkedAccount,
  The5ersBalance,
  The5ersProgramSummary,
} from "../src/components/the5ers";
afterEach(() => {
  state.privacy = false;
  state.hasPayouts = true;
  state.cashComplete = true;
});
it("shows stored balances on the matching linked account", () => {
  const html = renderToStaticMarkup(createElement(The5ersLinkedAccount, { accountId: "account" }));
  expect(html).toContain("12,345.67");
});
it("hides source financial values while journal privacy mode is enabled", () => {
  state.privacy = true;
  const html = renderToStaticMarkup(createElement(The5ersLinkedAccount, { accountId: "account" }));
  expect(html).not.toContain("12,345.67");
  expect(html).not.toContain("alert(1)");
});

it("keeps financial data out of connection settings and provides links to existing sections", () => {
  const html = renderToStaticMarkup(createElement(The5ersConnection));
  expect(html).not.toContain("12,345.67");
  expect(html).toContain('href="/accounts"');
  expect(html).toContain('href="/prop-firms"');
});
it("scopes source balances to the same journal account filter", () => {
  const html = renderToStaticMarkup(
    createElement(The5ersLinkedAccount, { accountId: "other-account" }),
  );
  expect(html).not.toContain("12,345.67");
});

it("labels effective balance separately and does not invent equity when the provider omitted it", () => {
  const html = renderToStaticMarkup(
    createElement(The5ersBalance, {
      value: { currency: "USD", data: { balance: 100, effectiveBalance: 105 } },
    }),
  );
  expect(html).toContain("Effective balance");
  expect(html).not.toContain("Equity");
});

it("renders program rules as compact labelled metrics without raw records", () => {
  const html = renderToStaticMarkup(
    createElement(The5ersProgramSummary, {
      value: {
        currency: "USD",
        data: {
          name: "$50K High Stakes - 2",
          profitTarget: { value: 2500, unit: "currency" },
          maxDailyLoss: { value: 4, unit: "percent" },
          maxTotalLoss: { value: 4000, unit: "currency" },
        },
      },
    }),
  );
  expect(html).toContain("$50K High Stakes - 2");
  expect(html).toContain("$2,500.00");
  expect(html).toContain("4%");
  expect(html).not.toContain("Source details");
  expect(html).not.toContain("<details open");
});

it("keeps financial sync controls in connection settings, without repeating source payments", () => {
  const html = renderToStaticMarkup(createElement(The5ersConnection));
  expect(html).toContain("Synchronize The5ers data");
  expect(html).toContain("Sync now");
  expect(html).not.toContain("Closed funded account");
});

it("formats provider percentages and money without floating point tails or overflowing values", () => {
  const html = renderToStaticMarkup(
    createElement(The5ersProgramSummary, {
      value: {
        currency: "USD",
        data: {
          winRate: 0.22807017543859648,
          totalNetProfit: -1288.7300000000023,
          profitFactor: 0.8102383781662812,
          totalQuantity: 13.940000000000001,
          totalFees: -115.98999999999997,
        },
      },
    }),
  );
  expect(html).toContain("22.8%");
  expect(html).toContain("-$1,288.73");
  expect(html).toContain("0.81");
  expect(html).toContain("13.94");
  expect(html).not.toContain("000000000");
  expect(html).not.toContain("Source details");
});
