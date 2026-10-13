import { createHash, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, settings } from "@/db";
import { parseTimestamp } from "@luxalgo/journal-importers";
import { RequestError, requireValue } from "@/server/api";
import { getSetting, setSetting } from "@/server/settings";
import { encryptJson, decryptJson } from "@/server/crypto";
import { publicData, record, type ReadTool } from "./contracts";
import { The5ersMcp } from "./mcp";
import {
  accessConnection,
  assertConnection,
  connectionSummary,
  SELECTION_KEY,
  SNAPSHOT_PREFIX,
} from "./oauth";

const REF_PREFIX = "the5ers:refs:";
export interface SourceAccount {
  id: string;
  label: string;
  platform: string;
  createdAt: string;
  source: unknown;
}
interface ProviderAccount extends SourceAccount {
  ref: string;
}
export interface Selection {
  id: string;
  label: string;
  autoSync: boolean;
}
export interface SourceSnapshot {
  account: SourceAccount;
  retrievedAt: string;
  complete: boolean;
  sections: Record<string, { available: boolean; data?: unknown; error?: string }>;
  warnings: string[];
  importedExecutions: 0;
}
interface PositionRefs {
  connectionId: string;
  accountId: string;
  expiresAt: number;
  refs: Record<string, string>;
}
const reference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16_000 &&
  !/[\x00-\x20]/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  parseTimestamp(value) !== null;
function pageData(value: unknown, collection: "accounts" | "positions") {
  const envelope = record(value),
    body = envelope.data && !Array.isArray(envelope.data) ? record(envelope.data) : envelope;
  const rows = body[collection] ?? (Array.isArray(envelope.data) ? envelope.data : undefined);
  requireValue(
    Array.isArray(rows),
    `The5ers ${collection} response is not yet supported. No journal trades were changed.`,
  );
  requireValue(
    rows.length <= (collection === "accounts" ? 50 : 100),
    "The5ers exceeded the requested page size.",
  );
  const pagination = record(envelope.pagination ?? body.pagination);
  requireValue(
    typeof pagination.has_more === "boolean",
    "The5ers did not report pagination coverage.",
  );
  return { rows, hasMore: pagination.has_more };
}
export function parseProviderAccounts(value: unknown): {
  accounts: ProviderAccount[];
  hasMore: boolean;
} {
  const page = pageData(value, "accounts");
  const accounts: ProviderAccount[] = page.rows
    .filter((item) => !record(item).contest_account_ref)
    .map((item) => {
      const row = record(item);
      requireValue(
        reference(row.ref) &&
          typeof row.label === "string" &&
          row.label.trim().length > 0 &&
          row.label.length <= 200,
        "The5ers account references or labels are unavailable.",
      );
      const createdAt = row.createdAt ?? row.creationDate ?? row.created_at;
      const platform = row.tradingPlatform ?? row.platform ?? row.tradingSystem;
      requireValue(
        date(createdAt) &&
          typeof platform === "string" &&
          platform.length > 0 &&
          platform.length <= 100,
        "The5ers account identity cannot be matched safely. An authenticated response contract is needed before sync.",
      );
      const stamp = new Date(createdAt).toISOString();
      const id = createHash("sha256")
        .update(JSON.stringify([row.label, platform, stamp]))
        .digest("hex");
      return {
        id,
        ref: row.ref,
        label: row.label,
        platform,
        createdAt: stamp,
        source: publicData(row),
      };
    });
  return { accounts, hasMore: page.hasMore };
}
async function inventory(client: The5ersMcp): Promise<ProviderAccount[]> {
  const all: ProviderAccount[] = [],
    seenRefs = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const parsed = parseProviderAccounts(await client.read("account", "list", { page, limit: 50 }));
    for (const account of parsed.accounts) {
      requireValue(
        !seenRefs.has(account.ref),
        "The5ers repeated an account page. Sync stopped without merging accounts.",
      );
      seenRefs.add(account.ref);
      all.push(account);
    }
    if (!parsed.hasMore) {
      const identities = all.map((account) => account.id);
      requireValue(
        new Set(identities).size === identities.length,
        "The5ers account labels and creation dates are ambiguous. Sync stopped without merging accounts.",
      );
      return all;
    }
    requireValue(
      parsed.accounts.length > 0,
      "The5ers returned an empty account page with more pages indicated.",
    );
  }
  throw new RequestError(
    "The5ers account list exceeded its pagination limit. Nothing was selected.",
  );
}
async function sourceClient(signal?: AbortSignal) {
  const connection = await accessConnection();
  return {
    connection,
    client: new The5ersMcp(
      connection.accessToken,
      AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
    ),
  };
}
export async function listSourceAccounts(): Promise<SourceAccount[]> {
  const { client } = await sourceClient();
  return (await inventory(client)).map(({ ref: _ref, ...account }) => account);
}
export async function selectedAccounts(): Promise<Selection[]> {
  const value = await getSetting(SELECTION_KEY);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  requireValue(
    Array.isArray(parsed) &&
      parsed.length <= 10 &&
      parsed.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          /^[a-f0-9]{64}$/.test(item.id) &&
          typeof item.label === "string" &&
          typeof item.autoSync === "boolean",
      ),
    "Saved The5ers selection is invalid. Select accounts again.",
  );
  return parsed as Selection[];
}
export async function selectSourceAccounts(ids: unknown, autoSync: unknown) {
  requireValue(
    Array.isArray(ids) &&
      ids.length <= 10 &&
      ids.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
      new Set(ids).size === ids.length &&
      typeof autoSync === "boolean",
    "Select up to 10 accounts and choose automatic sync.",
  );
  const { connection, client } = await sourceClient();
  const available = await inventory(client);
  const selected = ids.map((id) => {
    const account = available.find((a) => a.id === id);
    requireValue(account, "An account is no longer available. Refresh the account list.");
    return { id: account.id, label: account.label, autoSync };
  });
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    await setSetting(SELECTION_KEY, JSON.stringify(selected), tx);
  });
  return selected;
}
async function positions(client: The5ersMcp, account: ProviderAccount) {
  const rows: { key: string; hasDetails: boolean; source: unknown }[] = [],
    refs: Record<string, string> = {},
    seen = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const result = pageData(
      await client.read("positions", "list", {
        account_ref: account.ref,
        view: "all",
        page,
        limit: 100,
      }),
      "positions",
    );
    for (const item of result.rows) {
      const row = record(item),
        key = randomUUID(),
        ref = row.position_ref;
      if (reference(ref)) {
        requireValue(!seen.has(ref), "The5ers repeated a position page.");
        seen.add(ref);
        refs[key] = ref;
      }
      rows.push({ key, hasDetails: Boolean(refs[key]), source: publicData(row) });
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new RequestError("The5ers position history exceeded the snapshot size limit.");
    if (!result.hasMore) return { rows, refs, complete: true };
    requireValue(
      result.rows.length > 0,
      "The5ers returned an empty position page with more pages indicated.",
    );
  }
  return { rows, refs, complete: false };
}
export async function syncSourceAccount(id: string, signal?: AbortSignal): Promise<SourceSnapshot> {
  requireValue(
    (await selectedAccounts()).some((account) => account.id === id),
    "Select this The5ers account before syncing it.",
  );
  const { connection, client } = await sourceClient(signal);
  const account = (await inventory(client)).find((a) => a.id === id);
  requireValue(
    account,
    "The selected The5ers account identity changed or is unavailable. Refresh and select it again.",
  );
  const { ref: _ref, ...publicAccount } = account;
  const snapshot: SourceSnapshot = {
    account: publicAccount,
    retrievedAt: new Date().toISOString(),
    complete: true,
    sections: {},
    warnings: [
      "The5ers source records are kept separate from journal executions until fill identities, price/size units and cost conventions have been verified.",
    ],
    importedExecutions: 0,
  };
  for (const [name, tool, operation] of [
    ["balance", "account", "balance"],
    ["performance", "account", "statistics"],
    ["rules", "program", "rules"],
    ["consistency", "consistency", "list"],
    ["payout", "payout", "eligibility"],
  ] as const) {
    try {
      snapshot.sections[name] = {
        available: true,
        data: publicData(await client.read(tool, operation, { account_ref: account.ref })),
      };
    } catch (error) {
      snapshot.complete = false;
      snapshot.sections[name] = {
        available: false,
        error:
          error instanceof RequestError ? error.message : "This section could not be retrieved.",
      };
    }
  }
  let positionCache: PositionRefs | undefined;
  try {
    const found = await positions(client, account);
    snapshot.complete &&= found.complete;
    snapshot.sections.positions = {
      available: true,
      data: { rows: found.rows, complete: found.complete },
    };
    if (!found.complete)
      snapshot.warnings.push(
        "Position history reached the 1,000-row limit. This source snapshot is partial.",
      );
    positionCache = {
      connectionId: connection.id,
      accountId: id,
      expiresAt: Date.now() + 10 * 60_000,
      refs: found.refs,
    };
  } catch (error) {
    snapshot.complete = false;
    snapshot.sections.positions = {
      available: false,
      error: error instanceof RequestError ? error.message : "Positions could not be retrieved.",
    };
  }
  requireValue(
    Object.values(snapshot.sections).some((section) => section.available),
    "The5ers did not provide any requested account data. Previous snapshots were retained.",
  );
  requireValue(
    Buffer.byteLength(JSON.stringify(snapshot)) <= 4 * 1024 * 1024,
    "The5ers snapshot exceeded its storage limit.",
  );
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    const currentSelection = await getSetting(SELECTION_KEY, tx);
    requireValue(
      currentSelection &&
        (JSON.parse(currentSelection) as Selection[]).some((selected) => selected.id === id),
      "The5ers selection changed during sync.",
    );
    await setSetting(`${SNAPSHOT_PREFIX}${id}`, JSON.stringify(snapshot), tx);
    if (positionCache) {
      requireValue(
        Buffer.byteLength(JSON.stringify(positionCache)) <= 2 * 1024 * 1024,
        "The5ers position reference cache exceeded its size limit.",
      );
      await setSetting(`${REF_PREFIX}${id}`, encryptJson(positionCache), tx);
    } else await tx.delete(settings).where(eq(settings.key, `${REF_PREFIX}${id}`));
  });
  return snapshot;
}
export async function sourceOverview() {
  const selection = await selectedAccounts();
  const stored = await db
    .select()
    .from(settings)
    .where(like(settings.key, `${SNAPSHOT_PREFIX}%`));
  return {
    ...(await connectionSummary()),
    selection,
    snapshots: stored
      .filter((row) => selection.some((account) => row.key === `${SNAPSHOT_PREFIX}${account.id}`))
      .map((row) => JSON.parse(row.value) as SourceSnapshot),
  };
}
/** Limited source reads, never broker actions and never arbitrary caller-supplied refs or URLs. */
export async function readSourceSection(resource: string, id?: string, positionKey?: string) {
  const global: Record<string, { tool: ReadTool; operation: string }> = {
    accountInventory: { tool: "account", operation: "list" },
    purchases: { tool: "purchase", operation: "list" },
    wallet: { tool: "wallet", operation: "overview" },
    coupons: { tool: "wallet", operation: "coupons" },
    achievements: { tool: "achievements", operation: "earned" },
    alerts: { tool: "alerts", operation: "list" },
    affiliate: { tool: "affiliate", operation: "overview" },
  };
  const perAccount: Record<string, { tool: ReadTool; operation: string }> = {
    health: { tool: "account", operation: "health" },
    daily: { tool: "account", operation: "midnight_history" },
    balanceChart: { tool: "account", operation: "balance_chart" },
    journey: { tool: "program", operation: "journey" },
    payoutHistory: { tool: "payout", operation: "history" },
    fills: { tool: "positions", operation: "trades" },
    position: { tool: "positions", operation: "detail" },
  };
  requireValue(
    Object.hasOwn(global, resource) || Object.hasOwn(perAccount, resource),
    "Choose a supported The5ers section.",
  );
  const { connection, client } = await sourceClient();
  if (Object.hasOwn(global, resource)) {
    const read = global[resource]!;
    return publicData(await client.read(read.tool, read.operation));
  }
  requireValue(
    id && (await selectedAccounts()).some((account) => account.id === id),
    "Choose a selected The5ers account.",
  );
  const read = perAccount[resource]!;
  if (resource === "fills" || resource === "position") {
    requireValue(
      positionKey && /^[a-f0-9-]{36}$/.test(positionKey),
      "Choose a position from the latest snapshot.",
    );
    const saved = await getSetting(`${REF_PREFIX}${id}`);
    requireValue(saved, "Refresh positions before reading details.");
    const cache = decryptJson<PositionRefs>(saved);
    requireValue(
      cache.connectionId === connection.id &&
        cache.accountId === id &&
        cache.expiresAt > Date.now() &&
        Object.hasOwn(cache.refs, positionKey),
      "Position details expired. Refresh the account snapshot and try again.",
    );
    return publicData(
      await client.read(read.tool, read.operation, { position_ref: cache.refs[positionKey] }),
    );
  }
  const account = (await inventory(client)).find((a) => a.id === id);
  requireValue(account, "This The5ers account is no longer available.");
  return publicData(await client.read(read.tool, read.operation, { account_ref: account.ref }));
}
export async function syncScheduledThe5ers(deadline = Date.now() + 240_000) {
  const selected = (await selectedAccounts()).filter((account) => account.autoSync);
  let synced = 0,
    failed = 0;
  for (const account of selected) {
    try {
      requireValue(Date.now() < deadline, "The5ers scheduled sync time budget was exhausted.");
      await syncSourceAccount(account.id, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      synced++;
    } catch (error) {
      failed++;
      console.error("[cron] The5ers source sync failed", {
        accountId: account.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return { checked: selected.length, synced, failed };
}
