// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
const api = vi.hoisted(() => ({ postJson: vi.fn(), refresh: vi.fn() }));
vi.mock("../src/lib/use-api", () => ({
  postJson: api.postJson,
  useApi: (url: string) => ({
    loading: false,
    error: null,
    refresh: api.refresh,
    data: url.startsWith("/api/accounts")
      ? { accounts: [] }
      : { connected: true, selection: [], snapshots: [] },
  }),
}));
vi.mock("../src/components/privacy", () => ({
  usePrivacy: () => false,
  MonetaryValue: ({ children }: { children: ReactNode }) => children,
}));
const { The5ersAccounts } = await import("../src/components/the5ers");
const id = "a".repeat(64);
let container: HTMLDivElement, root: Root;
let rejectLink = false,
  rejectSync = false;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rejectLink = false;
  rejectSync = false;
  api.refresh.mockReset();
  api.postJson.mockReset().mockImplementation(async (_url: string, body: { action: string }) => {
    if (body.action === "accounts")
      return {
        accounts: [
          {
            id,
            label: "MT5 •1234",
            platform: "meta-trader-5",
            program: "evaluation",
            createdAt: "2026-02-01T00:00:00Z",
            status: "active",
            currency: "USD",
            source: { balance: 50000 },
          },
        ],
        complete: false,
        warnings: ["The5ers repeated a page."],
      };
    if (body.action === "select") {
      if (rejectLink) throw new Error("Account unavailable");
      return { selection: [{ id, journalAccountId: `the5ers_${id}`, autoSync: false }] };
    }
    if (rejectSync) throw new Error("Refresh unavailable");
    return { snapshot: {} };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const saveButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.startsWith("Save links"),
  )!;
const choose = async () => {
  await act(async () => root.render(createElement(The5ersAccounts)));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Select MT5 •1234"]')!.click(),
  );
};
it("lets a user select and save a verified account despite an incomplete unrelated inventory page, then refreshes history", async () => {
  await choose();
  expect(saveButton().disabled).toBe(false);
  expect(container.querySelector("details")?.open).toBe(false);
  await act(async () => saveButton().click());
  expect(api.postJson).toHaveBeenCalledWith(
    "/api/the5ers",
    expect.objectContaining({ action: "select", ids: [id], linkJournalAccounts: true }),
  );
  expect(api.postJson).toHaveBeenCalledWith("/api/the5ers", { action: "sync", id });
  expect(container.textContent).toContain("Links saved and account history refreshed.");
});
it("does not report saved links or start syncing when link validation fails", async () => {
  rejectLink = true;
  await choose();
  await act(async () => saveButton().click());
  expect(api.postJson.mock.calls.some(([, body]) => body.action === "sync")).toBe(false);
  expect(container.textContent).toContain("We couldn’t complete this request");
  expect(container.textContent).not.toContain("Links saved.");
});
it("explains that links were saved when a subsequent history refresh fails", async () => {
  rejectSync = true;
  await choose();
  await act(async () => saveButton().click());
  expect(container.textContent).toContain("Links saved. 1 account histories could not refresh");
});
