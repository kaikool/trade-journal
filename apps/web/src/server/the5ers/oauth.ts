import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, settings } from "@/db";
import { RequestError, requireValue } from "@/server/api";
import { encryptJson, decryptJson } from "@/server/crypto";
import { getSetting, setSetting, deleteSetting } from "@/server/settings";
import { MCP_URL, officialAuthUrl, READ_SCOPES, record } from "./contracts";
import { providerResponse, boundedJson } from "./http";
import {
  callbackUri,
  discover,
  resolveClient,
  staticClient,
  type OAuthClient,
} from "./registration";

export const CONNECTION_KEY = "the5ers:oauth:connectionEnc";
export const SELECTION_KEY = "the5ers:selection";
export const SNAPSHOT_PREFIX = "the5ers:snapshot:";
export interface Connection {
  id: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  tokenUrl: string;
  clientId: string;
  connectedAt: string;
  client?: OAuthClient;
}
interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
  sessionHash: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  client: OAuthClient;
  issuer?: string;
  responseIssuerRequired?: boolean;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pendingKey = (session: string) => `the5ers:oauth:pending:${digest(session)}`;
export function oauthConfigured(): boolean {
  return Boolean(process.env.JOURNAL_SECRET?.trim());
}
export async function startAuthorization(session: string, origin: string): Promise<string> {
  requireValue(oauthConfigured(), "JOURNAL_SECRET is required to securely connect The5ers.");
  const redirect = callbackUri(origin);
  requireValue(redirect.origin === origin, "The5ers callback must match this journal's origin.");
  const urls = await discover();
  const client = await resolveClient(urls, redirect);
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  const clientId = client.id;
  const pending: Pending = {
    state,
    verifier,
    expiresAt: Date.now() + 10 * 60_000,
    sessionHash: digest(session),
    redirectUri: redirect.href,
    tokenUrl: urls.token,
    clientId,
    scopes: urls.scopes,
    client,
    issuer: urls.issuer,
    responseIssuerRequired: urls.responseIssuerRequired,
  };
  await setSetting(pendingKey(session), encryptJson(pending));
  const url = new URL(urls.authorization);
  for (const [key, value] of Object.entries({
    response_type: "code",
    resource: MCP_URL,
    client_id: clientId,
    redirect_uri: redirect.href,
    scope: urls.scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  return url.href;
}
async function exchange(
  tokenUrl: string,
  clientId: string,
  params: Record<string, string>,
  old?: Connection,
  scopes = READ_SCOPES,
  savedClient?: OAuthClient,
): Promise<Connection> {
  const client = savedClient ?? staticClient();
  requireValue(
    client && client.id === clientId,
    "The5ers client configuration changed. Reconnect your account.",
  );
  if (client.mode === "static") {
    const current = staticClient();
    requireValue(
      current?.id === client.id && current?.secret === client.secret,
      "The5ers connection configuration changed. Reconnect your account.",
    );
  }
  const body = new URLSearchParams({ ...params, client_id: clientId, resource: MCP_URL });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.method === "client_secret_post") body.set("client_secret", client.secret!);
  if (client.method === "client_secret_basic")
    headers.Authorization = `Basic ${Buffer.from(`${new URLSearchParams({ value: client.id }).toString().slice(6)}:${new URLSearchParams({ value: client.secret! }).toString().slice(6)}`).toString("base64")}`;
  const response = await providerResponse(officialAuthUrl(tokenUrl), {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new RequestError("The5ers authorization could not be renewed. Reconnect your account.");
  }
  const token = record(await boundedJson(response));
  requireValue(
    token.token_type === "Bearer" || token.token_type === "bearer",
    "The5ers returned an unsupported token type.",
  );
  requireValue(
    typeof token.access_token === "string" &&
      token.access_token.length > 0 &&
      token.access_token.length <= 16_000 &&
      !/\s/.test(token.access_token),
    "The5ers returned an invalid access token.",
  );
  requireValue(
    typeof token.expires_in === "number" &&
      Number.isSafeInteger(token.expires_in) &&
      token.expires_in > 0 &&
      token.expires_in <= 30 * 86400,
    "The5ers token lifetime is unavailable or invalid.",
  );
  requireValue(
    token.refresh_token === undefined ||
      (typeof token.refresh_token === "string" &&
        token.refresh_token.length > 0 &&
        token.refresh_token.length <= 16_000 &&
        !/\s/.test(token.refresh_token)),
    "The5ers returned an invalid refresh token.",
  );
  requireValue(
    token.scope === undefined || typeof token.scope === "string",
    "The5ers returned unsupported permissions.",
  );
  const granted =
    typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : scopes;
  requireValue(
    granted.includes("mcp:accounts.read") && granted.every((scope) => READ_SCOPES.includes(scope)),
    "The5ers did not grant supported read-only permissions.",
  );
  return {
    id: old?.id ?? randomUUID(),
    accessToken: token.access_token,
    refreshToken: (token.refresh_token as string | undefined) ?? old?.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: granted,
    tokenUrl: officialAuthUrl(tokenUrl),
    clientId,
    connectedAt: old?.connectedAt ?? new Date().toISOString(),
    client,
  };
}
export async function finishAuthorization(url: URL, session: string): Promise<void> {
  const redirect = callbackUri(url.origin);
  requireValue(
    url.origin === redirect.origin && url.pathname === redirect.pathname,
    "Invalid The5ers callback origin.",
  );
  const state = url.searchParams.get("state");
  requireValue(
    state && /^[A-Za-z0-9_-]{43}$/.test(state),
    "Invalid or expired The5ers connection request.",
  );
  const pending = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, pendingKey(session)))
      .for("update");
    requireValue(row, "The5ers connection request expired or was already used.");
    const value = decryptJson<Pending>(row.value);
    requireValue(
      value.state === state &&
        value.expiresAt > Date.now() &&
        value.sessionHash === digest(session) &&
        value.redirectUri === redirect.href,
      "The5ers connection request expired or belongs to a different session.",
    );
    await deleteSetting(pendingKey(session), tx);
    return value;
  });
  requireValue(!url.searchParams.has("error"), "The5ers authorization was not granted.");
  const code = url.searchParams.get("code");
  requireValue(
    code && code.length <= 4096 && !/[\x00-\x20]/.test(code),
    "The5ers did not return a valid authorization code.",
  );
  requireValue(
    (!pending.responseIssuerRequired || url.searchParams.has("iss")) &&
      (!pending.issuer ||
        !url.searchParams.has("iss") ||
        url.searchParams.get("iss") === pending.issuer),
    "The5ers authorization response issuer did not match.",
  );
  const connection = await exchange(
    pending.tokenUrl,
    pending.clientId,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    },
    undefined,
    pending.scopes,
    pending.client,
  );
  await db.transaction(async (tx) => {
    await setSetting(CONNECTION_KEY, encryptJson(connection), tx);
    await deleteSetting(SELECTION_KEY, tx);
    await tx.delete(settings).where(like(settings.key, `${SNAPSHOT_PREFIX}%`));
    await tx.delete(settings).where(like(settings.key, "the5ers:refs:%"));
  });
}
export async function connectionSummary() {
  const saved = await getSetting(CONNECTION_KEY);
  if (!saved) return { configured: oauthConfigured(), connected: false, canRefresh: false };
  try {
    const value = decryptJson<Connection>(saved);
    return {
      configured: oauthConfigured(),
      connected: true,
      canRefresh: Boolean(value.refreshToken),
      expiresAt: new Date(value.expiresAt).toISOString(),
      connectedAt: value.connectedAt,
      scopes: value.scopes,
    };
  } catch {
    return {
      configured: oauthConfigured(),
      connected: false,
      canRefresh: false,
      error: "Saved The5ers connection could not be unlocked. Reconnect your account.",
    };
  }
}
export async function accessConnection(): Promise<Connection> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, CONNECTION_KEY))
      .for("update");
    requireValue(row, "Connect The5ers first.");
    let value: Connection;
    try {
      value = decryptJson<Connection>(row.value);
    } catch {
      throw new RequestError(
        "Saved The5ers connection could not be unlocked. Reconnect your account.",
      );
    }
    if (value.expiresAt > Date.now() + 60_000) return value;
    requireValue(value.refreshToken, "The5ers authorization expired. Reconnect your account.");
    const renewed = await exchange(
      value.tokenUrl,
      value.clientId,
      { grant_type: "refresh_token", refresh_token: value.refreshToken },
      value,
      value.scopes,
      value.client,
    );
    await setSetting(CONNECTION_KEY, encryptJson(renewed), tx);
    return renewed;
  });
}
export async function assertConnection(id: string, executor: Parameters<typeof getSetting>[1]) {
  const [row] = await (executor ?? db)
    .select()
    .from(settings)
    .where(eq(settings.key, CONNECTION_KEY))
    .for("update");
  const saved = row?.value;
  requireValue(
    saved && decryptJson<Connection>(saved).id === id,
    "The5ers connection changed during sync. Try again.",
  );
}
export async function disconnectThe5ers() {
  await db.transaction(async (tx) => {
    await deleteSetting(CONNECTION_KEY, tx);
    await deleteSetting(SELECTION_KEY, tx);
    await tx.delete(settings).where(like(settings.key, "the5ers:oauth:pending:%"));
    await tx.delete(settings).where(like(settings.key, `${SNAPSHOT_PREFIX}%`));
    await tx.delete(settings).where(like(settings.key, "the5ers:refs:%"));
  });
}
