import { afterEach, describe, expect, it, vi } from "vitest";
const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
import { POST } from "../src/app/api/auth/route";
const login = (password: unknown) =>
  POST(
    new Request("https://journal.example/api/auth", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  );
afterEach(() => {
  vi.unstubAllEnvs();
  jar.set.mockClear();
});
describe("login requires configured authentication", () => {
  it.each([undefined, "", "   "])(
    "returns 503 and never sets a cookie for %s",
    async (password) => {
      vi.stubEnv("JOURNAL_PASSWORD", password);
      expect((await login("")).status).toBe(503);
      expect(jar.set).not.toHaveBeenCalled();
    },
  );
  it("returns 401 for a wrong password and sets a session for the correct password", async () => {
    vi.stubEnv("JOURNAL_PASSWORD", "configured-password");
    expect((await login("wrong")).status).toBe(401);
    expect(jar.set).not.toHaveBeenCalled();
    expect((await login("configured-password")).status).toBe(200);
    expect(jar.set).toHaveBeenCalledWith(
      "journal_session",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });
});
