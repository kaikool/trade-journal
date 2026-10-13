// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
const api = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock("../src/lib/use-api", () => ({
  postJson: api.postJson,
  useApi: () => ({
    data: {
      accounts: [
        {
          id: "funded",
          name: "The5ers funded",
          firm: "The5ers",
          currency: "USD",
          program: "funded",
          archived: false,
        },
      ],
      today: "2026-10-14",
    },
  }),
}));
vi.mock("../src/components/privacy", () => ({ usePrivacy: () => false }));
const { The5ersPayouts } = await import("../src/components/the5ers");
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.postJson.mockReset().mockResolvedValue({ status: "imported" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("lets the owner confirm settlement and refreshes cash totals after saving", async () => {
  const changed = vi.fn();
  window.addEventListener("journal-data-changed", changed);
  try {
    await act(async () =>
      root.render(
        createElement(The5ersPayouts, {
          sourceAccountId: "a".repeat(64),
          value: { rows: [{ key: "b".repeat(64), source: { amount: 1000 }, status: "pending" }] },
        }),
      ),
    );
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === label,
      )!;
    await act(async () => button("Record money received").click());
    for (const [label, value] of [
      ["Actual amount received", "780.00"],
      ["Date received", "2026-10-13"],
    ]) {
      const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.postJson).toHaveBeenCalledWith(
      "/api/the5ers",
      expect.objectContaining({
        action: "payout.confirm",
        propAccountId: "funded",
        amount: "780.00",
        receivedOn: "2026-10-13",
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Payouts received has been updated");
  } finally {
    window.removeEventListener("journal-data-changed", changed);
  }
});
