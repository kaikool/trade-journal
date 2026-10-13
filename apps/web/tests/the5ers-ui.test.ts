import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ privacy: false }));
vi.mock("../src/components/privacy", () => ({ usePrivacy: () => state.privacy }));
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
      selection: [{ id: "account", label: "Account •1234", autoSync: true }],
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
import { The5ersConnection, The5ersSource } from "../src/components/the5ers";
afterEach(() => {
  state.privacy = false;
});
it("renders reported financial values as text and shows partial coverage", () => {
  const html = renderToStaticMarkup(createElement(The5ersSource, { view: "dashboard" }));
  expect(html).toContain("12345.67");
  expect(html).toContain("snapshot is partial");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("Unsupported platform");
});
it("hides source financial values while journal privacy mode is enabled", () => {
  state.privacy = true;
  const html = renderToStaticMarkup(createElement(The5ersSource, { view: "dashboard" }));
  expect(html).not.toContain("12345.67");
  expect(html).not.toContain("alert(1)");
  expect(html).toContain("Source financial data hidden");
});

it("keeps financial data out of connection settings and provides links to existing sections", () => {
  const html = renderToStaticMarkup(createElement(The5ersConnection));
  expect(html).not.toContain("12345.67");
  expect(html).toContain('href="/accounts"');
  expect(html).toContain('href="/prop-firms"');
});
it("scopes source balances to the same journal account filter", () => {
  const html = renderToStaticMarkup(
    createElement(The5ersSource, { view: "dashboard", query: "accounts=other-account" }),
  );
  expect(html).not.toContain("12345.67");
});
