import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers/postgres";
import { eq } from "drizzle-orm";
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));
const fixture = await createTestDatabase();
(globalThis as { __journalTestDb?: unknown }).__journalTestDb = fixture.db;
vi.resetModules();
const { db, settings, executions, trades } = await import("../src/db");
const { sessionToken } = await import("../src/server/auth");
const { decryptJson, encryptJson } = await import("../src/server/crypto");
const { GET, POST } = await import("../src/app/api/the5ers/route");
const { GET: callback } = await import("../src/app/api/the5ers/callback/route");
const { startAuthorization, finishAuthorization, accessConnection, CONNECTION_KEY, SELECTION_KEY } =
  await import("../src/server/the5ers/oauth");
const {
  parseProviderAccounts,
  listSourceAccounts,
  selectSourceAccounts,
  syncSourceAccount,
  readSourceSection,
  sourceOverview,
  syncScheduledThe5ers,
} = await import("../src/server/the5ers/data");
const { MCP_URL, READ_SCOPES, publicData, officialAuthUrl } =
  await import("../src/server/the5ers/contracts");
const { The5ersMcp } = await import("../src/server/the5ers/mcp");
let epoch = 1,
  denied = false,
  incomplete = false;
// Synthetic contract fixtures, NOT captured or verified authenticated The5ers records.
const account = (label: string, index: number) => ({
  ref: `opaque-account-${epoch}-${index}`,
  label,
  tradingPlatform: "MetaTrader5",
  createdAt: `2026-01-0${index}T10:00:00Z`,
  currency: "USD",
  accountType: "evaluation",
});
let rows: Record<string, unknown>[] = [];
let calls: { tool: string; operation: string; args: Record<string, unknown> }[] = [];
function json(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}
const responseData = (name: string, args: Record<string, unknown>): unknown => {
  const operation = args.operation as string;
  calls.push({ tool: name, operation, args });
  if (name === "the5ers_account" && operation === "list")
    return {
      data: {
        accounts: rows.map((row, index) => ({
          ...row,
          ref: `opaque-account-${epoch}-${index + 1}`,
        })),
      },
      pagination: { has_more: false },
    };
  if (name === "the5ers_positions" && operation === "list")
    return {
      data: {
        positions: [
          {
            position_ref: `opaque-position-${epoch}-${args.page}`,
            symbol: "EURUSD",
            direction: "Buy",
            quantity: 1,
            entry: 1.1,
            exit: 1.11,
            profitAndLoss: 97,
            fee: 2,
            swap: 1,
            isValid: false,
            invalidReasons: ["minimum duration"],
          },
        ],
      },
      pagination: { has_more: incomplete },
    };
  if (name === "the5ers_positions" && ["trades", "detail"].includes(operation))
    return { data: { quantity: 1, price: 1.1, fee: 2, position_ref: args.position_ref } };
  if (name === "the5ers_account" && operation === "balance")
    return {
      currency: "USD",
      freshness: { status: "fresh" },
      data: { balance: 10097, equity: 10097 },
    };
  return {
    currency: "USD",
    data: {
      available: true,
      value: 97,
      apiToken: "never-return-this",
      account_ref: args.account_ref,
    },
  };
};
const request = (body: unknown, origin = "https://journal.example") =>
  new Request("https://journal.example/api/the5ers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
async function connect() {
  const url = new URL(await startAuthorization(session.token!, "https://journal.example"));
  await finishAuthorization(
    new URL(
      `https://journal.example/api/the5ers/callback?state=${url.searchParams.get("state")}&code=synthetic-code`,
    ),
    session.token!,
  );
  return url;
}
beforeEach(async () => {
  await db.delete(settings);
  epoch = 1;
  denied = false;
  incomplete = false;
  calls = [];
  rows = [account("Account •1234", 1), account("Account •5678", 2)];
  vi.stubEnv("JOURNAL_PASSWORD", "the5ers-test-password");
  vi.stubEnv("JOURNAL_SECRET", "the5ers-test-encryption");
  vi.stubEnv("THE5ERS_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("THE5ERS_OAUTH_CLIENT_SECRET", "synthetic-client-secret");
  vi.stubEnv("THE5ERS_REDIRECT_URI", "https://journal.example/api/the5ers/callback");
  vi.stubEnv("THE5ERS_AUTHORIZATION_URL", "https://auth.hub.the5ers.com/synthetic-authorize");
  vi.stubEnv("THE5ERS_TOKEN_URL", "https://auth.hub.the5ers.com/synthetic-token");
  session.token = sessionToken();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://auth.hub.the5ers.com/synthetic-token")
        return json({
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: READ_SCOPES.join(" "),
        });
      if (url !== MCP_URL) throw new Error("Unexpected external request");
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === "initialize")
        return json(
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
          },
          { "Mcp-Session-Id": "synthetic-mcp-session" },
        );
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (denied)
        return new Response("private error containing synthetic-access-token", { status: 401 });
      const data = responseData(rpc.params.name, rpc.params.arguments);
      return json({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: data } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  session.token = undefined;
});
afterAll(async () => {
  delete (globalThis as { __journalTestDb?: unknown }).__journalTestDb;
  await fixture.close();
});
describe("The5ers OAuth and journal access", () => {
  it.each([undefined, "", "   "])(
    "blocks all new routes before data access with password %s",
    async (password) => {
      vi.stubEnv("JOURNAL_PASSWORD", password);
      expect((await GET()).status).toBe(503);
      expect((await POST(request({ action: "accounts" }))).status).toBe(503);
      expect(
        (await callback(new Request("https://journal.example/api/the5ers/callback"))).status,
      ).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects forged journal sessions and cross-origin changes", async () => {
    session.token = "forged";
    expect((await GET()).status).toBe(401);
    expect((await POST(request({ action: "connect" }))).status).toBe(401);
    session.token = sessionToken();
    expect((await POST(request({ action: "connect" }, "https://evil.example"))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses PKCE/state and stores credentials encrypted, with no credential or pending-state exports", async () => {
    const res = await POST(request({ action: "connect" }));
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const authorization = new URL(url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorization.searchParams.get("scope")).toBe(READ_SCOPES.join(" "));
    expect(url).not.toContain("synthetic-client-secret");
    const state = authorization.searchParams.get("state");
    const completed = await callback(
      new Request(
        `https://journal.example/api/the5ers/callback?state=${state}&code=synthetic-code`,
      ),
    );
    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("https://journal.example/the5ers?connected=1");
    const overview = await (await GET()).json();
    expect(overview.connected).toBe(true);
    expect(JSON.stringify(overview)).not.toMatch(
      /synthetic-access-token|synthetic-refresh-token|synthetic-client-secret/,
    );
    const [saved] = await db.select().from(settings).where(eq(settings.key, CONNECTION_KEY));
    expect(saved!.value).not.toContain("synthetic-access-token");
    const { GET: exportJournal } = await import("../src/app/api/export/route");
    expect(
      await (await exportJournal(new Request("https://journal.example/api/export"))).text(),
    ).not.toMatch(/synthetic-access-token|synthetic-refresh-token|the5ers:oauth/);
    await expect(
      finishAuthorization(
        new URL(`https://journal.example/api/the5ers/callback?state=${state}&code=replay`),
        session.token!,
      ),
    ).rejects.toThrow("already used");
  });
  it("binds authorization to the initiating session and requires matching callback origin", async () => {
    const auth = new URL(await startAuthorization(session.token!, "https://journal.example")),
      state = auth.searchParams.get("state");
    await expect(
      finishAuthorization(
        new URL(`https://journal.example/api/the5ers/callback?state=${state}&code=code`),
        sessionToken(),
      ),
    ).rejects.toThrow("expired or was already used");
    await expect(startAuthorization(session.token!, "https://evil.example")).rejects.toThrow(
      "origin",
    );
    await expect(
      finishAuthorization(
        new URL(`https://evil.example/api/the5ers/callback?state=${state}&code=code`),
        session.token!,
      ),
    ).rejects.toThrow("origin");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("expires pending authorization without exchanging the code", async () => {
    const auth = new URL(await startAuthorization(session.token!, "https://journal.example"));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(
      finishAuthorization(
        new URL(
          `https://journal.example/api/the5ers/callback?state=${auth.searchParams.get("state")}&code=code`,
        ),
        session.token!,
      ),
    ).rejects.toThrow("expired");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refreshes expired tokens across fresh client instances, and fails closed without refresh support", async () => {
    await connect();
    const [row] = await db.select().from(settings).where(eq(settings.key, CONNECTION_KEY));
    const value = decryptJson<Record<string, unknown>>(row!.value);
    await db
      .update(settings)
      .set({ value: encryptJson({ ...value, expiresAt: Date.now() - 1 }) })
      .where(eq(settings.key, CONNECTION_KEY));
    await accessConnection();
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === "https://auth.hub.the5ers.com/synthetic-token");
    expect(requests).toHaveLength(2);
    expect(String(requests[1]![1]?.body)).toContain("grant_type=refresh_token");
    await accessConnection();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => url === "https://auth.hub.the5ers.com/synthetic-token"),
    ).toHaveLength(2);
    await db
      .update(settings)
      .set({ value: encryptJson({ ...value, refreshToken: undefined, expiresAt: Date.now() - 1 }) })
      .where(eq(settings.key, CONNECTION_KEY));
    await expect(accessConnection()).rejects.toThrow("Reconnect");
  });
  it("rejects OAuth endpoints outside the official authorization host", () => {
    for (const url of [
      "http://auth.hub.the5ers.com/token",
      "https://auth.hub.the5ers.com.evil.example/token",
      "https://user:password@auth.hub.the5ers.com/token",
      "http://169.254.169.254/",
    ])
      expect(() => officialAuthUrl(url)).toThrow();
  });
});
describe("The5ers source synchronization", () => {
  it("refreshes account refs while retaining selected identity, positions and invalidated trade records", async () => {
    await connect();
    const listed = await listSourceAccounts();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("opaque-account");
    await selectSourceAccounts([listed[0]!.id], true);
    epoch = 2;
    const snapshot = await syncSourceAccount(listed[0]!.id);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.importedExecutions).toBe(0);
    expect(calls.find((call) => call.operation === "balance")!.args.account_ref).toBe(
      "opaque-account-2-1",
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /opaque-account|opaque-position|never-return-this/,
    );
    expect(JSON.stringify(snapshot)).toContain("minimum duration");
    expect(await db.select().from(executions)).toHaveLength(0);
    expect(await db.select().from(trades)).toHaveLength(0);
    const source = snapshot.sections.positions!.data as { rows: { key: string }[] };
    const details = await readSourceSection("fills", listed[0]!.id, source.rows[0]!.key);
    expect(JSON.stringify(details)).not.toContain("opaque-position");
    expect(calls.at(-1)!.args.position_ref).toBe("opaque-position-2-1");
    epoch = 3;
    expect((await syncScheduledThe5ers()).synced).toBe(1);
    expect((await sourceOverview()).snapshots).toHaveLength(1);
  });
  it("rejects ambiguous account identities and missing stable creation timestamps", async () => {
    await connect();
    rows = [account("Same label", 1), account("Same label", 1)];
    await expect(listSourceAccounts()).rejects.toThrow("ambiguous");
    expect(() =>
      parseProviderAccounts({
        accounts: [{ ref: "opaque", label: "Account", platform: "MT5" }],
        pagination: { has_more: false },
      }),
    ).toThrow("matched safely");
  });
  it("does not replace a selected account when creation identity changes", async () => {
    await connect();
    const [first] = await listSourceAccounts();
    await selectSourceAccounts([first!.id], false);
    rows[0]!.createdAt = "2026-02-01T10:00:00Z";
    await expect(syncSourceAccount(first!.id)).rejects.toThrow("identity changed");
    expect(
      await db
        .select()
        .from(settings)
        .where(eq(settings.key, `the5ers:snapshot:${first!.id}`)),
    ).toHaveLength(0);
  });
  it("marks capped history partial and does not invent unavailable data", async () => {
    await connect();
    const [first] = await listSourceAccounts();
    await selectSourceAccounts([first!.id], false);
    incomplete = true;
    const snapshot = await syncSourceAccount(first!.id);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.warnings.join(" ")).toContain("partial");
    const source = snapshot.sections.positions!.data as { rows: unknown[] };
    expect(source.rows).toHaveLength(10);
  });
  it("retains the previous source snapshot when authorization fails and never leaks provider error bodies", async () => {
    await connect();
    const [first] = await listSourceAccounts();
    await selectSourceAccounts([first!.id], true);
    await syncSourceAccount(first!.id);
    denied = true;
    const response = await POST(request({ action: "sync", id: first!.id }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("synthetic-access-token");
    expect((await sourceOverview()).snapshots).toHaveLength(1);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await syncScheduledThe5ers()).toEqual({ checked: 1, synced: 0, failed: 1 });
    spy.mockRestore();
  });
  it("rejects arbitrary operations and client-supplied refs and removes local data on disconnect", async () => {
    await connect();
    const [first] = await listSourceAccounts();
    await selectSourceAccounts([first!.id], true);
    await syncSourceAccount(first!.id);
    expect(
      (await POST(request({ action: "read", resource: "trade", account_ref: "forged" }))).status,
    ).toBe(400);
    await expect(new The5ersMcp("token").read("account", "place_trade", {})).rejects.toThrow(
      "read-only",
    );
    await expect(readSourceSection("__proto__")).rejects.toThrow("supported");
    expect((await POST(request({ action: "disconnect" }))).status).toBe(200);
    expect((await sourceOverview()).snapshots).toHaveLength(0);
    expect(await db.select().from(settings).where(eq(settings.key, CONNECTION_KEY))).toHaveLength(
      0,
    );
  });
  it("redacts refs and credentials recursively while preserving authoritative net P&L", () => {
    expect(
      publicData({
        currency: "USD",
        data: {
          profitAndLoss: 97,
          fee: 2,
          swap: 1,
          account_ref: "private",
          nested: { password: "private" },
        },
      }),
    ).toEqual({ currency: "USD", data: { profitAndLoss: 97, fee: 2, swap: 1, nested: {} } });
  });
});

describe("The5ers transport and cron boundaries", () => {
  it("accepts fragmented SSE, ignores notifications and cancels the response stream", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const rpc = JSON.parse(String(init?.body));
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "initialize")
          return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26" } });
        const text = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ balance: 97, currency: "USD" }) }] } })}\n\n`;
        return new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(text);
              controller.enqueue(bytes.slice(0, 13));
              controller.enqueue(bytes.slice(13));
            },
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    expect(await new The5ersMcp("synthetic-token").read("account", "balance")).toEqual({
      balance: 97,
      currency: "USD",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects oversized requests before invoking external services", async () => {
    const response = await POST(request({ action: "connect", ids: ["x".repeat(17000)] }));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not guess OAuth endpoints after discovery is blocked", async () => {
    vi.stubEnv("THE5ERS_AUTHORIZATION_URL", "");
    vi.stubEnv("THE5ERS_TOKEN_URL", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("oauth-protected-resource")
          ? json({
              resource: MCP_URL,
              authorization_servers: ["https://auth.hub.the5ers.com/verified-issuer"],
            })
          : new Response("Cloudflare block", { status: 403 }),
      ),
    );
    await expect(startAuthorization(session.token!, "https://journal.example")).rejects.toThrow(
      "provider-approved",
    );
    expect(await db.select().from(settings)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("invalidates the older pending authorization when the same session reconnects", async () => {
    const old = new URL(await startAuthorization(session.token!, "https://journal.example"));
    const current = new URL(await startAuthorization(session.token!, "https://journal.example"));
    await expect(
      finishAuthorization(
        new URL(
          `https://journal.example/api/the5ers/callback?state=${old.searchParams.get("state")}&code=old`,
        ),
        session.token!,
      ),
    ).rejects.toThrow("expired");
    expect(fetch).not.toHaveBeenCalled();
    await finishAuthorization(
      new URL(
        `https://journal.example/api/the5ers/callback?state=${current.searchParams.get("state")}&code=current`,
      ),
      session.token!,
    );
    expect((await sourceOverview()).connected).toBe(true);
  });
  it("refreshes opted-in The5ers accounts through the authenticated existing cron route", async () => {
    await connect();
    const [first] = await listSourceAccounts();
    await selectSourceAccounts([first!.id], true);
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
    const { GET: cron } = await import("../src/app/api/cron/broker-sync/route");
    expect((await cron(new Request("https://journal.example/api/cron/broker-sync"))).status).toBe(
      401,
    );
    const response = await cron(
      new Request("https://journal.example/api/cron/broker-sync", {
        headers: { Authorization: "Bearer synthetic-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checked: 1, synced: 1, failed: 0 });
  });
});

it("retains source snapshots and records failures when the cron budget is exhausted", async () => {
  await connect();
  const [first] = await listSourceAccounts();
  await selectSourceAccounts([first!.id], true);
  await syncSourceAccount(first!.id);
  vi.mocked(fetch).mockClear();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await syncScheduledThe5ers(Date.now() - 1)).toEqual({ checked: 1, synced: 0, failed: 1 });
  expect(fetch).not.toHaveBeenCalled();
  expect((await sourceOverview()).snapshots).toHaveLength(1);
  spy.mockRestore();
});

it("rejects expired position references without exposing them or calling the provider", async () => {
  await connect();
  const [first] = await listSourceAccounts();
  await selectSourceAccounts([first!.id], false);
  const snapshot = await syncSourceAccount(first!.id);
  const source = snapshot.sections.positions!.data as { rows: { key: string }[] };
  vi.mocked(fetch).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 11 * 60_000);
  await expect(readSourceSection("position", first!.id, source.rows[0]!.key)).rejects.toThrow(
    "expired",
  );
  expect(fetch).not.toHaveBeenCalled();
});
