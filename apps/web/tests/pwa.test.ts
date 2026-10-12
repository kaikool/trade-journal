import { expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../src/app/manifest";

const publicDir = resolve(process.cwd(), "apps/web/public");

it("declares an installable standalone journal with real PWA icons", () => {
  expect(manifest()).toMatchObject({
    name: "Trade Journal",
    short_name: "Trade Journal",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  for (const size of ["192x192", "512x512"]) {
    const icon = manifest().icons?.find((candidate) => candidate.sizes === size);
    expect(icon).toBeTruthy();
    expect(icon?.type).toBe("image/png");
    expect(existsSync(resolve(publicDir, icon!.src.replace(/^\//, "")))).toBe(true);
  }
});

it("keeps authenticated API responses out of the service-worker cache", () => {
  const worker = readFileSync(resolve(publicDir, "sw.js"), "utf8");
  expect(worker).toMatch(/\/api\//);
  expect(worker).toMatch(/request\.mode\s*!==\s*["']navigate["']/);
});

it("does not force a translucent black iOS status bar in light appearance", () => {
  const layout = readFileSync(resolve(process.cwd(), "apps/web/src/app/layout.tsx"), "utf8");
  expect(layout).toContain('statusBarStyle: "default"');
  expect(layout).not.toContain('statusBarStyle: "black-translucent"');
  expect(layout).toContain('media: "(prefers-color-scheme: light)"');
});
