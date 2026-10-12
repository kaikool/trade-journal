// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({ postJson: vi.fn() }));
vi.mock("@/lib/use-api", () => api);
const { DailyAutoSyncToggle } = await import("../src/components/daily-auto-sync-toggle");
let container: HTMLDivElement;
let root: Root;
const checkbox = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
function setup() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.postJson.mockReset().mockResolvedValue({ updated: true });
}
async function teardown() {
  await act(async () => root.unmount());
  container.remove();
}

it("lets the user turn daily sync off and persists the setting", async () => {
  setup();
  const saved = vi.fn();
  await act(async () =>
    root.render(
      createElement(DailyAutoSyncToggle, { accountId: "broker-1", enabled: true, onSaved: saved }),
    ),
  );
  expect(checkbox().getAttribute("aria-checked")).toBe("true");
  await act(async () => checkbox().click());
  expect(api.postJson).toHaveBeenCalledWith("/api/accounts/broker-1", { autoSync: false }, "PATCH");
  expect(saved).toHaveBeenCalledOnce();
  await teardown();
});

it("lets the user turn daily sync back on", async () => {
  setup();
  await act(async () =>
    root.render(
      createElement(DailyAutoSyncToggle, {
        accountId: "broker-1",
        enabled: false,
        onSaved: vi.fn(),
      }),
    ),
  );
  await act(async () => checkbox().click());
  expect(api.postJson).toHaveBeenCalledWith("/api/accounts/broker-1", { autoSync: true }, "PATCH");
  await teardown();
});
