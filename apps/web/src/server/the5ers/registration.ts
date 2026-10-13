import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, settings } from "@/db";
import { RequestError, requireValue } from "@/server/api";
import { encryptJson, decryptJson } from "@/server/crypto";
import { MCP_URL, READ_SCOPES, officialAuthUrl, record } from "./contracts";
import { boundedJson, providerResponse } from "./http";

export const CLIENT_METADATA_PATH = "/api/the5ers/client-metadata";
export interface OAuthClient {
  id: string;
  mode: "static" | "cimd" | "dcr";
  method: "none" | "client_secret_post" | "client_secret_basic";
  secret?: string;
}
export interface Discovery {
  authorization: string;
  token: string;
  issuer?: string;
  registration?: string;
  cimd: boolean;
  scopes: string[];
  methods?: string[];
  responseIssuerRequired?: boolean;
}
export function callbackUri(origin?: string): URL {
  const configured = process.env.THE5ERS_REDIRECT_URI?.trim();
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  let url: URL;
  try {
    url = new URL(
      configured || `${production ? `https://${production}` : origin}/api/the5ers/callback`,
    );
  } catch {
    throw new RequestError(
      "The5ers callback could not be determined. Configure THE5ERS_REDIRECT_URI.",
    );
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
  if (origin)
    requireValue(url.origin === origin, "The5ers callback must match this journal's origin.");
  return url;
}
export function clientMetadata(origin: string) {
  const callback = callbackUri(origin);
  return {
    client_id: new URL(CLIENT_METADATA_PATH, callback.origin).href,
    client_name: "Trade Journal",
    client_uri: callback.origin,
    redirect_uris: [callback.href],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
export async function discover(): Promise<Discovery> {
  const authorization = process.env.THE5ERS_AUTHORIZATION_URL?.trim();
  const token = process.env.THE5ERS_TOKEN_URL?.trim();
  if (authorization || token) {
    requireValue(authorization && token, "Configure both The5ers OAuth endpoints.");
    requireValue(
      process.env.THE5ERS_OAUTH_CLIENT_ID?.trim(),
      "Explicit OAuth endpoints require a provider-approved client ID; automatic registration requires discovery.",
    );
    return {
      authorization: officialAuthUrl(authorization),
      token: officialAuthUrl(token),
      cimd: false,
      scopes: READ_SCOPES,
    };
  }
  const resourceResponse = await providerResponse(
    "https://mcp.the5ers.com/.well-known/oauth-protected-resource",
  );
  if (!resourceResponse.ok) {
    await resourceResponse.body?.cancel();
    throw new RequestError(
      `The5ers resource discovery failed (HTTP ${resourceResponse.status}). Try again later.`,
    );
  }
  const resource = record(await boundedJson(resourceResponse));
  requireValue(
    resource.resource === MCP_URL &&
      Array.isArray(resource.authorization_servers) &&
      resource.authorization_servers.length === 1,
    "The5ers returned unsupported OAuth discovery data.",
  );
  const issuer = new URL(officialAuthUrl(resource.authorization_servers[0]));
  requireValue(!issuer.search, "Invalid The5ers authorization issuer.");
  const path = issuer.pathname.replace(/\/$/, "");
  const candidates = [
    ...new Set([
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.origin}/.well-known/openid-configuration${path}`,
      ...(path ? [`${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`] : []),
    ]),
  ];
  for (const url of candidates) {
    const response = await providerResponse(url);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) continue;
      throw new RequestError(
        `The5ers OAuth discovery was rejected (HTTP ${response.status}) by auth.hub.the5ers.com. No client was registered. Retry later or ask The5ers to allow this journal's OAuth connection.`,
      );
    }
    const metadata = record(await boundedJson(response));
    requireValue(
      metadata.issuer === issuer.href,
      "The5ers OAuth issuer did not match its resource metadata.",
    );
    requireValue(
      Array.isArray(metadata.code_challenge_methods_supported) &&
        metadata.code_challenge_methods_supported.includes("S256"),
      "The5ers OAuth server must support PKCE S256.",
    );
    requireValue(
      metadata.response_types_supported === undefined ||
        (Array.isArray(metadata.response_types_supported) &&
          metadata.response_types_supported.includes("code")),
      "The5ers does not support authorization-code login.",
    );
    const supported = metadata.scopes_supported ?? resource.scopes_supported;
    requireValue(
      supported === undefined ||
        (Array.isArray(supported) && supported.every((s) => typeof s === "string")),
      "The5ers returned invalid scope metadata.",
    );
    const scopes = supported ? READ_SCOPES.filter((s) => supported.includes(s)) : READ_SCOPES;
    requireValue(
      scopes.includes("mcp:accounts.read"),
      "The5ers did not advertise account-read access.",
    );
    const methods = metadata.token_endpoint_auth_methods_supported;
    requireValue(
      methods === undefined ||
        (Array.isArray(methods) && methods.every((s) => typeof s === "string")),
      "The5ers returned invalid client authentication metadata.",
    );
    return {
      authorization: officialAuthUrl(metadata.authorization_endpoint),
      token: officialAuthUrl(metadata.token_endpoint),
      issuer: issuer.href,
      cimd: metadata.client_id_metadata_document_supported === true,
      registration:
        metadata.registration_endpoint === undefined
          ? undefined
          : officialAuthUrl(metadata.registration_endpoint),
      responseIssuerRequired: metadata.authorization_response_iss_parameter_supported === true,
      scopes,
      methods: methods as string[] | undefined,
    };
  }
  throw new RequestError(
    "The5ers OAuth discovery endpoints were not found. A provider-approved client and endpoints are required.",
  );
}
export function staticClient(discovery?: Discovery): OAuthClient | undefined {
  const id = process.env.THE5ERS_OAUTH_CLIENT_ID?.trim();
  if (!id) return undefined;
  const secret = process.env.THE5ERS_OAUTH_CLIENT_SECRET?.trim();
  const method = secret
    ? discovery?.methods && !discovery.methods.includes("client_secret_post")
      ? "client_secret_basic"
      : "client_secret_post"
    : "none";
  requireValue(
    !discovery?.methods || discovery.methods.includes(method),
    "The5ers does not support this client's token authentication method.",
  );
  return { id, secret, method, mode: "static" };
}
export function registrationMethod(discovery: Discovery, redirect: URL): OAuthClient["mode"] {
  if (process.env.THE5ERS_OAUTH_CLIENT_ID?.trim()) return "static";
  if (discovery.cimd && redirect.protocol === "https:") return "cimd";
  if (discovery.registration) return "dcr";
  throw new RequestError(
    "The5ers has not enabled automatic client registration for this journal. A provider-approved client is required.",
  );
}
export async function resolveClient(discovery: Discovery, redirect: URL): Promise<OAuthClient> {
  const configured = staticClient(discovery);
  if (configured) return configured;
  const mode = registrationMethod(discovery, redirect);
  requireValue(
    !discovery.methods || discovery.methods.includes("none"),
    "The5ers does not allow public OAuth clients for this connection.",
  );
  if (mode === "cimd")
    return { id: clientMetadata(redirect.origin).client_id, mode, method: "none" };
  requireValue(discovery.registration, "The5ers registration endpoint is missing.");
  const key = `the5ers:oauth:client:${createHash("sha256")
    .update(
      JSON.stringify([discovery.issuer, discovery.registration, redirect.href, discovery.scopes]),
    )
    .digest("hex")}`;
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key, value: encryptJson(null) })
      .onConflictDoNothing();
    const [row] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
    const cached = decryptJson<OAuthClient | null>(row!.value);
    if (cached) return cached;
    const { client_id: _id, ...metadata } = clientMetadata(redirect.origin);
    const response = await providerResponse(discovery.registration!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...metadata, scope: discovery.scopes.join(" ") }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(
        `The5ers client registration failed (HTTP ${response.status}). The callback ${redirect.href} may need approval from The5ers. No connection was saved.`,
      );
    }
    const registered = record(await boundedJson(response));
    requireValue(
      typeof registered.client_id === "string" &&
        registered.client_id.length > 0 &&
        registered.client_id.length <= 4096 &&
        !/[\x00-\x20\x7f]/.test(registered.client_id),
      "The5ers returned an invalid registered client ID.",
    );
    requireValue(
      registered.token_endpoint_auth_method === "none" && registered.client_secret === undefined,
      "The5ers returned an unsupported registered client authentication method.",
    );
    requireValue(
      Array.isArray(registered.redirect_uris) &&
        registered.redirect_uris.length === 1 &&
        registered.redirect_uris[0] === redirect.href,
      "The5ers registered a different callback. Connection stopped.",
    );
    const client: OAuthClient = { id: registered.client_id, mode: "dcr", method: "none" };
    await tx
      .update(settings)
      .set({ value: encryptJson(client) })
      .where(eq(settings.key, key));
    return client;
  });
}
export async function checkOAuth(origin: string) {
  requireValue(
    process.env.JOURNAL_SECRET?.trim(),
    "JOURNAL_SECRET is required to securely connect The5ers.",
  );
  const redirect = callbackUri(origin),
    discovery = await discover();
  const method = registrationMethod(discovery, redirect);
  return {
    method,
    callback: redirect.href,
    message: `The5ers OAuth discovery succeeded. ${method.toUpperCase()} registration is advertised; Connect will start authorization. Callback approval and actual login remain to be tested.`,
  };
}
