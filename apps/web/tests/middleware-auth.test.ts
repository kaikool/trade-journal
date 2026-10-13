import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";
import { sessionToken, verifyPassword, verifySession } from "../src/server/auth";

const request = (path: string, token?: string) =>
  new NextRequest(`https://journal.example${path}`, {
    headers: token ? { cookie: `journal_session=${token}` } : {},
  });
afterEach(() => vi.unstubAllEnvs());

describe("mandatory journal authentication", () => {
  it.each([undefined, "", "   "])("fails closed with password %s", async (password) => {
    vi.stubEnv("JOURNAL_PASSWORD", password);
    for (const path of [
      "/",
      "/login",
      "/api/auth",
      "/api/trades",
      "/api/attachments/id",
      "/api/the5ers/client-metadata",
    ]) {
      expect((await middleware(request(path, "forged"))).status).toBe(503);
    }
    expect(verifyPassword("")).toBe(false);
    expect(verifySession("forged")).toBe(false);
    expect(() => sessionToken()).toThrow("JOURNAL_PASSWORD is required");
  });
  it("returns 401 for missing, forged and stale API sessions", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "old-password");
    const stale = sessionToken();
    vi.stubEnv("JOURNAL_PASSWORD", "new-password");
    for (const token of [undefined, "forged", "0".repeat(64), stale]) {
      expect((await middleware(request("/api/trades", token))).status).toBe(401);
      expect((await middleware(request("/", token))).headers.get("location")).toBe(
        "https://journal.example/login",
      );
    }
  });
  it("accepts a server-issued session and allows login without a session", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "configured-password");
    expect(
      (await middleware(request("/api/trades", sessionToken()))).headers.get("x-middleware-next"),
    ).toBe("1");
    for (const path of ["/login", "/api/auth"]) {
      expect((await middleware(request(path))).headers.get("x-middleware-next")).toBe("1");
    }
  });
});

it("allows only the public CIMD metadata GET while keeping source data and changes private", async () => {
  vi.stubEnv("JOURNAL_PASSWORD", "configured-password");
  expect(
    (await middleware(request("/api/the5ers/client-metadata"))).headers.get("x-middleware-next"),
  ).toBe("1");
  expect((await middleware(request("/api/the5ers"))).status).toBe(401);
  expect((await middleware(request("/api/the5ers/client-metadata/extra"))).status).toBe(401);
  expect(
    (
      await middleware(
        new NextRequest("https://journal.example/api/the5ers/client-metadata", { method: "POST" }),
      )
    ).status,
  ).toBe(401);
});
