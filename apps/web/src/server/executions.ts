import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { positionFillProblem, type ImportedExecution } from "@luxalgo/journal-importers";
import { db, executions, accounts, trades } from "@/db";
import type { JournalExecutor } from "@/db/postgres";
import { executionHash, newId, nowIso } from "./ids";
import { rebuildAccountInTransaction } from "./rebuild";
import { getJournalDefaults } from "./settings";
import { defaultFee } from "@/lib/journal-defaults";
import { requireValue } from "./api";
import { positionImportErrors } from "./position-import";

export interface InsertResult {
  inserted: number;
  duplicates: number;
  /** Rows dropped because a broker or file record was unusable (sync/import only). */
  skipped: number;
  /** A few plain-language reasons for skipped rows, capped so payloads stay small. */
  skippedReasons: string[];
}

export type ExecutionSource = "sync" | "import" | "manual";

const MAX_SKIP_REASONS = 5;

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Plain-language reason a row can't be journaled, or null when the row is valid. */
export const executionProblem = (row: unknown, source: ExecutionSource): string | null => {
  if (!row || typeof row !== "object") return "Execution is missing.";
  const r = row as Partial<ImportedExecution>;
  const label = typeof r.symbol === "string" && r.symbol.trim() ? r.symbol.trim() : "execution";
  if (typeof r.symbol !== "string" || !r.symbol.trim()) return "An execution has no symbol.";
  if (!["buy", "sell"].includes(r.side as string)) return `${label}: side must be buy or sell.`;
  if (!isFiniteNumber(r.quantity) || r.quantity <= 0)
    return `${label}: quantity must be a finite positive number.`;
  if (!isFiniteNumber(r.price)) return `${label}: price must be a finite number.`;
  if (!isFiniteNumber(r.fee ?? 0)) return `${label}: fee must be a finite number.`;
  if (typeof r.executedAt !== "string" || !Number.isFinite(Date.parse(r.executedAt)))
    return `${label}: timestamp is missing or invalid.`;
  const meta = r.importMetadata;
  const metaOk =
    !meta ||
    (source === "import" &&
      typeof meta.id === "string" &&
      meta.id.length > 0 &&
      meta.id.length <= 2000 &&
      (meta.group === undefined ||
        (typeof meta.group === "string" && meta.group.length > 0 && meta.group.length <= 2000)) &&
      Number.isSafeInteger(meta.order) &&
      meta.order >= 0 &&
      (meta.reportedGrossPnl === undefined || Number.isFinite(meta.reportedGrossPnl)) &&
      (meta.preserveFee === undefined || typeof meta.preserveFee === "boolean"));
  if (!metaOk) return `${label}: invalid imported execution metadata.`;
  const positionProblem = positionFillProblem(r as ImportedExecution);
  if (positionProblem) return positionProblem;
  return null;
};

/**
 * Split a batch into usable rows and skip reasons. Manual entry is strict: the
 * whole batch is rejected on the first bad row. Broker syncs and file imports
 * are lenient: one odd record must not fail the entire batch, so bad rows are
 * dropped and counted for the caller to report. Position-labelled histories are
 * atomic: dropping a bad fill could change which position the remaining fills close.
 */
export const partitionExecutions = (
  rows: ImportedExecution[],
  source: ExecutionSource,
): { usable: ImportedExecution[]; skipped: number; skippedReasons: string[] } => {
  const usable: ImportedExecution[] = [];
  const skippedReasons: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    const problem = executionProblem(row, source);
    if (
      problem &&
      (row?.importMetadata?.position ||
        (typeof row?.importMetadata?.group === "string" &&
          row.importMetadata.group.startsWith("csv-position:")))
    )
      requireValue(false, problem);
    if (problem === null) {
      usable.push(row);
      continue;
    }
    if (source === "manual") {
      requireValue(
        false,
        "Every execution needs a symbol, buy/sell side, finite positive quantity, price, fee and valid timestamp.",
      );
    }
    skipped++;
    if (skippedReasons.length < MAX_SKIP_REASONS) skippedReasons.push(problem);
  }
  return { usable, skipped, skippedReasons };
};

/** Insert fills, rebuild trades, and attach optional manual notes in one transaction. */
export const insertExecutionsInTransaction = async (
  tx: JournalExecutor,
  accountId: string,
  rows: ImportedExecution[],
  source: ExecutionSource,
  manualNotes?: string,
  options: { preserveFees?: boolean } = {},
): Promise<InsertResult> => {
  requireValue(
    manualNotes === undefined ||
      (source === "manual" && typeof manualNotes === "string" && manualNotes.length <= 100000),
    "Manual trade notes must be at most 100,000 characters.",
  );
  const [account] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update");
  requireValue(account, "Account not found.");
  const { usable, skipped, skippedReasons } = partitionExecutions(rows, source);
  requireValue(
    !usable.some((row) => row.ninjaTrader || row.importMetadata?.group?.startsWith("ninjatrader")),
    "NinjaTrader fills require the reviewed import endpoint.",
  );
  let inserted = 0;
  let duplicates = 0;
  let corrected = false;
  const createdAt = nowIso();
  const defaults = await getJournalDefaults(tx);
  const note = manualNotes?.trim() ? manualNotes : undefined;

  const positionErrors = await positionImportErrors(accountId, usable, tx);
  requireValue(positionErrors.length === 0, positionErrors.join(" "));
  if (source === "import") {
    const existingHashes = new Set(
      (
        await tx
          .select({ hash: executions.contentHash })
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.source, "import")))
      ).map((row) => row.hash),
    );
    for (const row of usable) {
      if (existingHashes.has(executionHash(row))) continue;
      const candidates = [row.legacyExecutedAt, row.executedAt.replace(/\.\d{3}Z$/, ".000Z")];
      requireValue(
        !candidates.some(
          (executedAt) =>
            executedAt &&
            executedAt !== row.executedAt &&
            existingHashes.has(executionHash({ ...row, executedAt })),
        ),
        "Matching imported fills have timestamps from an older parser or indistinguishable whole-second executions. Import the complete corrected history into a new journal account and compare it before retiring the old account; nothing was saved.",
      );
    }
  }
  const noteExecutionIds = new Set<string>();
  // A snapshot can contain several independent fills with identical economics.
  // Match their multiplicity, including legacy hashes, rather than collapsing them.
  const syncIdentity = (row: {
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    executedAt: string;
  }) => JSON.stringify([row.symbol, row.side, row.quantity, row.price, Date.parse(row.executedAt)]);
  const savedSync = new Map<string, (typeof executions.$inferSelect)[]>();
  const incomingCounts = new Map<string, number>();
  const reportedCounts = new Map<string, number>();
  const occurrences = new Map<string, number>();
  if (source === "sync") {
    for (const saved of await tx
      .select()
      .from(executions)
      .where(and(eq(executions.accountId, accountId), eq(executions.source, "sync")))) {
      const key = syncIdentity(saved),
        group = savedSync.get(key) ?? [];
      group.push(saved);
      savedSync.set(key, group);
    }
    for (const group of savedSync.values())
      group.sort((a, b) => a.fee - b.fee || a.id.localeCompare(b.id));
    for (const row of usable) {
      const key = syncIdentity(row);
      incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1);
      if (row.feeReported !== false) reportedCounts.set(key, (reportedCounts.get(key) ?? 0) + 1);
    }
  }
  for (const row of source === "sync" ? [...usable].sort((a, b) => a.fee - b.fee) : usable) {
    const id = newId();
    let contentHash = executionHash(row);
    if (source === "sync") {
      const key = syncIdentity(row),
        occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const saved = savedSync.get(key) ?? [];
      if (saved[occurrence]) {
        duplicates++;
        // Correct fees only when the window contains the entire matching group.
        if (
          incomingCounts.get(key)! >= saved.length &&
          reportedCounts.get(key) === incomingCounts.get(key) &&
          saved[occurrence]!.fee !== row.fee
        ) {
          await tx
            .update(executions)
            .set({ fee: row.fee })
            .where(eq(executions.id, saved[occurrence]!.id));
          corrected = true;
        }
        continue;
      }
      contentHash = createHash("sha256")
        .update(JSON.stringify(["sync-v2", key, occurrence]))
        .digest("hex")
        .slice(0, 32);
    }
    const result = await tx
      .insert(executions)
      .values({
        id,
        accountId,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        price: row.price,
        fee:
          source === "sync" || row.importMetadata?.preserveFee || options.preserveFees
            ? row.fee
            : defaultFee(row.fee, row.quantity, accountId, row.symbol, defaults),
        executedAt: row.executedAt,
        assetClass: row.assetClass ?? null,
        source,
        importMetadataJson: row.importMetadata ? JSON.stringify(row.importMetadata) : null,
        contentHash,
        createdAt,
      })
      .onConflictDoNothing({ target: [executions.accountId, executions.contentHash] })
      .returning({ id: executions.id });
    if (result.length > 0) {
      inserted++;
      if (note) noteExecutionIds.add(id);
    } else {
      duplicates++;
      if (note) {
        const [existing] = await tx
          .select({ id: executions.id })
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.contentHash, contentHash)))
          .limit(1);
        if (existing) noteExecutionIds.add(existing.id);
      }
    }
  }
  if (inserted > 0 || corrected) await rebuildAccountInTransaction(accountId, tx);
  if (note) {
    const affected = await tx
      .select({
        key: trades.key,
        notes: trades.notes,
        executionIdsJson: trades.executionIdsJson,
      })
      .from(trades)
      .where(eq(trades.accountId, accountId));
    for (const trade of affected) {
      const ids = JSON.parse(trade.executionIdsJson) as string[];
      if (!ids.some((id) => noteExecutionIds.has(id))) continue;
      // Keep prior annotations when these fills extend or close an existing position.
      // Retrying the same submission must not append the note a second time.
      if (trade.notes === note || trade.notes?.endsWith(`\n\n${note}`)) continue;
      const notes = trade.notes?.trim() ? `${trade.notes}\n\n${note}` : note;
      requireValue(
        notes.length <= 100000,
        "Combined trade notes must be at most 100,000 characters.",
      );
      await tx.update(trades).set({ notes }).where(eq(trades.key, trade.key));
    }
  }
  return { inserted, duplicates, skipped, skippedReasons };
};

export const insertExecutions = async (
  accountId: string,
  rows: ImportedExecution[],
  source: ExecutionSource,
  manualNotes?: string,
  options: { preserveFees?: boolean } = {},
): Promise<InsertResult> =>
  db.transaction(async (tx) =>
    insertExecutionsInTransaction(tx, accountId, rows, source, manualNotes, options),
  );

export const deleteExecutionsForTrades = async (
  accountId: string,
  executionIds: string[],
): Promise<void> => {
  if (executionIds.length === 0) return;
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
    requireValue(account, "Account not found.");
    await tx
      .delete(executions)
      .where(and(eq(executions.accountId, accountId), inArray(executions.id, executionIds)));
    await rebuildAccountInTransaction(accountId, tx);
  });
};

export const listExecutions = async (accountId: string, ids?: string[]) => {
  if (ids && ids.length > 0) {
    return db
      .select()
      .from(executions)
      .where(and(eq(executions.accountId, accountId), inArray(executions.id, ids)));
  }
  return db.select().from(executions).where(eq(executions.accountId, accountId));
};
