// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("../src/components/page-transition", () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/components/luxalgo-mark", () => ({
  LuxAlgoMark: () => createElement("svg", { "aria-hidden": true }),
}));
vi.mock("../src/components/privacy", () => ({
  PrivacyToggle: () => createElement("button", null, "Privacy"),
}));
vi.mock("../src/components/theme", () => ({
  ThemeToggle: () => createElement("button", null, "Theme"),
}));

const { Shell } = await import("../src/components/shell");
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("mobile navigation drawer", () => {
  it("does not show close-navigation tooltip or promotional footer text", async () => {
    vi.useFakeTimers();
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(Shell, { children: createElement("main", null, "Content") }),
        ),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]')!.click(),
    );
    const close = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Close navigation"]',
    )!;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("pointerenter", { bubbles: true }));
      close.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
      vi.advanceTimersByTime(1000);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent ?? "").not.toContain(
      "Close navigation",
    );
    expect(container.textContent).not.toContain("Open source");
    expect(container.textContent).not.toContain("Not investment advice.");
  });
});
