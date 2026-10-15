import { moduleArchiveSummary, readArchivedModule, syncModuleArchive } from "./modules";
import { the5ersAccountName, the5ersDefaultName } from "@/lib/the5ers-name";
import { createHash, randomUUID } from "node:crypto";
import { and, or, eq, like, sql, count, inArray } from "drizzle-orm";
import { db, settings, accounts as journalAccounts, propAccounts, propAudit, trades } from "@/db";
import { saveJournalPositions, reconcilePurchases, positionIdentity } from "./journal";
import { payoutKey, sourceRecords, recordPayoutReceipt } from "./payouts";
import {
  sourceCurrency,
  sourceFields,
  sourceNumber,
  sourceProgram,
  sourcePropStatus,
  sourceInstant,
  normalizePosition,
} from "@/lib/the5ers-normalize";
import { getTimeZone } from "@/server/settings";
import { isActiveSource } from "@/lib/the5ers-status";
import { parseTimestamp } from "@luxalgo/journal-importers";
import { RequestError, requireValue } from "@/server/api";
import { getSetting, setSetting } from "@/server/settings";
import { encryptJson, decryptJson } from "@/server/crypto";
import { publicData, record, type ReadTool } from "./contracts";
import { currencyDigits } from "@/lib/prop-firms";
import { The5ersMcp } from "./mcp";
import {
  accessConnection,
  CONNECTION_KEY,
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
  journaledPositions?: number;
  skippedPositions?: number;
  ambiguousPositions?: number;
  skippedPositionIndexes?: number[];
  importedPositions?: number;
  updatedPositions?: number;
  unchangedPositions?: number;
  canImportSnapshot?: boolean;
  normalizationVersion?: number;
  storedTrades?: number;
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
    rows.length <= (collection === "accounts" ? 1000 : 100),
    "The5ers response exceeded its safety limit.",
  );
  const pagination = record(envelope.pagination ?? body.pagination ?? {});
  const reportedTotal = pagination.total ?? body.total ?? envelope.total ?? undefined;
  const total =
    typeof reportedTotal === "string" && /^\d{1,6}$/.test(reportedTotal)
      ? Number(reportedTotal)
      : reportedTotal;
  requireValue(
    total === undefined || (Number.isSafeInteger(total) && Number(total) >= 0),
    "The5ers reported an invalid account total.",
  );
  if (collection === "positions")
    requireValue(
      typeof pagination.has_more === "boolean",
      "The5ers did not report pagination coverage.",
    );
  return {
    rows,
    hasMore:
      typeof pagination.has_more === "boolean"
        ? pagination.has_more
        : typeof total === "number" && rows.length === total
          ? false
          : null,
    total: typeof total === "number" ? total : undefined,
  };
}
export function parseProviderAccounts(value: unknown): {
  accounts: ProviderAccount[];
  hasMore: boolean | null;
  total?: number;
  rawCount: number;
} {
  const page = pageData(value, "accounts");
  const accounts: ProviderAccount[] = page.rows
    .filter((item) => !record(item).contest_account_ref)
    .map((item) => {
      const original = record(item);
      const fields = sourceFields(original);
      const row: Record<string, unknown> = {
        ...original,
        currency: fields.currency,
        status: fields.status,
        type: fields.type,
        accountType: fields.accounttype,
        phase: fields.phase,
        stage: fields.stage,
      };
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
  return { accounts, hasMore: page.hasMore, total: page.total, rawCount: page.rows.length };
}
interface AccountInventory {
  accounts: ProviderAccount[];
  complete: boolean;
  warnings: string[];
}
async function inventoryResult(client: The5ersMcp): Promise<AccountInventory> {
  const all: ProviderAccount[] = [];
  const seenIds = new Set<string>();
  const seenRefs = new Set<string>();
  let rawCount = 0,
    total: number | undefined,
    bytes = 0;
  const partial = (warning: string) => ({ accounts: all, complete: false, warnings: [warning] });
  for (let page = 1; page <= 20; page++) {
    const parsed = parseProviderAccounts(await client.read("account", "list", { page, limit: 50 }));
    const ids = parsed.accounts.map((a) => a.id);
    requireValue(
      new Set(ids).size === ids.length,
      "The5ers account labels and creation dates are ambiguous. Sync stopped without merging accounts.",
    );
    requireValue(
      new Set(parsed.accounts.map((a) => a.ref)).size === parsed.accounts.length,
      "The5ers returned ambiguous account references.",
    );
    const novel = parsed.accounts.filter((a) => !seenIds.has(a.id));
    requireValue(
      novel.every((a) => !seenRefs.has(a.ref)),
      "The5ers reused one account reference for different account identities.",
    );
    if (parsed.accounts.length && !novel.length)
      return partial("The5ers repeated a page. Some additional accounts may be unavailable.");
    if (parsed.total !== undefined) {
      if (total !== undefined && total !== parsed.total)
        return partial("The5ers account total changed during retrieval. Refresh the list.");
      total = parsed.total;
    }
    if (rawCount + parsed.rawCount - (parsed.accounts.length - novel.length) > 1000)
      return partial("The account list reached its 1,000-record safety limit and is incomplete.");
    bytes += Buffer.byteLength(JSON.stringify(parsed.accounts));
    requireValue(bytes <= 4 * 1024 * 1024, "The5ers account inventory exceeded its size limit.");
    rawCount += parsed.rawCount - (parsed.accounts.length - novel.length);
    all.push(...novel);
    ids.forEach((id) => seenIds.add(id));
    parsed.accounts.forEach((a) => seenRefs.add(a.ref));
    if (total !== undefined && rawCount === total)
      return { accounts: all, complete: true, warnings: [] };
    if (parsed.hasMore === false)
      return total === undefined || rawCount === total
        ? { accounts: all, complete: true, warnings: [] }
        : partial("The5ers reported more accounts than were retrieved. The list is incomplete.");
    if (parsed.hasMore === null)
      return partial(
        "The5ers did not report sufficient pagination coverage. The account list is incomplete.",
      );
    if (!parsed.rawCount)
      return partial(
        "The5ers returned an empty account page while reporting more records. The list is incomplete.",
      );
  }
  return partial("The account list reached its page limit and is incomplete.");
}
async function inventory(client: The5ersMcp): Promise<ProviderAccount[]> {
  const result = await inventoryResult(client);
  requireValue(result.complete, result.warnings.join(" "));
  return result.accounts;
}
export async function listSourceInventory() {
  const { client } = await sourceClient();
  const result = await inventoryResult(client);
  return { ...result, accounts: result.accounts.map(({ ref: _ref, ...account }) => account) };
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
export async function inspectPayoutContract() {
  const { client } = await sourceClient();
  const contract = await client.payoutContract();
  const overview = await sourceOverview();
  return {
    ...contract,
    financialSync: overview.cash,
    moduleSync: overview.moduleSync,
    purchases: overview.purchases,
    payoutHistory: overview.cashSnapshots,
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
      parsed.length <= 1000 &&
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
      ids.length <= 1000 &&
      ids.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
      new Set(ids).size === ids.length &&
      typeof autoSync === "boolean",
    "Select accounts and choose automatic sync.",
  );
  requireValue(
    Object.keys(journalLinks).length <= 1000 &&
      Object.entries(journalLinks).every(
        ([source, target]) =>
          (ids as string[]).includes(source) &&
          typeof target === "string" &&
          /^[a-zA-Z0-9_-]{1,100}$/.test(target),
      ),
    "Choose valid existing journal accounts.",
  );
  const storedLinks = JSON.parse((await getSetting("the5ers:journal-links")) ?? "{}") as Record<
    string,
    string
  >;
  const { connection, client } = await sourceClient();
  const available = (await inventoryResult(client)).accounts;
  const selected = ids.map((id) => {
    const account = available.find((a) => a.id === id);
    requireValue(account, "An account is no longer available. Refresh the account list.");
    return {
      id: account.id,
      label: account.label,
      autoSync: autoSync && isActiveSource(account.status),
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
              name: the5ersDefaultName(account),
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
        const normalizedProgram =
          sourceProgram(account.program) ??
          sourceProgram(sourceFields(account.source).phase) ??
          sourceProgram(sourceFields(account.source).stage);
        const normalizedStatus = sourcePropStatus(account.status);
        if (!tracked && associated.length === 0 && normalizedProgram && normalizedStatus) {
          const value = {
            id: `the5ers_${account.id}`,
            firm: "The5ers",
            name: account.label,
            program: normalizedProgram,
            status: normalizedStatus,
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
/** Account-scoped metadata must agree; never default missing money currency to USD. */
export function snapshotCurrency(snapshot: SourceSnapshot): string | undefined {
  const reported = [
    snapshot.account.currency,
    ...["balance", "performance", "rules", "positions"].flatMap((name) => {
      const section = snapshot.sections[name];
      if (!section?.available) return [];
      const envelope = sourceFields(section.data);
      return [envelope.currency ?? sourceFields(envelope.data).currency];
    }),
  ].filter((value): value is string => typeof value === "string");
  if (
    reported.length < 1 ||
    reported.some((value) => !sourceCurrency(value)) ||
    new Set(reported).size !== 1
  )
    return;
  return reported[0];
}

async function saveSnapshotPropAccount(
  tx: import("@/db/postgres").JournalExecutor,
  snapshot: SourceSnapshot,
  journalAccountId: string | null,
  currency: string,
) {
  const archivedRules = await getSetting(
    `the5ers:module:the5ers_program:rules:${snapshot.account.id}:${snapshot.account.id}:1`,
    tx,
  );
  const cachedSnapshot = await getSetting(`${SNAPSHOT_PREFIX}${snapshot.account.id}`, tx);
  const savedRules = cachedSnapshot
    ? (JSON.parse(cachedSnapshot) as SourceSnapshot).sections.rules?.data
    : undefined;
  const rulesForName =
    snapshot.sections.rules?.data ?? (archivedRules ? JSON.parse(archivedRules).data : savedRules);
  const generatedName = the5ersDefaultName(snapshot.account, rulesForName);
  const nameKey = `the5ers:default-name:${snapshot.account.id}`;
  const previousName = await getSetting(nameKey, tx);
  const legacyNames = [
    the5ersDefaultName(snapshot.account),
    `The5ers · ${snapshot.account.label}`,
    the5ersAccountName(`The5ers · ${snapshot.account.label}`),
    snapshot.account.label,
  ];
  const mayRename = (name: string) => name === previousName || legacyNames.includes(name);
  if (journalAccountId) {
    const [journal] = await tx
      .select()
      .from(journalAccounts)
      .where(eq(journalAccounts.id, journalAccountId));
    if (journal?.broker === "The5ers" && mayRename(journal.name))
      await tx
        .update(journalAccounts)
        .set({ name: generatedName })
        .where(eq(journalAccounts.id, journalAccountId));
  }
  const program =
    sourceProgram(snapshot.account.program) ??
    sourceProgram(
      sourceFields(
        sourceFields(snapshot.sections.rules?.data).data ?? snapshot.sections.rules?.data,
      ).name,
    );
  const status = sourcePropStatus(snapshot.account.status);
  const [tracked] = await tx
    .select()
    .from(propAccounts)
    .where(
      and(
        or(
          eq(propAccounts.id, `the5ers_${snapshot.account.id}`),
          journalAccountId ? eq(propAccounts.journalAccountId, journalAccountId) : sql`false`,
        ),
        eq(propAccounts.firm, "The5ers"),
      ),
    );
  if (tracked && mayRename(tracked.name) && tracked.name !== generatedName) {
    const updatedAt = new Date().toISOString();
    await tx
      .update(propAccounts)
      .set({ name: generatedName, updatedAt })
      .where(eq(propAccounts.id, tracked.id));
    await tx.insert(propAudit).values({
      id: randomUUID(),
      entityType: "account",
      entityId: tracked.id,
      beforeJson: JSON.stringify(tracked),
      afterJson: JSON.stringify({ ...tracked, name: generatedName, updatedAt }),
      reason: "Updated default source account name",
      createdAt: updatedAt,
    });
  }
  await setSetting(nameKey, generatedName, tx);
  if (tracked && !tracked.journalAccountId && journalAccountId && tracked.currency === currency) {
    const updatedAt = new Date().toISOString();
    await tx
      .update(propAccounts)
      .set({ journalAccountId, updatedAt })
      .where(eq(propAccounts.id, tracked.id));
    await tx.insert(propAudit).values({
      id: randomUUID(),
      entityType: "account",
      entityId: tracked.id,
      beforeJson: JSON.stringify(tracked),
      afterJson: JSON.stringify({ ...tracked, journalAccountId, updatedAt }),
      reason: "Linked an existing imported funding phase to its selected trading account",
      createdAt: updatedAt,
    });
  }
  if (!tracked && program && status) {
    const now = new Date().toISOString();
    const value = {
      id: `the5ers_${snapshot.account.id}`,
      firm: "The5ers",
      name: generatedName,
      program,
      status,
      currency,
      journalAccountId: journalAccountId,
      openedOn: snapshot.account.createdAt.slice(0, 10),
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
        entityId: value.id,
        afterJson: JSON.stringify(value),
        reason: "Imported verified The5ers funding phase from saved account metadata",
        createdAt: now,
      });
  }
}

export async function importSavedSnapshot(id: string) {
  return db.transaction(async (tx) => {
    await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
    const [stored] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, `${SNAPSHOT_PREFIX}${id}`))
      .for("update");
    requireValue(stored, "No saved The5ers history is available. Refresh this account.");
    const selected = JSON.parse((await getSetting(SELECTION_KEY, tx)) ?? "[]") as Selection[];
    requireValue(
      selected.some((account) => account.id === id),
      "Choose a selected The5ers account.",
    );
    const snapshot = JSON.parse(stored.value) as SourceSnapshot;
    const section = snapshot.sections.positions;
    const data = sourceFields(section?.data);
    const contextual = snapshotCurrency(snapshot);
    const currency = contextual;
    requireValue(
      section?.available && currency && (!contextual || contextual === currency),
      "Account currency is missing or conflicting. Refresh the account to verify it.",
    );
    requireValue(Array.isArray(data.rows), "Saved position history is unavailable.");
    const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
      string,
      string
    >;
    if (!links[id]) {
      const journalAccountId = `the5ers_${id}`;
      await tx
        .insert(journalAccounts)
        .values({
          id: journalAccountId,
          name: the5ersDefaultName(snapshot.account, snapshot.sections.rules?.data),
          broker: "The5ers",
          kind: "import",
          currency,
          initialBalance: 0,
          autoSync: false,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing();
      const [native] = await tx
        .select()
        .from(journalAccounts)
        .where(eq(journalAccounts.id, journalAccountId));
      requireValue(
        native && native.broker === "The5ers" && native.currency === currency,
        "The existing journal account has a conflicting provider or currency.",
      );
      links[id] = journalAccountId;
      await setSetting("the5ers:journal-links", JSON.stringify(links), tx);
      await setSetting(
        SELECTION_KEY,
        JSON.stringify(
          selected.map((account) =>
            account.id === id ? { ...account, journalAccountId } : account,
          ),
        ),
        tx,
      );
    }
    const outcome = await saveJournalPositions(
      tx,
      id,
      currency,
      snapshot.retrievedAt,
      data.rows.map((row) => sourceFields(row).source),
      data.complete === true,
    );
    await saveSnapshotPropAccount(tx, snapshot, links[id]!, currency);
    Object.assign(snapshot, outcome);
    snapshot.warnings = snapshot.warnings.filter(
      (warning) => !warning.startsWith("Position currency is missing"),
    );
    snapshot.canImportSnapshot = false;
    snapshot.normalizationVersion = 6;
    await setSetting(`${SNAPSHOT_PREFIX}${id}`, JSON.stringify(snapshot), tx);
    return snapshot;
  });
}

function detailPositionKey(accountId: string, value: unknown) {
  const position = normalizePosition(value);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        accountId,
        position
          ? [positionIdentity(position), position.providerId, position.quantity, position.entry]
          : publicData(value),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

async function positions(
  client: The5ersMcp,
  account: ProviderAccount,
  contextualCurrency?: string,
) {
  const rows: { key: string; hasDetails: boolean; source: unknown }[] = [],
    refs: Record<string, string> = {},
    seen = new Set<string>();
  const seenPages = new Set<string>();
  let currency: string | undefined,
    currencyVerified = true;
  for (let page = 1; page <= 10; page++) {
    const response = await client.read("positions", "list", {
      account_ref: account.ref,
      view: "all",
      page,
      limit: 100,
    });
    const envelope = record(response);
    const body = sourceFields(envelope.data ?? envelope);
    const reportedCurrency = sourceFields(envelope).currency ?? body.currency;
    const pageCurrency =
      reportedCurrency === undefined ? contextualCurrency : sourceCurrency(reportedCurrency);
    currencyVerified &&= Boolean(pageCurrency);
    requireValue(
      !currency || !pageCurrency || currency === pageCurrency,
      "The5ers position currency changed across pages.",
    );
    currency = pageCurrency ?? currency;
    const result = pageData(response, "positions");
    const fingerprint = JSON.stringify(
      result.rows.map((row) => JSON.stringify(publicData(row))).sort(),
    );
    if (seenPages.has(fingerprint))
      return {
        rows,
        refs,
        currency: currencyVerified ? currency : undefined,
        complete: result.total === rows.length,
        repeatedPage: true,
        reportedTotal: result.total,
      };
    seenPages.add(fingerprint);
    for (const item of result.rows) {
      const row = record(item),
        key = detailPositionKey(account.id, row),
        ref = row.ref ?? row.position_ref;
      if (reference(ref)) {
        requireValue(!seen.has(ref), "The5ers repeated a position page.");
        seen.add(ref);
        if (Object.hasOwn(refs, key)) {
          // Preserve the raw record for reconciliation instead of aborting the whole account.
          const alternate = randomUUID();
          rows.push({ key: alternate, hasDetails: true, source: publicData(row) });
          refs[alternate] = ref;
          continue;
        }
        refs[key] = ref;
      }
      rows.push({ key, hasDetails: Boolean(refs[key]), source: publicData(row) });
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new RequestError("The5ers position history exceeded the snapshot size limit.");
    if (!result.hasMore || result.total === rows.length)
      return {
        rows,
        refs,
        currency: currencyVerified ? currency : undefined,
        complete: result.total === undefined || result.total === rows.length,
        reportedTotal: result.total,
      };
    requireValue(
      result.rows.length > 0,
      "The5ers returned an empty position page with more pages indicated.",
    );
  }
  return { rows, refs, currency: currencyVerified ? currency : undefined, complete: false };
}
class InactiveSource extends RequestError {}
export async function syncSourceAccount(
  id: string,
  signal?: AbortSignal,
  automatic = false,
  cachedAccount?: ProviderAccount,
): Promise<SourceSnapshot> {
  requireValue(
    (await selectedAccounts()).some((account) => account.id === id),
    "Select this The5ers account before syncing it.",
  );
  const { connection, client } = await sourceClient(signal);
  const account =
    cachedAccount?.id === id
      ? cachedAccount
      : (await inventoryResult(client)).accounts.find((a) => a.id === id);
  requireValue(
    account,
    "The selected The5ers account identity changed or is unavailable. Refresh and select it again.",
  );
  if (automatic && !isActiveSource(account.status))
    throw new InactiveSource(
      "This The5ers account is no longer active; use manual refresh for history.",
    );
  const { ref: _ref, ...publicAccount } = account;
  const snapshot: SourceSnapshot = {
    account: publicAccount,
    retrievedAt: new Date().toISOString(),
    complete: true,
    sections: {},
    warnings: [
      "Journal analytics use reported position net P&L; no atomic fills are reconstructed and fee/swap are not deducted twice.",
    ],
    importedExecutions: 0,
  };

  const sectionsToFetch = [
    ["balance", "account", "balance"],
    ["performance", "account", "statistics"],
    ["rules", "program", "rules"],
    ["consistency", "consistency", "list"],
    ["payout", "payout", "eligibility"],
  ] as const;

  await Promise.all(
    sectionsToFetch.map(async ([name, tool, operation]) => {
      try {
        const res = await client.read(tool, operation, { account_ref: account.ref });
        snapshot.sections[name] = {
          available: true,
          data: publicData(res),
        };
      } catch (error) {
        snapshot.complete = false;
        snapshot.sections[name] = {
          available: false,
          error:
            error instanceof RequestError ? error.message : "This section could not be retrieved.",
        };
      }
    }),
  );
  let positionCache: PositionRefs | undefined;
  let journalPositions: { rows: unknown[]; currency: string; complete: boolean } | undefined;
  try {
    const found = await positions(client, account, snapshotCurrency(snapshot));
    snapshot.complete &&= found.complete;
    snapshot.sections.positions = {
      available: true,
      data: {
        rows: found.rows,
        currency: found.currency,
        complete: found.complete,
        reportedTotal: "reportedTotal" in found ? found.reportedTotal : undefined,
        repeatedPage: "repeatedPage" in found ? found.repeatedPage : false,
      },
    };
    if (found.currency && found.currency === (account.currency ?? snapshotCurrency(snapshot)))
      journalPositions = {
        rows: found.rows.map((r) => r.source),
        currency: found.currency,
        complete: found.complete,
      };
    else {
      snapshot.complete = false;
      snapshot.warnings.push(
        "Position currency is missing or differs from the journal. Reported positions were not included in analytics.",
      );
    }
    if (!found.complete)
      snapshot.warnings.push(
        "Position history is incomplete: pagination stopped before all source records could be verified.",
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
    if (journalPositions) {
      try {
        // Pure validation happens before the one storage write; invalid positions retain prior history.
        const outcome = await saveJournalPositions(
          tx,
          id,
          journalPositions.currency,
          snapshot.retrievedAt,
          journalPositions.rows,
          journalPositions.complete,
        );
        const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
          string,
          string
        >;
        if (links[id])
          await saveSnapshotPropAccount(tx, snapshot, links[id]!, journalPositions.currency);
        Object.assign(snapshot, outcome, { normalizationVersion: 6 });
        if (outcome.skippedPositions) snapshot.complete = false;
        if (outcome.skippedPositions)
          snapshot.warnings.push(
            `${outcome.skippedPositions} positions need review: ${outcome.ambiguousPositions} have no distinguishable stable identity; others are missing required trade facts. Other valid positions were imported.`,
          );
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        snapshot.complete = false;
        snapshot.warnings.push(error.message);
      }
    }
    await setSetting(`${SNAPSHOT_PREFIX}${id}`, JSON.stringify(snapshot), tx);
    if (positionCache) {
      requireValue(
        Buffer.byteLength(JSON.stringify(positionCache)) <= 2 * 1024 * 1024,
        "The5ers position reference cache exceeded its size limit.",
      );
      await setSetting(`${REF_PREFIX}${id}`, encryptJson(positionCache), tx);
    } else await tx.delete(settings).where(eq(settings.key, `${REF_PREFIX}${id}`));
  });
  try {
    snapshot.sections.payoutHistory = {
      available: true,
      data: await fetchAndSavePayouts(client, connection.id, account, id),
    };
  } catch (error) {
    snapshot.sections.payoutHistory = {
      available: false,
      error:
        error instanceof RequestError ? error.message : "Payout history could not be retrieved.",
    };
  }
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    const saved = await getSetting(`${SNAPSHOT_PREFIX}${id}`, tx);
    if (!saved) return;
    const current = JSON.parse(saved) as SourceSnapshot;
    if (current.retrievedAt !== snapshot.retrievedAt) return;
    current.sections.payoutHistory = snapshot.sections.payoutHistory!;
    await setSetting(`${SNAPSHOT_PREFIX}${id}`, JSON.stringify(current), tx);
  });
  return snapshot;
}
/** Small status response for settings/progress; never transfers account history pages. */
export async function sourceSyncOverview() {
  const [connection, selection, timeZone, cash, moduleSync] = await Promise.all([
    connectionSummary(),
    selectedAccounts(),
    getTimeZone(),
    getSetting("the5ers:cash"),
    moduleArchiveSummary(),
  ]);
  return {
    ...connection,
    selection,
    timeZone,
    cash: JSON.parse(cash ?? "null"),
    moduleSync,
    snapshots: [],
  };
}
export async function sourceOverview() {
  const selection = await selectedAccounts();
  const mappings = JSON.parse((await getSetting("the5ers:journal-links")) ?? "{}") as Record<
    string,
    string
  >;
  const archivedBalances = selection.length
    ? await db
        .select()
        .from(settings)
        .where(
          inArray(
            settings.key,
            selection.map(
              (account) => `the5ers:module:account:balance:${account.id}:${account.id}:1`,
            ),
          ),
        )
    : [];
  const counts = await db
    .select({ accountId: trades.accountId, total: count() })
    .from(trades)
    .groupBy(trades.accountId);
  const payoutHistory = await db
    .select()
    .from(settings)
    .where(like(settings.key, "the5ers:payouts:%"));
  const stored = await db
    .select()
    .from(settings)
    .where(like(settings.key, `${SNAPSHOT_PREFIX}%`));
  return {
    ...(await connectionSummary()),
    timeZone: await getTimeZone(),
    selection,
    purchases: JSON.parse((await getSetting("the5ers:purchases")) ?? "null"),
    cash: JSON.parse((await getSetting("the5ers:cash")) ?? "null"),
    cashSelection: payoutHistory.map((row) => {
      const history = JSON.parse(row.value);
      const id = row.key.slice("the5ers:payouts:".length);
      return {
        id,
        label:
          history.account?.label ?? selection.find((a) => a.id === id)?.label ?? "The5ers account",
        autoSync: false,
        journalAccountId: mappings[id] ?? `the5ers_${id}`,
      };
    }),
    cashSnapshots: payoutHistory.map((row) => {
      const history = JSON.parse(row.value);
      const id = row.key.slice("the5ers:payouts:".length);
      return {
        account: history.account ?? {
          id,
          label: selection.find((a) => a.id === id)?.label ?? "The5ers account",
        },
        retrievedAt: history.retrievedAt,
        complete: false,
        sections: { payoutHistory: { available: true, data: history } },
        warnings: [],
        importedExecutions: 0,
      };
    }),
    moduleSync: await moduleArchiveSummary(),
    snapshots: stored
      .filter((row) => selection.some((account) => row.key === `${SNAPSHOT_PREFIX}${account.id}`))
      .map((row) => {
        const snapshot = JSON.parse(row.value) as SourceSnapshot;
        const archived = archivedBalances.find(
          (balance) =>
            balance.key ===
            `the5ers:module:account:balance:${snapshot.account.id}:${snapshot.account.id}:1`,
        );
        if (archived) {
          const cached = JSON.parse(archived.value);
          const body = sourceFields(sourceFields(cached.data).data);
          if (
            typeof body.balance === "number" &&
            Date.parse(cached.retrievedAt) > Date.parse(snapshot.retrievedAt)
          ) {
            snapshot.sections.balance = { available: true, data: cached.data };
            snapshot.retrievedAt = cached.retrievedAt;
          }
        }
        snapshot.storedTrades =
          counts.find((row) => row.accountId === mappings[snapshot.account.id])?.total ?? 0;
        const data = sourceFields(snapshot.sections.positions?.data);
        snapshot.canImportSnapshot =
          (snapshot.normalizationVersion !== 6 || !mappings[snapshot.account.id]) &&
          Boolean(snapshotCurrency(snapshot)) &&
          snapshot.sections.positions?.available === true &&
          Array.isArray(data.rows) &&
          data.rows.length > 0;
        const payout = payoutHistory.find(
          (p) => p.key === `the5ers:payouts:${snapshot.account.id}`,
        );
        if (payout)
          snapshot.sections.payoutHistory = { available: true, data: JSON.parse(payout.value) };
        return snapshot;
      }),
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
  const archivedRead = global[resource] ?? perAccount[resource];
  if (!["fills", "position", "wallet", "accountInventory", "payoutHistory"].includes(resource)) {
    const saved = await readArchivedModule(
      archivedRead!.tool,
      archivedRead!.operation,
      Object.hasOwn(global, resource) ? "global" : (id ?? "global"),
    );
    if (saved.available)
      return saved.pages.length === 1 && archivedRead!.operation !== "list"
        ? saved.pages[0].data
        : {
            pages: saved.pages.map((page: { data: unknown }) => page.data),
            complete:
              sourceFields(sourceFields(saved.pages.at(-1)?.data).pagination).hasmore === false,
          };
  }
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
    id &&
      (resource === "payoutHistory" ||
        (await selectedAccounts()).some((account) => account.id === id)),
    "Choose a selected The5ers account.",
  );
  const read = perAccount[resource]!;
  if (resource === "fills" || resource === "position") {
    requireValue(
      positionKey && /^[a-f0-9-]{36}$/.test(positionKey),
      "Choose a position from the latest snapshot.",
    );
    const saved = await getSetting(`${REF_PREFIX}${id}`);
    let cache = saved ? decryptJson<PositionRefs>(saved) : undefined;
    const refreshReferences = async () => {
      const stored = await getSetting(`${SNAPSHOT_PREFIX}${id}`);
      requireValue(stored, "No saved position history exists for this account.");
      const snapshot = JSON.parse(stored) as SourceSnapshot;
      const rows = sourceFields(snapshot.sections.positions?.data).rows;
      requireValue(Array.isArray(rows), "Saved position history is unavailable.");
      const target = rows.find((row) => sourceFields(row).key === positionKey);
      requireValue(target, "This position is no longer in the saved history. Reload the account.");
      const source = sourceFields(target).source;
      requireValue(
        normalizePosition(source),
        "This position has no verified identity for a detail refresh.",
      );
      const account = (await inventoryResult(client)).accounts.find((account) => account.id === id);
      requireValue(account, "This The5ers account is no longer available.");
      const fresh = await positions(client, account, snapshotCurrency(snapshot));
      const stableKey = detailPositionKey(id, source);
      requireValue(
        fresh.rows.filter((row) => detailPositionKey(id, row.source) === stableKey).length === 1,
        "These positions have identical entry facts and no stable ticket. Their saved source records remain available, but details cannot be matched safely.",
      );
      requireValue(
        Object.hasOwn(fresh.refs, stableKey),
        "The5ers no longer provides details for this position. Saved journal history remains available.",
      );
      cache = {
        connectionId: connection.id,
        accountId: id,
        expiresAt: Date.now() + 10 * 60_000,
        refs: { ...fresh.refs, [positionKey]: fresh.refs[stableKey]! },
      };
      requireValue(
        Buffer.byteLength(JSON.stringify(cache)) <= 2 * 1024 * 1024,
        "The5ers position reference cache exceeded its size limit.",
      );
      await db.transaction(async (tx) => {
        await assertConnection(connection.id, tx);
        await setSetting(`${REF_PREFIX}${id}`, encryptJson(cache), tx);
      });
    };
    if (
      !cache ||
      cache.connectionId !== connection.id ||
      cache.accountId !== id ||
      cache.expiresAt <= Date.now() ||
      !Object.hasOwn(cache.refs, positionKey)
    )
      await refreshReferences();
    const readDetails = async () => {
      requireValue(cache, "Position references could not be refreshed.");
      return publicData(
        await client.read(read.tool, read.operation, { position_ref: cache.refs[positionKey] }),
      );
    };
    try {
      return await readDetails();
    } catch (error) {
      if (
        !(error instanceof RequestError) ||
        error.message !==
          "The5ers could not provide this section. Check access and data availability."
      )
        throw error;
      await refreshReferences();
      return readDetails();
    }
  }
  const account = (await inventoryResult(client)).accounts.find((a) => a.id === id);
  requireValue(account, "This The5ers account is no longer available.");
  if (resource === "payoutHistory") return fetchAndSavePayouts(client, connection.id, account, id!);
  return publicData(await client.read(read.tool, read.operation, { account_ref: account.ref }));
}
export async function syncScheduledThe5ers(
  deadline = Date.now() + 240_000,
  preloadedAccounts?: ProviderAccount[],
) {
  const candidates = (await selectedAccounts()).filter((account) => account.autoSync);
  const native = candidates.some((a) => a.journalAccountId)
    ? await db
        .select({ id: journalAccounts.id, archivedAt: journalAccounts.archivedAt })
        .from(journalAccounts)
    : [];
  const eligible = candidates.filter(
    (a) => !a.journalAccountId || native.some((n) => n.id === a.journalAccountId && !n.archivedAt),
  );

  if (Date.now() >= deadline)
    return { checked: eligible.length, synced: 0, failed: eligible.length };
  let available: ProviderAccount[];
  if (preloadedAccounts && preloadedAccounts.length > 0) {
    available = preloadedAccounts;
  } else {
    try {
      const { client } = await sourceClient(
        AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      );
      available = (await inventoryResult(client)).accounts;
    } catch (error) {
      console.error("[cron] The5ers inventory unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return { checked: eligible.length, synced: 0, failed: eligible.length };
    }
  }
  const accountMap = new Map(available.map((a) => [a.id, a]));
  const activeIds = new Set(available.filter((a) => isActiveSource(a.status)).map((a) => a.id));
  const selected = eligible.filter((a) => activeIds.has(a.id));
  let synced = 0,
    skipped = 0,
    failed = 0;
  for (const account of selected) {
    if (Date.now() >= deadline) {
      failed += selected.length - (synced + skipped + failed);
      break;
    }
    try {
      requireValue(Date.now() < deadline, "The5ers scheduled sync time budget was exhausted.");
      await syncSourceAccount(
        account.id,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        true,
        accountMap.get(account.id),
      );
      synced++;
    } catch (error) {
      if (error instanceof InactiveSource) {
        skipped++;
        continue;
      }
      failed++;
      console.error("[cron] The5ers source sync failed", {
        accountId: account.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  let purchases: { synced: boolean; pending?: number } | undefined;
  if (Date.now() < deadline) {
    try {
      const outcome = await syncSourceCash(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      purchases = { synced: outcome.complete, pending: outcome.purchases.pending };
    } catch (error) {
      purchases = { synced: false };
      console.error("[cron] The5ers purchases unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return {
    checked: selected.length - skipped,
    synced,
    failed,
    ...(purchases ? { purchases } : {}),
  };
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
  let bytes = 0,
    count = 0;
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
      (collection === "payouts" ? body.withdrawals : undefined) ??
      body.items ??
      body.notifications ??
      body.history ??
      (Array.isArray(result.data) ? result.data : undefined);
    requireValue(
      Array.isArray(values) && values.length <= 1000,
      "The5ers returned an unsupported paginated source format.",
    );
    const safe = publicData(result);
    const fingerprint = JSON.stringify(publicData(values));
    if (seen.has(fingerprint) || (pagination.has_more && !values.length))
      return {
        pages,
        complete: false,
        warning: "The5ers repeated or omitted a page. Showing available records.",
      };
    count += values.length;
    if (count > 1000)
      return { pages, complete: false, warning: "Source history reached its record limit." };
    seen.add(fingerprint);
    bytes += Buffer.byteLength(JSON.stringify(safe));
    requireValue(bytes <= 4 * 1024 * 1024, "The5ers source exceeded its size limit.");
    pages.push(safe);
    if (!pagination.has_more)
      return {
        pages,
        complete: collection !== "payouts" || record(body.coverage ?? {}).complete === true,
      };
  }
  return {
    pages,
    complete: false,
    warning: "Source history reached its page limit; additional records may exist.",
  };
}

/** Import verified order cash into the existing audited ledger and retain a source history. */
export async function syncSourcePurchases(signal?: AbortSignal) {
  const { connection, client } = await sourceClient(signal);
  const history = await paginatedSource(client, "purchase", "list", "purchases");
  const values = sourceRecords(history, "purchases");
  return db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    // Serialize source imports so concurrent refresh/cron cannot duplicate ledger writes.
    await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
    const result = await reconcilePurchases(
      tx,
      values,
      (await getSetting("timeZone", tx)) ?? "UTC",
    );
    await setSetting(
      "the5ers:purchases",
      JSON.stringify({ ...history, ...result, retrievedAt: new Date().toISOString() }),
      tx,
    );
    return { ...history, ...result };
  });
}

/** Cash covers the entire provider inventory, independently of trade selection. */
export async function syncSourceCash(signal?: AbortSignal, batch = false) {
  const { connection, client } = await sourceClient(signal);
  const inventory = await inventoryResult(client);
  const failures: { id: string; label: string }[] = [];
  let synced = 0;
  const previous = JSON.parse((await getSetting("the5ers:cash")) ?? "{}");
  // An unfinished cash run keeps its successful coverage even after 15 minutes.
  const previousCoverage = Date.parse(previous.coverageSince ?? previous.retrievedAt);
  const coverageSince =
    batch && previous.remaining > 0 && Number.isFinite(previousCoverage)
      ? previousCoverage - (previous.coverageSince ? 0 : 15 * 60_000)
      : Date.now() - 15 * 60_000;
  const failed = new Set((previous.failures ?? []).map((a: { id: string }) => a.id));
  const cached = await db.select().from(settings).where(like(settings.key, "the5ers:payouts:%"));
  const fresh = new Set(
    cached
      .filter((row) => {
        const history = JSON.parse(row.value);
        return (
          batch && history.importerVersion === 4 && Date.parse(history.retrievedAt) >= coverageSince
        );
      })
      .map((row) => row.key.slice("the5ers:payouts:".length)),
  );

  // Historical funded accounts must not wait behind dozens of evaluations.
  // Bound concurrency to avoid exhausting the shared MCP request deadline.
  const waiting = inventory.accounts.filter((account) => !fresh.has(account.id));
  const queue = [...waiting].sort(
    (a, b) =>
      Number(failed.has(a.id)) - Number(failed.has(b.id)) ||
      Number(sourceProgram(b.program) === "funded") - Number(sourceProgram(a.program) === "funded"),
  );
  if (batch) queue.splice(12);
  const attempted = queue.length;
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const account = queue.shift();
        if (!account) return;
        try {
          signal?.throwIfAborted();
          await fetchAndSavePayouts(client, connection.id, account, account.id);
          synced++;
        } catch {
          failures.push({ id: account.id, label: account.label });
        }
      }
    }),
  );
  const remaining = waiting.length - attempted + failures.length;
  let purchases: { pending?: number; synced: boolean };
  try {
    purchases =
      !batch || remaining === 0
        ? { ...(await syncSourcePurchases(signal)), synced: true }
        : { synced: false };
  } catch {
    purchases = { synced: false };
  }
  const inventoryIds = new Set(inventory.accounts.map((a) => a.id));
  const histories = await db.select().from(settings).where(like(settings.key, "the5ers:payouts:%"));
  const payoutSummary = {
    found: 0,
    paid: 0,
    recorded: 0,
    missingSettlement: 0,
    blocked: {} as Record<string, number>,
  };
  for (const history of histories) {
    if (!inventoryIds.has(history.key.slice("the5ers:payouts:".length))) continue;
    const saved = JSON.parse(history.value);
    for (const row of saved.rows ?? []) {
      payoutSummary.found++;
      const isPaid = ["paid", "completed", "received", "settled"].includes(
        String(sourceFields(row.source).status).trim().toLowerCase(),
      );
      if (isPaid) payoutSummary.paid++;
      if (["imported", "matched"].includes(row.status)) payoutSummary.recorded++;
      else if (isPaid) {
        payoutSummary.missingSettlement++;
        const reason = row.pendingReason ?? "unresolved";
        payoutSummary.blocked[reason] = (payoutSummary.blocked[reason] ?? 0) + 1;
      }
    }
  }
  const outcome = {
    coverageSince: new Date(coverageSince).toISOString(),
    payouts: payoutSummary,
    expensesComplete: purchases.synced,
    accounts: inventory.accounts.map(({ ref: _ref, ...account }) => account),
    complete:
      inventory.complete && !remaining && purchases.synced && !payoutSummary.missingSettlement,
    remaining,
    checked: fresh.size + synced,
    total: inventory.accounts.length,
    warnings: inventory.warnings,
    failures,
    synced,
    retrievedAt: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    await setSetting("the5ers:cash", JSON.stringify(outcome), tx);
  });
  return { ...outcome, purchases };
}

async function fetchAndSavePayouts(
  client: The5ersMcp,
  connectionId: string,
  account: ProviderAccount,
  id: string,
) {
  const history = await paginatedSource(client, "payout", "history", "payouts", {
    account_ref: account.ref,
  });
  // The real contract puts currency on the envelope, not each history row.
  const sources = history.pages.flatMap((page) => {
    const envelope = sourceFields(page);
    const currency = sourceCurrency(envelope.currency);
    return sourceRecords({ pages: [page] }, "payouts").map((source) => ({
      ...record(source),
      ...(currency ? { currency } : {}),
    }));
  });
  let payoutExplanation: unknown;
  // History's amount does not identify the trader's net receipt. Explain supplies
  // finalAmount for the latest payout only; never apply its split to older rows.
  if (
    sources.some((source) =>
      ["paid", "completed", "received", "settled"].includes(
        String(sourceFields(source).status).toLowerCase(),
      ),
    )
  ) {
    try {
      payoutExplanation = await client.read("payout", "explain", { account_ref: account.ref });
      const explanation = sourceFields(payoutExplanation);
      const body = sourceFields(explanation.data);
      const latest = sourceFields(body.latestpayout);
      const breakdown = sourceFields(latest.breakdown);
      const currency = sourceCurrency(explanation.currency);
      const requested = sourceInstant(latest.requestedat);
      const matches = sources.filter((source) => {
        const row = sourceFields(source);
        return (
          requested &&
          sourceInstant(row.requestedat) === requested &&
          row.amount === latest.amount &&
          row.currency === currency
        );
      });
      const completedAt = latest.completedat ?? sourceFields(matches[0]).completedat;
      if (
        body.subject === "latest_payout" &&
        sourceInstant(completedAt) &&
        ["paid", "completed", "received", "settled"].includes(
          String(latest.status).toLowerCase(),
        ) &&
        matches.length === 1 &&
        typeof breakdown.finalamount === "number"
      ) {
        const userShare = sourceNumber(breakdown.usershare);
        const commission = sourceNumber(breakdown.commission ?? breakdown.fee);
        const grossAmount = sourceNumber(latest.amount);
        let splitPercent: number | undefined;
        if (typeof breakdown.profitsplit === "number") {
          splitPercent = breakdown.profitsplit;
        } else if (userShare && grossAmount && grossAmount > 0) {
          splitPercent = Math.round((userShare / grossAmount) * 10000) / 100;
        }
        Object.assign(matches[0]!, {
          netAmount: breakdown.finalamount,
          completedAt,
          grossAmount,
          userShare,
          fee: commission,
          splitPercent,
        });
      }
    } catch {
      // Retain fetched history; a missing breakdown must never become guessed cash.
    }
  }
  // The journal owner has confirmed that The5ers Paid records represent money received.
  for (const source of sources) {
    const row = sourceFields(source);
    if (
      ["paid", "completed", "received", "settled"].includes(String(row.status).trim().toLowerCase())
    ) {
      Object.assign(source, { ownerConfirmedPaid: true });
      if (
        row.netamount == null &&
        row.paidamount == null &&
        row.receivedamount == null &&
        row.netpaid == null
      ) {
        Object.assign(source, { netAmount: row.amount });
      }
    }
  }
  const rows = sources.map((source) => ({ key: payoutKey(id, source), source }));
  requireValue(
    new Set(rows.map((row) => row.key)).size === rows.length,
    "The5ers payout identities are ambiguous. Previous cash records were retained.",
  );
  return db.transaction(async (tx) => {
    await assertConnection(connectionId, tx);
    // Serialize linking and receipt imports against selection changes and concurrent refreshes.
    await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
    const { ref: _ref, ...sourceAccount } = account;
    const currency = sourceCurrency(account.currency) ? account.currency! : undefined;
    const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
      string,
      string
    >;
    const program = sourceProgram(account.program);
    if (
      rows.length &&
      currency &&
      program &&
      ["funded", "instant_funded", "live"].includes(program) &&
      sourcePropStatus(account.status)
    ) {
      // Cash belongs to a prop funding phase, even when no trading account was selected.
      const journalAccountId = links[id] ?? null;
      if (journalAccountId) {
        const [native] = await tx
          .select()
          .from(journalAccounts)
          .where(eq(journalAccounts.id, journalAccountId));
        requireValue(
          native && native.currency === currency,
          "The linked journal account has a conflicting currency.",
        );
      }
      await saveSnapshotPropAccount(
        tx,
        {
          account: sourceAccount,
          retrievedAt: new Date().toISOString(),
          complete: false,
          sections: {},
          warnings: [],
          importedExecutions: 0,
        },
        journalAccountId,
        currency,
      );
    }
    let imported = 0,
      matched = 0,
      pending = 0;
    const results = [];
    for (const row of rows) {
      let pendingReason: string | undefined;
      const status = await recordPayoutReceipt(tx, id, row.source, undefined, (reason) => {
        pendingReason = reason;
      });
      if (status === "imported") imported++;
      else if (status === "matched") matched++;
      else pending++;
      results.push({ ...row, status, pendingReason });
    }
    const saved = {
      ...history,
      importerVersion: 4,
      explanation: payoutExplanation ? publicData(payoutExplanation) : undefined,
      account: sourceAccount,
      rows: results,
      imported,
      matched,
      pending,
      retrievedAt: new Date().toISOString(),
    };
    await setSetting(`the5ers:payouts:${id}`, JSON.stringify(saved), tx);
    return saved;
  });
}

export async function confirmSourcePayout(
  id: string,
  key: string,
  confirmation: { accountId: string; amount: string; receivedOn: string },
) {
  const connection = await accessConnection();
  return db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
    const saved = await getSetting(`the5ers:payouts:${id}`, tx);
    requireValue(saved, "Load payout history before recording a receipt.");
    const history = JSON.parse(saved) as {
      rows: { key: string; source: unknown; status: string }[];
      pending: number;
      imported: number;
      matched: number;
    };
    const row = history.rows.find((row) => row.key === key);
    requireValue(row, "Choose a payout from the saved history.");
    const status = await recordPayoutReceipt(tx, id, row.source, confirmation);
    if (row.status === "pending") {
      history.pending--;
      if (status === "imported") history.imported++;
      else history.matched++;
    }
    row.status = status;
    await setSetting(`the5ers:payouts:${id}`, JSON.stringify(history), tx);
    return { status };
  });
}

/** Ensure every account in The5ers inventory is registered in journalAccounts, the5ers:journal-links, and the5ers:selection */
export async function ensureAllInventoryAccountsSaved(signal?: AbortSignal) {
  const { connection, client } = await sourceClient(signal);
  const inventory = await inventoryResult(client);
  await db.transaction(async (tx) => {
    await assertConnection(connection.id, tx);
    await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
    const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
      string,
      string
    >;
    const selection = JSON.parse((await getSetting(SELECTION_KEY, tx)) ?? "[]") as Selection[];
    const selectionMap = new Map(selection.map((s) => [s.id, s]));
    const now = new Date().toISOString();

    for (const account of inventory.accounts) {
      const journalAccountId = links[account.id] ?? `the5ers_${account.id}`;
      links[account.id] = journalAccountId;
      const currency = sourceCurrency(account.currency) ? account.currency! : "USD";
      const name = the5ersDefaultName(account);

      await tx
        .insert(journalAccounts)
        .values({
          id: journalAccountId,
          name,
          broker: "The5ers",
          kind: "import",
          currency,
          initialBalance: 0,
          autoSync: false,
          createdAt: now,
        })
        .onConflictDoNothing();

      if (!selectionMap.has(account.id)) {
        selectionMap.set(account.id, {
          id: account.id,
          label: account.label,
          autoSync: isActiveSource(account.status),
          journalAccountId,
        });
      }

      const program = sourceProgram(account.program);
      const status = sourcePropStatus(account.status);
      if (program && status) {
        await tx
          .insert(propAccounts)
          .values({
            id: `the5ers_${account.id}`,
            firm: "The5ers",
            name,
            program,
            status,
            currency,
            journalAccountId,
            openedOn: account.createdAt ? account.createdAt.slice(0, 10) : now.slice(0, 10),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }
    }

    await setSetting("the5ers:journal-links", JSON.stringify(links), tx);
    await setSetting(SELECTION_KEY, JSON.stringify([...selectionMap.values()]), tx);
  });
  return { accountsCount: inventory.accounts.length, accounts: inventory.accounts };
}

/** Complete 1-click sync of all The5ers MCP data into the database */
export async function syncAllSourceToDatabase(signal?: AbortSignal) {
  // 1. Ensure all accounts in inventory exist in DB
  await ensureAllInventoryAccountsSaved(signal);

  // 2. Sync purchases / expenses
  let purchasesResult = null;
  try {
    purchasesResult = await syncSourcePurchases(signal);
  } catch (err) {
    console.error("The5ers purchases sync error during full sync:", err);
  }

  // 3. Sync cash / payouts
  let cashResult = null;
  try {
    cashResult = await syncSourceCash(signal, false);
  } catch (err) {
    console.error("The5ers cash sync error during full sync:", err);
  }

  // 4. Sync modules & positions
  const moduleResult = await syncAllSourceModules(signal);

  return {
    success: true,
    modules: moduleResult,
    cash: cashResult,
    purchases: purchasesResult,
  };
}

/** Archive every supported read module, and project available positions into the existing journal. */
export async function syncAllSourceModules(signal?: AbortSignal) {
  const { connection, client } = await sourceClient(signal);
  const inventory = await inventoryResult(client);
  const result = await syncModuleArchive(
    client,
    connection.id,
    inventory.accounts,
    6,
    async (page) => {
      if (page.tool !== "positions" || page.operation !== "list") return;
      const account = inventory.accounts.find((account) => account.id === page.subject);
      if (!account) return;
      const archive = await readArchivedModule("positions", "list", account.id, account.id);
      const pages = archive.pages.filter((saved: { runId?: string }) => saved.runId === page.runId);
      const rows = sourceRecords(
        { pages: pages.map((saved: { data: unknown }) => saved.data) },
        "positions",
      );
      if (!rows.some((row) => normalizePosition(row))) return;
      const currencies = new Set(
        pages
          .map(
            (saved: { data: unknown }) =>
              sourceCurrency(sourceFields(saved.data).currency) ?? sourceCurrency(account.currency),
          )
          .filter(Boolean),
      );
      if (currencies.size !== 1) return;
      const currency = [...currencies][0] as string;
      await db.transaction(async (tx) => {
        await assertConnection(connection.id, tx);
        await tx.select().from(settings).where(eq(settings.key, CONNECTION_KEY)).for("update");
        const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
          string,
          string
        >;
        const journalAccountId = links[account.id] ?? `the5ers_${account.id}`;
        await tx
          .insert(journalAccounts)
          .values({
            id: journalAccountId,
            name: the5ersDefaultName(account),
            broker: "The5ers",
            kind: "import",
            currency,
            initialBalance: 0,
            autoSync: false,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing();
        const [native] = await tx
          .select()
          .from(journalAccounts)
          .where(eq(journalAccounts.id, journalAccountId));
        requireValue(
          native &&
            native.currency === currency &&
            (links[account.id] || native.broker === "The5ers"),
          "The archived position account conflicts with an existing journal account.",
        );
        links[account.id] = journalAccountId;
        await setSetting("the5ers:journal-links", JSON.stringify(links), tx);
        const last = pages.at(-1);
        const complete =
          pages.length === last?.page &&
          sourceFields(sourceFields(last?.data).pagination).hasmore === false;
        await saveJournalPositions(
          tx,
          account.id,
          currency,
          new Date().toISOString(),
          rows,
          complete,
        );
        const { ref: _ref, ...publicAccount } = account;
        await saveSnapshotPropAccount(
          tx,
          {
            account: publicAccount,
            retrievedAt: new Date().toISOString(),
            complete,
            sections: {},
            warnings: [],
            importedExecutions: 0,
          },
          journalAccountId,
          currency,
        );
      });
    },
  );
  if (result.complete) {
    await db.transaction(async (tx) => {
      await assertConnection(connection.id, tx);
      const tracked = await tx.select().from(propAccounts).where(eq(propAccounts.firm, "The5ers"));
      for (const account of inventory.accounts) {
        const native = tracked.find((row) => row.id === `the5ers_${account.id}`);
        if (!native) continue;
        await saveSnapshotPropAccount(
          tx,
          {
            account,
            retrievedAt: new Date().toISOString(),
            complete: false,
            sections: {},
            warnings: [],
            importedExecutions: 0,
          },
          native.journalAccountId,
          native.currency,
        );
      }
    });
  }
  if (!inventory.complete) {
    result.complete = false;
    result.inventoryWarnings = inventory.warnings;
    await db.transaction(async (tx) => {
      await assertConnection(connection.id, tx);
      await setSetting("the5ers:module-sync", JSON.stringify(result), tx);
    });
  }
  return result;
}
