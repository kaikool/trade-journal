import { createHash, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { db, settings, accounts as journalAccounts, propAccounts, propAudit } from "@/db";
import { parseTimestamp } from "@luxalgo/journal-importers";
import { RequestError, requireValue } from "@/server/api";
import { getSetting, setSetting } from "@/server/settings";
import { encryptJson, decryptJson } from "@/server/crypto";
import { publicData, record, type ReadTool } from "./contracts";
import { PROP_PROGRAMS, PROP_STATES, currencyDigits } from "@/lib/prop-firms";
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
  currency?: string;
  status?: string;
  program?: string;
}
interface ProviderAccount extends SourceAccount {
  ref: string;
}
export interface Selection {
  id: string;
  label: string;
  autoSync: boolean;
  journalAccountId?: string;
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
      const platform =
        row.tradingPlatform ?? row.platform ?? row.tradingSystem ?? row.trading_system;
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
      const envelope = record(value);
      const currency =
        row.currency ??
        envelope.currency ??
        (envelope.data && !Array.isArray(envelope.data)
          ? record(envelope.data).currency
          : undefined);
      return {
        currency:
          typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
        status: typeof row.status === "string" ? row.status : undefined,
        program:
          typeof (row.type ?? row.accountType ?? row.account_type) === "string"
            ? String(row.type ?? row.accountType ?? row.account_type)
            : undefined,
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
export async function selectSourceAccounts(
  ids: unknown,
  autoSync: unknown,
  linkJournalAccounts = false,
  journalLinks: Record<string, string> = {},
) {
  requireValue(
    Array.isArray(ids) &&
      ids.length <= 10 &&
      ids.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
      new Set(ids).size === ids.length &&
      typeof autoSync === "boolean",
    "Select up to 10 accounts and choose automatic sync.",
  );
  requireValue(
    Object.keys(journalLinks).length <= 10 &&
      Object.entries(journalLinks).every(
        ([source, target]) =>
          (ids as string[]).includes(source) && /^[a-zA-Z0-9_-]{1,100}$/.test(target),
      ),
    "Choose valid existing journal accounts.",
  );
  const storedLinks = JSON.parse((await getSetting("the5ers:journal-links")) ?? "{}") as Record<
    string,
    string
  >;
  const { connection, client } = await sourceClient();
  const available = await inventory(client);
  const selected = ids.map((id) => {
    const account = available.find((a) => a.id === id);
    requireValue(account, "An account is no longer available. Refresh the account list.");
    return {
      id: account.id,
      label: account.label,
      autoSync,
      journalAccountId:
        journalLinks[id] ?? storedLinks[id] ?? (linkJournalAccounts ? `the5ers_${id}` : undefined),
    };
  });
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    if (linkJournalAccounts)
      for (const selectedAccount of [...selected].sort((a, b) =>
        (a.journalAccountId ?? "").localeCompare(b.journalAccountId ?? ""),
      )) {
        const account = available.find((a) => a.id === selectedAccount.id)!;
        requireValue(
          account.currency,
          "The5ers did not report this account's currency. No journal account was created.",
        );
        try {
          currencyDigits(account.currency);
        } catch {
          throw new RequestError(
            "The5ers reported an unsupported account currency. No journal account was created.",
          );
        }
        const id = selectedAccount.journalAccountId!,
          now = new Date().toISOString();
        const mappings = JSON.parse(
          (await getSetting("the5ers:journal-links", tx)) ?? "{}",
        ) as Record<string, string>;
        requireValue(
          !Object.entries(mappings).some(
            ([source, target]) => source !== account.id && target === id,
          ),
          "This journal account is already linked to another The5ers account.",
        );
        if (id === `the5ers_${account.id}`) {
          await tx
            .insert(journalAccounts)
            .values({
              id,
              name: `The5ers · ${account.label}`,
              broker: "The5ers",
              kind: "import",
              currency: account.currency,
              initialBalance: 0,
              autoSync: false,
              createdAt: now,
            })
            .onConflictDoNothing();
        }
        const [existing] = await tx
          .select()
          .from(journalAccounts)
          .where(eq(journalAccounts.id, id));
        requireValue(
          existing && existing.kind !== "sync" && existing.currency === account.currency,
          "The linked journal account currency or provider changed. Review it before linking again.",
        );
        if (!(await getSetting(`${SNAPSHOT_PREFIX}${account.id}`, tx))) {
          const { ref: _ref, ...publicAccount } = account;
          const source = record(account.source);
          const money = Object.fromEntries(
            ["balance", "effectiveBalance", "effective_balance", "equity"]
              .filter((key) => typeof source[key] === "number" && Number.isFinite(source[key]))
              .map((key) => [key, source[key]]),
          );
          if (Object.keys(money).length) {
            const snapshot: SourceSnapshot = {
              account: publicAccount,
              retrievedAt: now,
              complete: false,
              importedExecutions: 0,
              warnings: [
                "Account inventory snapshot; source freshness is unknown. Refresh to retrieve program and position history.",
              ],
              sections: {
                balance: { available: true, data: { currency: account.currency, data: money } },
              },
            };
            await setSetting(`${SNAPSHOT_PREFIX}${account.id}`, JSON.stringify(snapshot), tx);
          }
        }
        const previousJournal = mappings[account.id];
        mappings[account.id] = id;
        await setSetting("the5ers:journal-links", JSON.stringify(mappings), tx);
        let [tracked] = await tx
          .select()
          .from(propAccounts)
          .where(eq(propAccounts.id, `the5ers_${account.id}`))
          .for("update");
        const associated = await tx
          .select()
          .from(propAccounts)
          .where(
            and(
              eq(propAccounts.journalAccountId, previousJournal ?? id),
              eq(propAccounts.firm, "The5ers"),
            ),
          )
          .for("update");
        if (!tracked && associated.length === 1 && associated[0]!.currency === account.currency)
          tracked = associated[0];
        if (tracked && tracked.journalAccountId !== id) {
          requireValue(
            tracked.firm === "The5ers" && tracked.currency === account.currency,
            "Review the existing prop account before changing its journal link.",
          );
          await tx
            .update(propAccounts)
            .set({
              journalAccountId: id,
              updatedAt: now,
              revision: sql`${propAccounts.revision} + 1`,
            })
            .where(eq(propAccounts.id, tracked.id));
          await tx.insert(propAudit).values({
            id: randomUUID(),
            entityType: "account",
            entityId: tracked.id,
            beforeJson: JSON.stringify(tracked),
            afterJson: JSON.stringify({
              ...tracked,
              journalAccountId: id,
              revision: tracked.revision + 1,
            }),
            reason: "Updated The5ers journal association",
            createdAt: now,
          });
        }
        if (
          !tracked &&
          associated.length === 0 &&
          PROP_PROGRAMS.includes(account.program as (typeof PROP_PROGRAMS)[number]) &&
          PROP_STATES.includes(account.status as (typeof PROP_STATES)[number])
        ) {
          const value = {
            id: `the5ers_${account.id}`,
            firm: "The5ers",
            name: account.label,
            program: account.program!,
            status: account.status!,
            currency: account.currency,
            journalAccountId: id,
            openedOn: account.createdAt.slice(0, 10),
            createdAt: now,
            updatedAt: now,
          };
          const created = await tx
            .insert(propAccounts)
            .values(value)
            .onConflictDoNothing()
            .returning({ id: propAccounts.id });
          if (created.length)
            await tx.insert(propAudit).values({
              id: randomUUID(),
              entityType: "account",
              entityId: id,
              afterJson: JSON.stringify(value),
              reason: "Linked from The5ers account selection",
              createdAt: now,
            });
        }
      }
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
    if (resource === "accountInventory")
      return {
        accounts: (await inventory(client)).map(({ ref: _ref, ...account }) => account),
        complete: true,
      };
    if (resource === "purchases" || resource === "alerts")
      return paginatedSource(
        client,
        read.tool,
        read.operation,
        resource === "purchases" ? "purchases" : "alerts",
      );
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
  if (resource === "payoutHistory")
    return paginatedSource(client, read.tool, read.operation, "payouts", {
      account_ref: account.ref,
    });
  return publicData(await client.read(read.tool, read.operation, { account_ref: account.ref }));
}
export async function syncScheduledThe5ers(deadline = Date.now() + 240_000) {
  const candidates = (await selectedAccounts()).filter((account) => account.autoSync);
  const native = candidates.some((a) => a.journalAccountId)
    ? await db
        .select({ id: journalAccounts.id, archivedAt: journalAccounts.archivedAt })
        .from(journalAccounts)
    : [];
  const selected = candidates.filter(
    (a) => !a.journalAccountId || native.some((n) => n.id === a.journalAccountId && !n.archivedAt),
  );
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

/** Preserve every page envelope (currency/coverage), rather than silently merging money. */
async function paginatedSource(
  client: The5ersMcp,
  tool: ReadTool,
  operation: string,
  collection: string,
  args: Record<string, unknown> = {},
) {
  const pages: unknown[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (let page = 1; page <= 50; page++) {
    const result = record(await client.read(tool, operation, { ...args, page, limit: 20 }));
    const body = result.data && !Array.isArray(result.data) ? record(result.data) : result;
    const pagination = record(result.pagination ?? body.pagination);
    requireValue(
      typeof pagination.has_more === "boolean",
      "The5ers did not report pagination coverage for this source.",
    );
    const values =
      body[collection] ??
      body.items ??
      body.notifications ??
      body.history ??
      (Array.isArray(result.data) ? result.data : undefined);
    requireValue(
      Array.isArray(values) && values.length <= 20,
      "The5ers returned an unsupported paginated source format.",
    );
    const safe = publicData(result);
    const fingerprint = JSON.stringify(values);
    requireValue(
      !seen.has(fingerprint) && (!pagination.has_more || values.length > 0),
      "The5ers repeated or omitted a source page. No cash records were posted.",
    );
    seen.add(fingerprint);
    bytes += Buffer.byteLength(JSON.stringify(safe));
    requireValue(bytes <= 4 * 1024 * 1024, "The5ers source exceeded its size limit.");
    pages.push(safe);
    if (!pagination.has_more) return { pages, complete: true };
  }
  return {
    pages,
    complete: false,
    warning: "Source history reached its page limit; additional records may exist.",
  };
}
