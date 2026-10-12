// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { listBrokers } from "@luxalgo/broker-sdk";
import { filterEnabledSyncBrokers } from "../src/lib/supported-brokers";

const state = vi.hoisted(() => ({
  post: vi.fn(),
  push: vi.fn(),
  zone: "America/New_York",
  settingsError: null as string | null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/components/filter-bar", () => ({ FilterBar: () => null }));
vi.mock("@/lib/use-api", () => ({
  postJson: (...args: unknown[]) => state.post(...args),
  useApi: (url: string) =>
    url === "/api/brokers"
      ? { data: { brokers: filterEnabledSyncBrokers(listBrokers()) } }
      : {
          data: state.settingsError ? undefined : { importTimeZone: state.zone },
          error: state.settingsError,
        },
}));
// Exercise the journal credential form with the enabled SDK roster. Native controls
// keep this focused on field semantics; the Radix picker is checked in browser QA.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) =>
    createElement(
      "select",
      {
        value,
        onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
      },
      children,
    ),
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) =>
    createElement("option", { value }, children),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => children,
  TabsList: () => null,
  TabsTrigger: () => null,
  TabsContent: ({ value, children }: { value: string; children: ReactNode }) =>
    value === "sync" ? children : null,
}));
const { default: ImportPage } = await import("../src/app/import/page");
const brokers = filterEnabledSyncBrokers(listBrokers());
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.post
    .mockReset()
    .mockResolvedValue({ id: "connected-test", sync: { skipped: 0, skippedReasons: [] } });
  state.push.mockReset();
  state.zone = "America/New_York";
  state.settingsError = null;
  vi.stubGlobal("alert", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ImportPage)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const choose = async (id: string) =>
  act(async () => {
    const select = container.querySelector("select")!;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const fill = async (broker: (typeof brokers)[number]) =>
  act(async () => {
    for (const field of broker.credentials) {
      if (/optional/i.test(field.label)) continue;
      const input = [...container.querySelectorAll("input")].find(
        (input) => input.getAttribute("aria-label") === field.label,
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        `test-${field.key}`,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
const connectButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect & sync",
  )!;

it("exposes only the four brokers enabled for this journal", () => {
  expect(brokers.map((broker) => broker.id)).toEqual(["binance", "bybit", "okx", "topstep"]);
  expect([...container.querySelectorAll("option")].map((option) => option.value).sort()).toEqual(
    brokers.map((broker) => broker.id).sort(),
  );
});
it.each(brokers)(
  "renders and submits $id credentials using a mocked connection response",
  async (broker) => {
    await choose(broker.id);
    expect(container.textContent).toContain(broker.readOnlySetup);
    for (const field of broker.credentials) {
      const input = [...container.querySelectorAll("input")].find(
        (input) => input.getAttribute("aria-label") === field.label,
      );
      expect(input, field.label).toBeTruthy();
      expect(input!.type).toBe(field.secret ? "password" : "text");
    }
    expect(connectButton().disabled).toBe(true);
    await fill(broker);
    expect(connectButton().disabled).toBe(false);
    await act(async () => connectButton().click());
    expect(state.post).toHaveBeenCalledWith("/api/accounts", {
      name: broker.displayName,
      kind: "sync",
      broker: broker.id,
      credentials: Object.fromEntries(
        broker.credentials
          .filter((field) => !/optional/i.test(field.label))
          .map((field) => [field.key, `test-${field.key}`]),
      ),
    });
    expect(state.push).toHaveBeenCalledWith("/?accounts=connected-test");
  },
);
it("reports skipped fills and surfaces connection failures for a retained broker", async () => {
  const broker = brokers.find((item) => item.id === "topstep")!;
  await choose(broker.id);
  await fill(broker);
  state.post.mockRejectedValueOnce(new Error("Topstep rejected test credentials"));
  await act(async () => connectButton().click());
  expect(container.textContent).toContain("Topstep rejected test credentials");
  expect(state.push).not.toHaveBeenCalled();
  state.post.mockResolvedValueOnce({
    id: "corrected",
    sync: { skipped: 2, skippedReasons: ["Ambiguous daylight-saving times"] },
  });
  await act(async () => connectButton().click());
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("2 broker record(s) were skipped"));
  expect(state.push).toHaveBeenCalledWith("/?accounts=corrected");
});
