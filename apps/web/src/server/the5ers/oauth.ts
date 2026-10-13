import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, settings } from "@/db";
import { RequestError, requireValue } from "@/server/api";
import { encryptJson, decryptJson } from "@/server/crypto";
import { getSetting, setSetting, deleteSetting } from "@/server/settings";
import { MCP_URL, officialAuthUrl, READ_SCOPES, record } from "./contracts";
import { providerResponse, boundedJson } from "./http";

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
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pendingKey = (session: string) => `the5ers:oauth:pending:${digest(session)}`;
function callbackUri(): URL {
  let url: URL;
  try {
    url = new URL(process.env.THE5ERS_REDIRECT_URI ?? "");
  } catch {
    throw new RequestError("The5ers connection is not configured on this server.");
  }
  requireValue(
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) &&
      url.pathname === "/api/the5ers/callback" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Invalid The5ers callback configuration.",
  );
  return url;
}
export function oauthConfigured(): boolean {
  return Boolean(
    process.env.THE5ERS_OAUTH_CLIENT_ID?.trim() &&
    process.env.THE5ERS_REDIRECT_URI?.trim() &&
    process.env.JOURNAL_SECRET?.trim(),
  );
}
async function endpoints() {
  const authorization = process.env.THE5ERS_AUTHORIZATION_URL?.trim(),
    token = process.env.THE5ERS_TOKEN_URL?.trim();
  if (authorization || token) {
    requireValue(authorization && token, "Configure both The5ers OAuth endpoints.");
    return { authorization: officialAuthUrl(authorization), token: officialAuthUrl(token) };
  }
  const resourceResponse = await providerResponse(
    "https://mcp.the5ers.com/.well-known/oauth-protected-resource",
  );
  requireValue(
    resourceResponse.ok,
    "The5ers OAuth discovery is unavailable. Configure provider-approved OAuth endpoints.",
  );
  const resource = record(await boundedJson(resourceResponse));
  requireValue(
    resource.resource === "https://mcp.the5ers.com/mcp" &&
      Array.isArray(resource.authorization_servers) &&
      resource.authorization_servers.length === 1,
    "The5ers returned unsupported OAuth discovery data.",
  );
  const issuer = new URL(officialAuthUrl(resource.authorization_servers[0]));
  const metadataUrl = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`;
  const metadataResponse = await providerResponse(metadataUrl);
  requireValue(
    metadataResponse.ok,
    "The5ers OAuth discovery is unavailable. Configure provider-approved OAuth endpoints.",
  );
  const metadata = record(await boundedJson(metadataResponse));
  requireValue(
    metadata.issuer === issuer.href &&
      Array.isArray(metadata.code_challenge_methods_supported) &&
      metadata.code_challenge_methods_supported.includes("S256"),
    "The5ers OAuth server must support PKCE S256.",
  );
  return {
    authorization: officialAuthUrl(metadata.authorization_endpoint),
    token: officialAuthUrl(metadata.token_endpoint),
  };
}
export async function startAuthorization(session: string, origin: string): Promise<string> {
  requireValue(oauthConfigured(), "The5ers connection is not configured on this server.");
  const redirect = callbackUri();
  requireValue(redirect.origin === origin, "The5ers callback must match this journal's origin.");
  const urls = await endpoints();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  const clientId = process.env.THE5ERS_OAUTH_CLIENT_ID!.trim();
  const pending: Pending = {
    state,
    verifier,
    expiresAt: Date.now() + 10 * 60_000,
    sessionHash: digest(session),
    redirectUri: redirect.href,
    tokenUrl: urls.token,
    clientId,
    scopes: READ_SCOPES,
  };
  await setSetting(pendingKey(session), encryptJson(pending));
  const url = new URL(urls.authorization);
  for (const [key, value] of Object.entries({
    response_type: "code",
    resource: MCP_URL,
    client_id: clientId,
    redirect_uri: redirect.href,
    scope: READ_SCOPES.join(" "),
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
): Promise<Connection> {
  const configuredClient = process.env.THE5ERS_OAUTH_CLIENT_ID?.trim();
  requireValue(
    configuredClient === clientId,
    "The5ers connection configuration changed. Reconnect your account.",
  );
  const body = new URLSearchParams({ ...params, client_id: clientId, resource: MCP_URL });
  const secret = process.env.THE5ERS_OAUTH_CLIENT_SECRET?.trim();
  if (secret) body.set("client_secret", secret);
  const response = await providerResponse(officialAuthUrl(tokenUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
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
  };
}
export async function finishAuthorization(url: URL, session: string): Promise<void> {
  const redirect = callbackUri();
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
