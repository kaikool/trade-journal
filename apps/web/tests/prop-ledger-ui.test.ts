// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
const state = vi.hoisted(() => ({ urls: [] as string[] }));
const entry = (id: string, firm: string, amountMinor: number) => ({
  id,
  firm,
  amountMinor,
  accountId: null,
  kind: "expense",
  category: "evaluation",
  currency: "USD",
  splitBps: 10000,
  feeMinor: 0,
  occurredOn: "2026-02-01",
  dueOn: null,
  status: "completed",
  parentId: null,
  reference: id,
  notes: "",
  voided: false,
  revision: 1,
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
});
vi.mock("../src/lib/use-api", () => ({
  useApi: (url: string) => {
    state.urls.push(url);
    return {
      data: {
        accounts: [],
        entries: [entry("synced", "The5ers", 10000), entry("manual", "FTMO", 15000)],
        receipts: [],
        today: "2026-02-03",
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
  postJson: vi.fn(),
}));
vi.mock("../src/components/filter-bar", () => ({ FilterBar: () => null }));
vi.mock("../src/components/privacy", () => ({
  usePrivacy: () => false,
  MonetaryValue: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/components/charts/equity-area", () => ({ EquityArea: () => null }));
const { PropFirmTracker } = await import("../src/components/prop-firm-tracker");
afterEach(() => {
  state.urls = [];
});
it("renders synced and manual firms in one transactions table without provider-specific financial lists", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PropFirmTracker)));
    const transactions = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Transactions",
    )!;
    await act(async () => transactions.click());
    expect(container.querySelectorAll("table")).toHaveLength(1);
    const mobile = container.querySelector('[data-testid="transactions-mobile"]')!;
    expect(mobile.classList.contains("md:hidden")).toBe(true);
    expect(mobile.children).toHaveLength(2);
    expect(mobile.textContent).toContain("$100.00");
    expect(mobile.textContent).toContain("$150.00");
    expect(mobile.querySelector(".whitespace-nowrap")?.textContent).toBe("2026-02-01");
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("The5ers");
    expect(container.textContent).toContain("FTMO");
    expect(container.textContent).not.toContain("The5ers expenses");
    expect(container.textContent).not.toContain("The5ers payouts");
    expect(container.textContent).not.toContain("need review");
    expect(new Set(state.urls)).toEqual(new Set(["/api/prop-firms"]));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
