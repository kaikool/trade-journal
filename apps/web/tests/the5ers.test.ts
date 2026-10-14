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
  syncSourceCash,
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
  status: "active",
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
      currency: "USD",
      data: {
        positions: [
          {
            position_ref: `opaque-position-${epoch}-${args.page}`,
            symbol: "EURUSD",
            side: "Buy",
            isClosed: true,
            openDate: new Date(Date.UTC(2026, 1, Number(args.page), 10)).toISOString(),
            closeDate: new Date(Date.UTC(2026, 1, Number(args.page), 11)).toISOString(),
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
  if (name === "the5ers_purchase" && operation === "list")
    return { data: { purchases: [] }, pagination: { has_more: false } };
  if (name === "the5ers_payout" && operation === "history")
    return { data: { payouts: [] }, pagination: { has_more: false } };
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
  const { accounts, propAccounts, propAudit, propEntries, propReceipts } =
    await import("../src/db");
  await db.delete(propReceipts);
  await db.delete(propEntries);
  await db.delete(trades);
  await db.delete(executions);
  await db.delete(propAudit);
  await db.delete(propAccounts);
  await db.delete(accounts);
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
      expect((await GET(new Request("https://journal.example/api/the5ers"))).status).toBe(503);
      expect((await POST(request({ action: "accounts" }))).status).toBe(503);
      expect(
        (await callback(new Request("https://journal.example/api/the5ers/callback"))).status,
      ).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects forged journal sessions and cross-origin changes", async () => {
    session.token = "forged";
    expect((await GET(new Request("https://journal.example/api/the5ers"))).status).toBe(401);
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
    expect(completed.headers.get("location")).toBe(
      "https://journal.example/settings?connected=the5ers#the5ers",
    );
    const overview = await (await GET(new Request("https://journal.example/api/the5ers"))).json();
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
    expect(snapshot.warnings.join(" ")).toContain("Position history is incomplete");
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
      "HTTP 403",
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
    expect(await response.json()).toEqual({
      checked: 1,
      synced: 1,
      failed: 0,
      the5ersPurchases: { synced: true, pending: 0 },
    });
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

it("automatically renews expired position refs against the same stable position identity", async () => {
  await connect();
  const [first] = await listSourceAccounts();
  await selectSourceAccounts([first!.id], false);
  const snapshot = await syncSourceAccount(first!.id);
  const source = snapshot.sections.positions!.data as { rows: { key: string }[] };
  vi.mocked(fetch).mockClear();
  calls = [];
  epoch++;
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 11 * 60_000);
  const details = await readSourceSection("position", first!.id, source.rows[0]!.key);
  expect(JSON.stringify(details)).not.toContain("opaque-position");
  expect(
    calls.find((call) => call.tool === "the5ers_positions" && call.operation === "detail")?.args
      .position_ref,
  ).toBe("opaque-position-2-1");
  expect(
    calls.some((call) => call.operation === "balance" || call.operation === "statistics"),
  ).toBe(false);
  const next = await syncSourceAccount(first!.id);
  expect((next.sections.positions!.data as { rows: { key: string }[] }).rows[0]!.key).toBe(
    source.rows[0]!.key,
  );
});

describe("automatic The5ers OAuth registration", () => {
  const issuer = "https://auth.hub.the5ers.com/synthetic-issuer";
  const authorization = "https://auth.hub.the5ers.com/synthetic-authorize";
  const token = "https://auth.hub.the5ers.com/synthetic-token";
  const registration = "https://auth.hub.the5ers.com/synthetic-register";
  function automatic(cimd: boolean, dcr = true, fallback = false) {
    vi.stubEnv("THE5ERS_OAUTH_CLIENT_ID", "");
    vi.stubEnv("THE5ERS_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("THE5ERS_REDIRECT_URI", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("THE5ERS_AUTHORIZATION_URL", "");
    vi.stubEnv("THE5ERS_TOKEN_URL", "");
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("oauth-protected-resource"))
          return json({
            resource: MCP_URL,
            authorization_servers: [issuer],
            scopes_supported: READ_SCOPES,
          });
        if (url.includes(".well-known")) {
          if (fallback && !url.endsWith("/synthetic-issuer/.well-known/openid-configuration"))
            return new Response(null, { status: 404 });
          return json({
            issuer,
            authorization_endpoint: authorization,
            token_endpoint: token,
            registration_endpoint: dcr ? registration : undefined,
            client_id_metadata_document_supported: cimd,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: READ_SCOPES,
          });
        }
        if (url === registration) {
          const data = JSON.parse(String(init?.body));
          return json({
            client_id: "automatically-registered-client",
            token_endpoint_auth_method: "none",
            redirect_uris: data.redirect_uris,
          });
        }
        return original(url, init);
      }),
    );
  }
  it("uses a public metadata URL as client ID without manual credentials and retains refresh support", async () => {
    automatic(true);
    const auth = await connect();
    expect(auth.searchParams.get("client_id")).toBe(
      "https://journal.example/api/the5ers/client-metadata",
    );
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === registration)).toBe(false);
    const [row] = await db.select().from(settings).where(eq(settings.key, CONNECTION_KEY));
    const saved = decryptJson<Record<string, unknown>>(row!.value);
    expect((saved.client as { mode: string }).mode).toBe("cimd");
    await db
      .update(settings)
      .set({ value: encryptJson({ ...saved, expiresAt: Date.now() - 1 }) })
      .where(eq(settings.key, CONNECTION_KEY));
    await accessConnection();
    const exchange = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === token)
      .at(-1)!;
    const params = new URLSearchParams(String(exchange[1]?.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.has("client_secret")).toBe(false);
  });
  it("registers a DCR client once, reuses it and does not export registration settings", async () => {
    automatic(false);
    const first = new URL(await startAuthorization(session.token!, "https://journal.example"));
    const second = new URL(await startAuthorization(session.token!, "https://journal.example"));
    expect(first.searchParams.get("client_id")).toBe("automatically-registered-client");
    expect(second.searchParams.get("client_id")).toBe("automatically-registered-client");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === registration)).toHaveLength(1);
    const stored = await db.select().from(settings);
    expect(stored.filter((row) => row.key.startsWith("the5ers:oauth:client:"))).toHaveLength(1);
    expect(stored.every((row) => !row.value.includes("automatically-registered-client"))).toBe(
      true,
    );
  });
  it("falls back through standard OpenID discovery endpoints on missing metadata", async () => {
    automatic(true, true, true);
    await startAuthorization(session.token!, "https://journal.example");
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes(".well-known")),
    ).toHaveLength(4);
  });
  it("does not register if neither automatic mechanism is advertised", async () => {
    automatic(false, false);
    await expect(startAuthorization(session.token!, "https://journal.example")).rejects.toThrow(
      "not enabled automatic",
    );
    expect(await db.select().from(settings)).toHaveLength(0);
  });
  it("refuses an untrusted registration endpoint instead of posting there", async () => {
    automatic(false);
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.includes("oauth-authorization-server")
          ? json({
              issuer,
              authorization_endpoint: authorization,
              token_endpoint: token,
              registration_endpoint: "https://evil.example/register",
              code_challenge_methods_supported: ["S256"],
            })
          : original(url, init),
      ),
    );
    await expect(startAuthorization(session.token!, "https://journal.example")).rejects.toThrow(
      "official authorization server",
    );
    expect(await db.select().from(settings)).toHaveLength(0);
  });
  it("checks provider capabilities without registering a client or changing settings", async () => {
    automatic(false);
    const response = await POST(request({ action: "check" }));
    expect(response.status).toBe(200);
    expect((await response.json()).method).toBe("dcr");
    expect(await db.select().from(settings)).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === registration)).toBe(false);
  });
  it("serves only public client metadata without a journal session and gates it on the required password", async () => {
    automatic(true);
    session.token = undefined;
    const { GET: metadata } = await import("../src/app/api/the5ers/client-metadata/route");
    const response = await metadata(
      new Request("https://journal.example/api/the5ers/client-metadata"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.client_id).toBe("https://journal.example/api/the5ers/client-metadata");
    expect(data.redirect_uris).toEqual(["https://journal.example/api/the5ers/callback"]);
    expect(JSON.stringify(data)).not.toMatch(/secret|synthetic-access|synthetic-refresh/);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("JOURNAL_PASSWORD", "");
    expect(
      (await metadata(new Request("https://journal.example/api/the5ers/client-metadata"))).status,
    ).toBe(503);
  });
  it("reports registration callback refusal and does not persist a failed DCR client", async () => {
    automatic(false);
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === registration
          ? new Response("secret provider payload", { status: 400 })
          : original(url, init),
      ),
    );
    const response = await POST(request({ action: "connect" }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("client registration failed (HTTP 400)");
    expect(text).toContain("https://journal.example/api/the5ers/callback");
    expect(text).not.toContain("secret provider payload");
    expect(await db.select().from(settings)).toHaveLength(0);
  });
  it("rejects authorization responses with a different issuer before token exchange", async () => {
    automatic(true);
    const auth = new URL(await startAuthorization(session.token!, "https://journal.example"));
    vi.mocked(fetch).mockClear();
    await expect(
      finishAuthorization(
        new URL(
          `https://journal.example/api/the5ers/callback?state=${auth.searchParams.get("state")}&code=code&iss=https://evil.example`,
        ),
        session.token!,
      ),
    ).rejects.toThrow("issuer did not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("links selected source accounts once without inferring starting capital", async () => {
  await connect();
  rows[0]!.type = "evaluation";
  rows[0]!.status = "active";
  const [first] = await listSourceAccounts();
  const { accounts, propAccounts } = await import("../src/db");
  await selectSourceAccounts([first!.id], true, true);
  await selectSourceAccounts([first!.id], true, true);
  const native = await db.select().from(accounts);
  expect(native).toHaveLength(1);
  expect(native[0]!.initialBalance).toBe(0);
  expect((await db.select().from(propAccounts))[0]!.sizeMinor).toBeNull();
  await db
    .update(accounts)
    .set({ name: "Custom name", initialBalance: 50000 })
    .where(eq(accounts.id, native[0]!.id));
  await selectSourceAccounts([first!.id], true, true);
  expect((await db.select().from(accounts))[0]!.name).toBe("Custom name");
});
it("does not interpret disabled as a breached/closed prop account", async () => {
  await connect();
  rows[0]!.type = "evaluation";
  rows[0]!.status = "disabled";
  const [first] = await listSourceAccounts();
  await selectSourceAccounts([first!.id], false, true);
  const { propAccounts } = await import("../src/db");
  expect((await db.select().from(propAccounts)).map((a) => a.status)).toEqual(["inactive"]);
});
it("reads all purchase pages while retaining separate currencies", async () => {
  await connect();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (rpc.method === "tools/call" && rpc.params.name === "the5ers_purchase") {
          const page = rpc.params.arguments.page;
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                currency: page === 1 ? "USD" : "EUR",
                pagination: { has_more: page < 4 },
                data: { purchases: [{ id: `purchase-${page}`, amount: 100 }] },
              },
            },
          });
        }
      }
      return original(url, init);
    }),
  );
  const result = (await readSourceSection("purchases")) as {
    pages: { currency: string }[];
    complete: boolean;
  };
  expect(result.pages).toHaveLength(4);
  expect(result.complete).toBe(true);
  expect(result.pages[1]!.currency).toBe("EUR");
});
it("accepts observed account field aliases and envelope currency", () => {
  const result = parseProviderAccounts({
    currency: "USD",
    data: {
      accounts: [
        {
          ref: "opaque",
          label: "meta-trader-5 · ...1234",
          trading_system: "meta-trader-5",
          created_at: "2026-02-01T00:00:00.000Z",
          type: "evaluation",
          status: "active",
          balance: 50050.25,
        },
      ],
    },
    pagination: { has_more: false },
  });
  expect(result.accounts[0]!.currency).toBe("USD");
  expect(result.accounts[0]!.status).toBe("active");
});
it("links existing history without overwriting it and removes source selection when deleted", async () => {
  await connect();
  rows[0]!.type = "evaluation";
  rows[0]!.status = "active";
  const [first] = await listSourceAccounts();
  const { accounts, propAccounts } = await import("../src/db");
  await db.insert(accounts).values({
    id: "my-history",
    name: "Historical MT5",
    kind: "import",
    broker: "MT5 CSV",
    currency: "USD",
    initialBalance: 50000,
    createdAt: new Date().toISOString(),
  });
  await selectSourceAccounts([first!.id], true, true, { [first!.id]: "my-history" });
  const native = await db.select().from(accounts);
  expect(native).toHaveLength(1);
  expect(native[0]!.name).toBe("Historical MT5");
  expect(native[0]!.initialBalance).toBe(50000);
  expect((await sourceOverview()).selection[0]!.journalAccountId).toBe("my-history");
  expect((await db.select().from(propAccounts))[0]!.journalAccountId).toBe("my-history");
  const { DELETE: remove } = await import("../src/app/api/accounts/[id]/route");
  expect(
    (
      await remove(new Request("https://journal.example/api/accounts/my-history"), {
        params: Promise.resolve({ id: "my-history" }),
      })
    ).status,
  ).toBe(200);
  expect((await sourceOverview()).selection).toHaveLength(0);
  expect(await syncScheduledThe5ers()).toMatchObject({
    checked: 0,
    synced: 0,
    failed: 0,
    purchases: { synced: true },
  });
});
it("rejects conflicting journal links atomically", async () => {
  await connect();
  const listed = await listSourceAccounts();
  const { accounts } = await import("../src/db");
  await db.insert(accounts).values({
    id: "shared-history",
    name: "History",
    kind: "import",
    currency: "USD",
    createdAt: new Date().toISOString(),
  });
  await expect(
    selectSourceAccounts(
      listed.map((a) => a.id),
      true,
      true,
      Object.fromEntries(listed.map((a) => [a.id, "shared-history"])),
    ),
  ).rejects.toThrow("already linked");
  expect(await db.select().from(settings).where(eq(settings.key, SELECTION_KEY))).toHaveLength(0);
  expect(
    await db.select().from(settings).where(eq(settings.key, "the5ers:journal-links")),
  ).toHaveLength(0);
});
it("shows observed balances immediately without resetting capital and skips archived linked journals in cron", async () => {
  await connect();
  rows[0]!.balance = 50050.25;
  rows[0]!.effective_balance = 50050.25;
  const [first] = await listSourceAccounts();
  await selectSourceAccounts([first!.id], true, true);
  const overview = await sourceOverview();
  expect(overview.snapshots[0]!.complete).toBe(false);
  expect(JSON.stringify(overview.snapshots[0]!.sections.balance)).toContain("50050.25");
  const { accounts } = await import("../src/db");
  await db
    .update(accounts)
    .set({ archivedAt: new Date().toISOString() })
    .where(eq(accounts.id, `the5ers_${first!.id}`));
  vi.mocked(fetch).mockClear();
  expect(await syncScheduledThe5ers()).toMatchObject({
    checked: 0,
    synced: 0,
    failed: 0,
    purchases: { synced: true },
  });
  expect(calls.filter((call) => call.tool === "the5ers_positions")).toHaveLength(0);
  expect(calls.filter((call) => call.tool === "the5ers_payout")).toHaveLength(2);
});

it("reuses an existing The5ers prop tracker account linked to the chosen journal", async () => {
  await connect();
  rows[0]!.type = "evaluation";
  rows[0]!.status = "active";
  const [first] = await listSourceAccounts();
  const { accounts, propAccounts } = await import("../src/db");
  const now = new Date().toISOString();
  await db.insert(accounts).values({
    id: "existing-journal",
    name: "History",
    kind: "import",
    currency: "USD",
    createdAt: now,
  });
  await db.insert(propAccounts).values({
    id: "existing-prop",
    firm: "The5ers",
    name: "My challenge",
    program: "evaluation",
    status: "active",
    currency: "USD",
    journalAccountId: "existing-journal",
    openedOn: "2026-01-01",
    notes: "Keep my notes",
    createdAt: now,
    updatedAt: now,
  });
  await selectSourceAccounts([first!.id], false, true, { [first!.id]: "existing-journal" });
  const props = await db.select().from(propAccounts);
  expect(props).toHaveLength(1);
  expect(props[0]!.id).toBe("existing-prop");
  expect(props[0]!.notes).toBe("Keep my notes");
});

it("accepts 115 accounts in a single complete response even when limit 50 is ignored", async () => {
  await connect();
  rows = Array.from({ length: 115 }, (_, i) => ({
    ...account(`Account ${i}`, 1),
    status: i % 3 === 0 ? "disabled" : i % 3 === 1 ? "available" : "active",
  }));
  const result = await POST(request({ action: "accounts" }));
  expect(result.status).toBe(200);
  const data = await result.json();
  expect(data.accounts).toHaveLength(115);
  expect(data.complete).toBe(true);
  expect(data.accounts.some((a: { status: string }) => a.status === "disabled")).toBe(true);
});
it("accepts an unpaginated list when its reported total confirms complete coverage", () => {
  const parsed = parseProviderAccounts({
    currency: "USD",
    data: { total: "2", accounts: [account("One", 1), account("Two", 2)] },
  });
  expect(parsed.hasMore).toBe(false);
  expect(parsed.total).toBe(2);
});
it("links freshly verified selected accounts even when other inventory pages are unavailable", async () => {
  await connect();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (
          rpc.method === "tools/call" &&
          rpc.params.name === "the5ers_account" &&
          rpc.params.arguments.operation === "list"
        )
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                data: { total: 115, accounts: rows },
                pagination: { has_more: false },
              },
            },
          });
      }
      return original(url, init);
    }),
  );
  const response = await POST(request({ action: "accounts" }));
  const data = await response.json();
  expect(data.complete).toBe(false);
  expect(data.accounts).toHaveLength(2);
  const linked = await selectSourceAccounts([data.accounts[0].id], true, true);
  expect(linked[0]?.journalAccountId).toBe(`the5ers_${data.accounts[0].id}`);
  const { accounts } = await import("../src/db");
  expect(await db.select().from(accounts)).toHaveLength(1);
  await expect(selectSourceAccounts(["f".repeat(64)], true, true)).rejects.toThrow(
    "no longer available",
  );
});
it("stops repeated pages while returning visible records with an incomplete warning", async () => {
  await connect();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (
          rpc.method === "tools/call" &&
          rpc.params.name === "the5ers_account" &&
          rpc.params.arguments.operation === "list"
        )
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { structuredContent: { accounts: rows, pagination: { has_more: true } } },
          });
      }
      return original(url, init);
    }),
  );
  const data = await (await POST(request({ action: "accounts" }))).json();
  expect(data.complete).toBe(false);
  expect(data.accounts).toHaveLength(2);
  expect(data.warnings.join(" ")).toContain("repeated");
});
it("keeps available and disabled accounts selectable but enables cron only for active accounts", async () => {
  await connect();
  rows = [
    account("Active", 1),
    { ...account("Available", 2), status: "available" },
    { ...account("Disabled", 3), status: "disabled" },
  ];
  const listed = await listSourceAccounts();
  await selectSourceAccounts(
    listed.map((a) => a.id),
    true,
  );
  const selected = (await sourceOverview()).selection;
  expect(selected.map((a) => a.autoSync)).toEqual([true, false, false]);
  rows[0]!.status = "disabled";
  expect(await syncScheduledThe5ers()).toMatchObject({
    checked: 0,
    synced: 0,
    failed: 0,
    purchases: { synced: true },
  });
  expect((await sourceOverview()).selection).toHaveLength(3);
  const snapshot = await syncSourceAccount(listed[2]!.id);
  expect(snapshot.account.status).toBe("disabled");
});

it("syncs the official ref/side/date position shape into authenticated Trades and Dashboard, once", async () => {
  await connect();
  const first = (await listSourceAccounts())[0]!;
  const selection = await POST(
    request({ action: "select", ids: [first.id], autoSync: false, linkJournalAccounts: true }),
  );
  expect(selection.status).toBe(200);
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (
          rpc.method === "tools/call" &&
          rpc.params.name === "the5ers_positions" &&
          rpc.params.arguments.operation === "list"
        )
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                currency: "USD",
                pagination: { has_more: false },
                data: {
                  positions: [
                    {
                      ref: `position-${epoch}`,
                      symbol: "EURUSD",
                      side: "Buy",
                      isClosed: true,
                      openDate: "2026-02-01T23:30:00Z",
                      closeDate: "2026-02-02T00:30:00Z",
                      entry: 1.1,
                      exit: 1.11,
                      quantity: 0.2,
                      profitAndLoss: 97,
                      fee: -2,
                      swap: 1,
                    },
                  ],
                },
              },
            },
          });
      }
      return original(url, init);
    }),
  );
  expect((await POST(request({ action: "sync", id: first.id }))).status).toBe(200);
  epoch++;
  expect((await POST(request({ action: "sync", id: first.id }))).status).toBe(200);
  const { GET: getTrades } = await import("../src/app/api/trades/route");
  const { GET: getStats } = await import("../src/app/api/stats/route");
  const { GET: getTrade } = await import("../src/app/api/trades/[key]/route");
  const list = await (
    await getTrades(new Request("https://journal.example/api/trades?view=list"))
  ).json();
  expect(list.trades).toHaveLength(1);
  expect(list.trades[0]).toMatchObject({
    netPnl: 97,
    fees: 1,
    grossPnl: 98,
    source: "the5ers",
  });
  const stats = await (await getStats(new Request("https://journal.example/api/stats"))).json();
  expect(stats.metrics).toMatchObject({ netPnl: 97, closedTrades: 1, fees: 1, grossPnl: 98 });
  const detail = await (
    await getTrade(new Request("https://journal.example/api/trades/position"), {
      params: Promise.resolve({ key: list.trades[0].key }),
    })
  ).json();
  expect(detail.executions).toEqual([]);
  expect(detail.trade).toMatchObject({ reportedFee: -2, reportedSwap: 1, netPnl: 97 });
  const snapshot = (await sourceOverview()).snapshots[0]!;
  const positions = snapshot.sections.positions!.data as { rows: { hasDetails: boolean }[] };
  expect(positions.rows[0]!.hasDetails).toBe(true);
});

it("imports completed order cash through the authenticated endpoint without charging its USD conversion twice", async () => {
  await connect();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (rpc.method === "tools/call" && rpc.params.name === "the5ers_purchase")
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                pagination: { has_more: false },
                data: {
                  purchases: [
                    {
                      ref: `purchase-${epoch}`,
                      status: "completed",
                      placedAt: "2026-02-01T10:00:00Z",
                      price: 180,
                      priceUsd: 211.65,
                      currency: "EUR",
                    },
                  ],
                },
              },
            },
          });
      }
      return original(url, init);
    }),
  );
  const first = await POST(request({ action: "purchases.sync" }));
  expect(first.status).toBe(200);
  expect((await first.json()).data).toMatchObject({ imported: 1, matched: 0 });
  epoch++;
  expect((await (await POST(request({ action: "purchases.sync" }))).json()).data).toMatchObject({
    imported: 0,
    matched: 1,
  });
  const { propEntries } = await import("../src/db");
  const ledger = await db.select().from(propEntries);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ amountMinor: 18000, currency: "EUR" });
});

it("uses corroborated account currency when a position page omits redundant metadata", async () => {
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false, true);
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL) {
        const rpc = JSON.parse(String(init?.body));
        if (
          rpc.method === "tools/call" &&
          rpc.params.name === "the5ers_positions" &&
          rpc.params.arguments.operation === "list"
        ) {
          const page = rpc.params.arguments.page;
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                ...(page === 1 ? { currency: "USD" } : {}),
                pagination: { has_more: page === 1 },
                data: {
                  positions: [
                    {
                      ref: `page-${page}`,
                      symbol: "EURUSD",
                      side: "Buy",
                      isClosed: true,
                      openDate: new Date(Date.UTC(2026, 1, page, 10)).toISOString(),
                      closeDate: new Date(Date.UTC(2026, 1, page, 11)).toISOString(),
                      entry: 1.1,
                      exit: 1.11,
                      quantity: 0.2,
                      profitAndLoss: 97,
                    },
                  ],
                },
              },
            },
          });
        }
      }
      return original(url, init);
    }),
  );
  const snapshot = await syncSourceAccount(first.id);
  expect(snapshot.journaledPositions).toBe(2);
  const { queryTrades } = await import("../src/server/trades-query");
  expect((await queryTrades()).trades).toHaveLength(2);
});

it("imports or confirms payout settlements through the authenticated endpoint and serves saved history without another provider read", async () => {
  rows[0]!.accountType = "Funded";
  rows[0]!.status = "Active";
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false, true);
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (rpc.params?.name === "the5ers_payout")
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                data: {
                  withdrawals: [
                    {
                      withdrawalId: "known-payout",
                      status: "completed",
                      currency: "USD",
                      amount: 1000,
                      requestedAt: "2026-02-01T10:00:00Z",
                    },
                  ],
                },
                pagination: { has_more: false },
              },
            },
          });
      }
      return original(url, init);
    }),
  );
  const loaded = (await readSourceSection("payoutHistory", first.id)) as {
    rows: { key: string; status: string }[];
    pending: number;
  };
  expect(loaded.pending).toBe(1);
  expect(
    (
      await POST(
        request({
          action: "payout.confirm",
          id: first.id,
          payoutKey: "f".repeat(64),
          propAccountId: `the5ers_${first.id}`,
          amount: "780",
          receivedOn: "2026-02-02",
        }),
      )
    ).status,
  ).toBe(400);
  const confirm = () =>
    POST(
      request({
        action: "payout.confirm",
        id: first.id,
        payoutKey: loaded.rows[0]!.key,
        propAccountId: `the5ers_${first.id}`,
        amount: "780",
        receivedOn: "2026-02-02",
      }),
    );
  expect((await confirm()).status).toBe(200);
  expect((await confirm()).status).toBe(200);
  const { propReceipts } = await import("../src/db");
  expect(await db.select().from(propReceipts)).toHaveLength(1);
  expect((await db.select().from(propReceipts))[0]).toMatchObject({ amountMinor: 78000 });
  await syncSourceAccount(first.id);
  const external = vi.mocked(fetch).mock.calls.length;
  const overview = await sourceOverview();
  expect(vi.mocked(fetch).mock.calls.length).toBe(external);
  expect(overview.snapshots[0]!.sections.payoutHistory?.data).toMatchObject({
    rows: [expect.objectContaining({ status: "matched" })],
  });
});

it("imports old saved snapshot positions without refetching The5ers and rejects conflicting account currency", async () => {
  rows[0]!.accountType = "High Stakes";
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false, true);
  const { SNAPSHOT_PREFIX } = await import("../src/server/the5ers/oauth");
  const { snapshotCurrency } = await import("../src/server/the5ers/data");
  const snapshot = {
    account: first,
    retrievedAt: "2026-10-13T10:00:00Z",
    complete: false,
    importedExecutions: 0 as const,
    warnings: [
      "Position currency is missing or differs from the journal. Reported positions were not included in analytics.",
    ],
    sections: {
      rules: { available: true, data: { currency: "USD", data: { name: "$50K High Stakes - 2" } } },
      positions: {
        available: true,
        data: {
          complete: true,
          rows: [
            {
              key: "saved",
              source: {
                symbol: "XAUUSD",
                side: "Buy",
                isClosed: true,
                openDate: "2026-10-13T02:32:20.337Z",
                closeDate: "2026-10-13T02:33:48.020Z",
                entry: 4169.26,
                exit: 4167.37,
                quantity: 0.25,
                profitAndLoss: -49.33,
                fee: -2.08,
                swap: 0,
              },
            },
          ],
        },
      },
    },
  };
  expect(snapshotCurrency(snapshot)).toBe("USD");
  expect(snapshotCurrency({ ...snapshot, account: { ...first, currency: "EUR" } })).toBeUndefined();
  await db
    .insert(settings)
    .values({ key: `${SNAPSHOT_PREFIX}${first.id}`, value: JSON.stringify(snapshot) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(snapshot) } });
  expect((await sourceOverview()).snapshots[0]!.canImportSnapshot).toBe(true);
  const before = vi.mocked(fetch).mock.calls.length;
  const response = await POST(request({ action: "snapshot.import", id: first.id }));
  expect(response.status).toBe(200);
  expect((await response.json()).snapshot.journaledPositions).toBe(1);
  expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  expect((await db.select().from(trades))[0]).toMatchObject({ symbol: "XAUUSD", netPnl: -49.33 });
  const { propAccounts } = await import("../src/db");
  expect((await db.select().from(propAccounts))[0]).toMatchObject({
    program: "verification",
    journalAccountId: `the5ers_${first.id}`,
  });
  expect((await sourceOverview()).snapshots[0]!.canImportSnapshot).toBe(false);
  expect((await POST(request({ action: "snapshot.import", id: first.id }))).status).toBe(200);
  expect(await db.select().from(trades)).toHaveLength(1);
  await db
    .update(settings)
    .set({ value: JSON.stringify({ ...snapshot, account: { ...first, currency: "EUR" } }) })
    .where(eq(settings.key, `${SNAPSHOT_PREFIX}${first.id}`));
  expect((await POST(request({ action: "snapshot.import", id: first.id }))).status).toBe(400);
  expect((await db.select().from(trades))[0]!.netPnl).toBe(-49.33);
});

it("imports a selected MT5 account with one authoritative currency and missing legacy journal link", async () => {
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false);
  const snapshot = await syncSourceAccount(first.id);
  const { SNAPSHOT_PREFIX } = await import("../src/server/the5ers/oauth");
  snapshot.normalizationVersion = 2;
  snapshot.account.currency = undefined;
  for (const name of ["performance", "rules", "positions"]) {
    if (snapshot.sections[name]) {
      const section = snapshot.sections[name]!.data as Record<string, unknown>;
      delete section.currency;
    }
  }
  await db
    .update(settings)
    .set({ value: JSON.stringify(snapshot) })
    .where(eq(settings.key, `${SNAPSHOT_PREFIX}${first.id}`));
  expect((await sourceOverview()).snapshots[0]!.canImportSnapshot).toBe(true);
  const response = await POST(request({ action: "snapshot.import", id: first.id }));
  expect(response.status).toBe(200);
  expect(await db.select().from(trades)).toHaveLength(1);
  expect((await sourceOverview()).snapshots[0]!.storedTrades).toBe(1);
  expect((await sourceOverview()).selection[0]!.journalAccountId).toBe(`the5ers_${first.id}`);
});

it("renews refs once when the provider rejects a still-locally-valid position reference", async () => {
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false);
  const snapshot = await syncSourceAccount(first.id);
  const key = (snapshot.sections.positions!.data as { rows: { key: string }[] }).rows[0]!.key;
  const original = fetch;
  let rejected = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (
          rpc.params?.name === "the5ers_positions" &&
          rpc.params.arguments.operation === "detail" &&
          !rejected
        ) {
          rejected = true;
          epoch++;
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { isError: true, content: [{ type: "text", text: "expired reference" }] },
          });
        }
      }
      return original(url, init);
    }),
  );
  calls = [];
  expect(JSON.stringify(await readSourceSection("position", first.id, key))).not.toContain(
    "opaque-position",
  );
  expect(
    calls.find((call) => call.tool === "the5ers_positions" && call.operation === "detail")?.args
      .position_ref,
  ).toBe("opaque-position-2-1");
  vi.mocked(fetch).mockClear();
  await expect(
    readSourceSection("position", first.id, "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12)),
  ).rejects.toThrow("no longer in the saved history");
  expect(fetch).not.toHaveBeenCalled();
});

it("retains the complete MT5 response and imports cotemporal positions instead of aborting the account", async () => {
  await connect();
  const first = (await listSourceAccounts())[0]!;
  await selectSourceAccounts([first.id], false, true);
  const original = fetch;
  const base = {
    symbol: "XAUUSD",
    side: "Buy",
    isClosed: true,
    openDate: "2026-10-13T02:32:20.337Z",
    closeDate: "2026-10-13T02:33:48.020Z",
    entry: 4169.26,
    exit: 4167.37,
    quantity: 0.25,
    profitAndLoss: -49.33,
    fee: -2.08,
    swap: 0,
  };
  let ambiguous = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (rpc.params?.name === "the5ers_positions" && rpc.params.arguments.operation === "list") {
          const positions = [
            base,
            { ...base, quantity: ambiguous ? 0.25 : 0.5, profitAndLoss: -98.66 },
            { ...base, symbol: "EURUSD", entry: 1.1, exit: 1.11, profitAndLoss: 10 },
          ];
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                contract_version: "1.0",
                operation: "positions.list",
                status: "COMPLETE",
                currency: "USD",
                account: { label: first.label, platform: "meta-trader-5" },
                pagination: { page: 1, limit: 100, total: positions.length, has_more: true },
                data: {
                  positions: positions.map((position, index) => ({
                    ...position,
                    ref: `position-${epoch}-${index}`,
                  })),
                },
              },
            },
          });
        }
      }
      return original(url, init);
    }),
  );
  const snapshot = await syncSourceAccount(first.id);
  expect(snapshot.sections.positions!.available).toBe(true);
  expect(snapshot.journaledPositions).toBe(3);
  expect(await db.select().from(trades)).toHaveLength(3);
  epoch++;
  await syncSourceAccount(first.id);
  expect(await db.select().from(trades)).toHaveLength(3);
  ambiguous = true;
  const partial = await syncSourceAccount(first.id);
  expect(partial.sections.positions!.available).toBe(true);
  expect((partial.sections.positions!.data as { rows: unknown[] }).rows).toHaveLength(3);
  expect(partial.skippedPositions).toBe(2);
  expect(partial.journaledPositions).toBe(1);
  expect(await db.select().from(trades)).toHaveLength(3);
});

it("syncs cash for every account including unselected closed accounts, keeps trades separate and reads saved cash without MCP", async () => {
  rows[1]!.accountType = "funded";
  rows[1]!.status = "closed";
  await connect();
  const listed = await listSourceAccounts();
  await selectSourceAccounts([listed[0]!.id], false, true);
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (rpc.params?.name === "the5ers_payout") {
          calls.push({ tool: "the5ers_payout", operation: "history", args: rpc.params.arguments });
          const funded = String(rpc.params.arguments.account_ref).endsWith("-2");
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                currency: "USD",
                data: {
                  payouts: funded
                    ? [
                        {
                          id: "closed-funded-receipt",
                          status: "paid",
                          currency: "USD",
                          netAmount: 780,
                          requestedAt: "2026-02-01T10:00:00Z",
                          paidAt: "2026-02-02T10:00:00Z",
                        },
                      ]
                    : [],
                },
                pagination: { has_more: false },
              },
            },
          });
        }
      }
      return original(url, init);
    }),
  );
  calls = [];
  expect(await syncSourceCash()).toMatchObject({ synced: 2, complete: true });
  expect(calls.filter((c) => c.tool === "the5ers_payout")).toHaveLength(3);
  expect(calls.some((c) => c.tool === "the5ers_positions")).toBe(false);
  const { propReceipts } = await import("../src/db");
  expect((await db.select().from(propReceipts)).map((r) => r.amountMinor)).toEqual([78000]);
  const { accounts: nativeAccounts, propAccounts: fundingAccounts } = await import("../src/db");
  expect(await db.select().from(nativeAccounts)).toHaveLength(1);
  expect(
    (await db.select().from(fundingAccounts)).find((a) => a.program === "funded")!.journalAccountId,
  ).toBeNull();
  const before = vi.mocked(fetch).mock.calls.length;
  const overview = await sourceOverview();
  expect(overview.selection.map((a) => a.id)).toEqual([listed[0]!.id]);
  expect(overview.cashSnapshots).toHaveLength(2);
  expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  await syncSourceCash();
  expect(await db.select().from(propReceipts)).toHaveLength(1);
  const history = overview.cashSnapshots.find((s) => s.account.id === listed[1]!.id)!.sections
    .payoutHistory!.data as { rows: { key: string }[] };
  const response = await POST(
    request({
      action: "payout.confirm",
      id: listed[1]!.id,
      payoutKey: history.rows[0]!.key,
      propAccountId: `the5ers_${listed[1]!.id}`,
      amount: "780",
      receivedOn: "2026-02-02",
    }),
  );
  expect(response.status).toBe(200);
});

it("imports the documented latest paid withdrawal using envelope currency and explain finalAmount for a disabled funded account", async () => {
  rows[1]!.accountType = "funded";
  rows[1]!.status = "disabled";
  await connect();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (rpc.params?.name === "the5ers_payout") {
          const funded = String(rpc.params.arguments.account_ref).endsWith("-2");
          const latest = {
            requestedAt: "2026-02-01T10:00:00Z",
            completedAt: "2026-02-02T10:00:00Z",
            amount: 1000,
            status: "Paid",
            method: "bank transfer",
          };
          const data =
            rpc.params.arguments.operation === "explain"
              ? {
                  subject: "latest_payout",
                  latestPayout: {
                    ...latest,
                    breakdown: { finalAmount: 780, commission: 20, userShare: 800 },
                  },
                }
              : {
                  coverage: { complete: false },
                  payouts: funded
                    ? [latest, { ...latest, requestedAt: "2026-01-20T10:00:00Z" }]
                    : [],
                };
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: { currency: "USD", data, pagination: { has_more: false } },
            },
          });
        }
      }
      return original(url, init);
    }),
  );
  await syncSourceCash();
  const { propReceipts } = await import("../src/db");
  expect((await db.select().from(propReceipts)).map((r) => r.amountMinor)).toEqual([78000]);
  await syncSourceCash();
  expect(await db.select().from(propReceipts)).toHaveLength(1);
  const overview = await sourceOverview();
  const history = overview.cashSnapshots.find((s) => s.account.program === "funded")!.sections
    .payoutHistory!.data as { pending: number };
  expect(history.pending).toBe(1);
});

it("resumes bounded financial batches without refetching saved histories and prioritizes historical funded accounts", async () => {
  rows = Array.from({ length: 25 }, (_, index) => ({
    ...account(`account-${index}`, 1),
    accountType: index === 24 ? "funded" : "evaluation",
  }));
  await connect();
  calls = [];
  const first = await syncSourceCash(undefined, true);
  expect(first).toMatchObject({ checked: 12, total: 25, remaining: 13, complete: false });
  expect(String(calls.find((c) => c.tool === "the5ers_payout")!.args.account_ref)).toMatch(/-25$/);
  expect(calls.some((c) => c.tool === "the5ers_purchase")).toBe(false);
  expect(await syncSourceCash(undefined, true)).toMatchObject({
    checked: 24,
    remaining: 1,
    complete: false,
  });
  expect(await syncSourceCash(undefined, true)).toMatchObject({
    checked: 25,
    remaining: 0,
    complete: true,
  });
  const histories = calls.filter((c) => c.tool === "the5ers_payout" && c.operation === "history");
  expect(histories).toHaveLength(25);
  expect(new Set(histories.map((c) => c.args.account_ref)).size).toBe(25);
});

it("hides legacy cash-created trading shells while preserving selected accounts and user capital or names", async () => {
  await connect();
  const listed = await listSourceAccounts();
  await selectSourceAccounts([listed[0]!.id], false, true);
  const { accounts } = await import("../src/db");
  await db.insert(accounts).values([
    {
      id: "the5ers_legacy",
      name: "The5ers · c-trader · …1218",
      broker: "The5ers",
      kind: "import",
      currency: "USD",
      initialBalance: 0,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "the5ers_capital",
      name: "The5ers · meta-trader-5 · …8490",
      broker: "The5ers",
      kind: "import",
      currency: "USD",
      initialBalance: 50000,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "the5ers_custom",
      name: "The5ers-12345678",
      broker: "The5ers",
      kind: "import",
      currency: "USD",
      initialBalance: 0,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  const { GET: getAccounts } = await import("../src/app/api/accounts/route");
  for (const suffix of ["", "?summary=1"]) {
    const response = await getAccounts(new Request(`https://journal.test/api/accounts${suffix}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accounts.map((a: { id: string }) => a.id)).not.toContain("the5ers_legacy");
    expect(body.accounts.map((a: { id: string }) => a.id)).toContain("the5ers_capital");
    expect(body.accounts.find((a: { id: string }) => a.id === "the5ers_custom").name).toBe(
      "The5ers-12345678",
    );
    expect(body.accounts.find((a: { id: string }) => a.id === "the5ers_capital").name).toBe(
      "The5ers-…8490",
    );
  }
  expect(await db.select().from(accounts)).toHaveLength(4);
});

it("keeps cash syncing when purchases fail and preserves each failed account's saved payout history", async () => {
  await connect();
  const listed = await listSourceAccounts();
  await syncSourceCash();
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (
          rpc.params?.name === "the5ers_purchase" ||
          (rpc.params?.name === "the5ers_payout" &&
            String(rpc.params.arguments.account_ref).endsWith("-1"))
        ) {
          return json({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [] } });
        }
      }
      return original(url, init);
    }),
  );
  expect(await syncSourceCash()).toMatchObject({
    complete: false,
    synced: 1,
    failures: [{ id: listed[0]!.id }],
    purchases: { synced: false },
  });
  expect((await sourceOverview()).cashSnapshots).toHaveLength(2);
});

it("reads the actual payout and withdrawal tool schemas through the authenticated connection without calling any payout operation", async () => {
  await connect();
  const original = fetch;
  const read = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === MCP_URL && init?.body) {
        const rpc = JSON.parse(String(init.body));
        if (rpc.method === "tools/list") {
          read(rpc.params);
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: rpc.params.cursor
              ? {
                  tools: [
                    {
                      name: "the5ers_wallet",
                      inputSchema: { properties: { operation: { enum: ["overview"] } } },
                    },
                  ],
                }
              : {
                  tools: [
                    {
                      name: "the5ers_payout",
                      inputSchema: {
                        properties: {
                          account_ref: { type: "string" },
                          operation: { enum: ["history"] },
                        },
                        required: ["operation"],
                      },
                    },
                    { name: "the5ers_positions", inputSchema: {} },
                    { name: "hub_withdrawals", inputSchema: { required: ["operation"] } },
                  ],
                  nextCursor: "next-page",
                },
          });
        }
      }
      return original(url, init);
    }),
  );
  calls = [];
  const response = await GET(
    new Request("https://journal.example/api/the5ers?view=payout-contract"),
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
    "the5ers_payout",
    "hub_withdrawals",
    "the5ers_wallet",
  ]);
  expect(result.tools[0].inputSchema.properties.account_ref).toEqual({ type: "string" });
  expect(read.mock.calls).toEqual([[{}], [{ cursor: "next-page" }]]);
  expect(calls).toEqual([]);
  session.token = undefined;
  expect(
    (await GET(new Request("https://journal.example/api/the5ers?view=payout-contract"))).status,
  ).toBe(401);
});
