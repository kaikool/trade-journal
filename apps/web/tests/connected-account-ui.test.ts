// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../src/components/filter-bar", () => ({ FilterBar: () => null }));
vi.mock("../src/components/privacy", () => ({
  usePrivacy: () => false,
  MonetaryValue: ({ children }: { children: React.ReactNode }) => children,
  MonetaryField: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/lib/use-api", () => ({
  postJson: vi.fn(),
  useApi: (url: string) => ({
    loading: false,
    error: null,
    refresh: vi.fn(),
    data: url.startsWith("/api/accounts")
      ? {
          accounts: [
            {
              id: "journal",
              name: "My linked account",
              the5ersSourceId: "source",
              kind: "import",
              broker: "The5ers",
              currency: "USD",
              initialBalance: 0,
              profitCalcMethod: "fifo",
              autoSync: false,
              lastSyncAt: null,
              archivedAt: null,
              connected: true,
              snapshot: null,
            },
          ],
        }
      : {
          connected: true,
          selection: [{ id: "source", journalAccountId: "journal" }],
          snapshots: [
            {
              account: { id: "source", label: "MT5 source label", currency: "USD" },
              retrievedAt: "2026-10-13T00:00:00Z",
              sections: {
                balance: {
                  available: true,
                  data: {
                    currency: "USD",
                    data: { initialBalance: 50000, balance: 48711.27, equity: 48711.27 },
                  },
                },
              },
            },
          ],
        },
  }),
}));
const { default: AccountsPage } = await import("../src/app/accounts/page");
it("renders a connected account once with inline balances and keeps linking and irrelevant FIFO controls out of its main card", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(TooltipProvider, { children: createElement(AccountsPage) })),
    );
    expect(container.querySelectorAll('[data-slot="card-header"]')).toHaveLength(1);
    expect(container.textContent).toContain("My linked account");
    expect(container.textContent).toContain("Synced");
    expect(container.textContent).toContain("Starting balance");
    expect(container.textContent).toContain("$50,000.00");
    expect(container.textContent).toContain("$48,711.27");
    expect(container.textContent).not.toContain("MT5 source label");
    expect(container.textContent).not.toContain("Save links");
    expect(container.textContent).not.toContain("Profit calculation");
    expect(container.querySelector("details")?.open).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
