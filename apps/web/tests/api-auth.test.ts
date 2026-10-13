import { afterEach, describe, expect, it, vi } from "vitest";
import { handler, ok } from "../src/server/api";
import { sessionToken, verifyPassword } from "../src/server/auth";

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  session.token = undefined;
});

describe("required journal password protection", () => {
  it.each([undefined, "", "   "])("blocks handlers when password is %s", async (password) => {
    vi.stubEnv("JOURNAL_PASSWORD", password);
    const action = vi.fn(() => ok({ secret: true }));
    for (const options of [{}, { public: true }]) {
      expect((await handler(action, options)()).status).toBe(503);
    }
    expect(action).not.toHaveBeenCalled();
  });
  it("rejects both missing and forged cookies before executing any handler", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    const action = vi.fn(() => ok({ secret: true }));
    for (const token of [undefined, "forged", "0".repeat(64)]) {
      session.token = token;
      expect((await handler(action)()).status).toBe(401);
    }
    expect(action).not.toHaveBeenCalled();
  });
  it("accepts signed sessions and invalidates them when the password changes", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    session.token = sessionToken();
    expect((await handler(() => ok({ data: true }))()).status).toBe(200);
    vi.stubEnv("JOURNAL_PASSWORD", "new-password");
    expect((await handler(() => ok({ data: true }))()).status).toBe(401);
  });
  it("allows the login endpoint to verify a password without a session", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    expect(verifyPassword("test-password")).toBe(true);
    expect(verifyPassword("wrong-password")).toBe(false);
    expect((await handler(() => ok({ login: true }), { public: true })()).status).toBe(200);
  });
  it("logs the database cause without returning SQL or parameters to the client", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "test-password");
    session.token = sessionToken();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = Object.assign(new Error("password authentication failed for user postgres"), {
      code: "28P01",
    });
    const error = new Error('Failed query: select * from "settings" params: secret-value', {
      cause,
    });
    const response = await handler((_: Request) => Promise.reject(error))(
      new Request("https://journal.example/api/settings"),
    );
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error).toBe("Internal server error");
    expect(body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(log).toHaveBeenCalledWith(
      "[api] Request failed",
      expect.objectContaining({
        requestId: body.requestId,
        path: "/api/settings",
        errorName: "Error",
        causeName: "Error",
        causeCode: "28P01",
        causeMessage: "password authentication failed for user postgres",
      }),
    );
  });
});
