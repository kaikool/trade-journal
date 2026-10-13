import { createHash } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { accounts, db, propEntries, settings, trades } from "@/db";
import type { JournalExecutor } from "@/db/postgres";
import type { TradeRow } from "@/server/trades-query";
import { getSetting, setSetting } from "@/server/settings";
import { requireValue } from "@/server/api";
import { mutatePropInTransaction } from "@/server/prop-firms";
import { fromMinor } from "@/lib/prop-firms";
import { dayKeyOf } from "@luxalgo/journal-core";
import {
  normalizePosition,
  normalizePurchase,
  sourceObject,
  type SourcePosition,
} from "@/lib/the5ers-normalize";

export const JOURNAL_SOURCE_PREFIX = "the5ers:journal:";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const positionIdentity = (position: SourcePosition) =>
  position.identityDiscriminator
    ? hash([position.symbol, position.direction, position.openedAt, position.identityDiscriminator])
    : hash([position.symbol, position.direction, position.openedAt]);
interface JournalSource {
  sourceAccountId: string;
  currency: string;
  retrievedAt: string;
  complete: boolean;
  positions: SourcePosition[];
}
export type SourceTradeRow = TradeRow & {
  source?: "the5ers";
  costsUnavailable?: boolean;
  quantityUnitsUnknown?: boolean;
  reportedFee?: number;
  reportedSwap?: number;
  programValid?: boolean;
};

function journalTradeRow(
  sourceAccountId: string,
  accountId: string,
  position: SourcePosition,
  annotation: Record<string, unknown> = {},
): SourceTradeRow {
  const key = `the5ers_${hash([sourceAccountId, positionIdentity(position)])}`;
  const closed = Boolean(position.closedAt);
  return {
    key,
    accountId,
    symbol: position.symbol,
    assetClass: null,
    direction: position.direction,
    status: closed
      ? position.netPnl > 0
        ? "win"
        : position.netPnl < 0
          ? "loss"
          : "breakeven"
      : "open",
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    quantity: position.quantity,
    openQuantity: closed ? 0 : position.quantity,
    avgEntry: position.entry,
    avgExit: position.exit,
    // Provider net already includes signed swap and commission. Reverse costs for gross only.
    grossPnl:
      position.netPnl +
      (position.fee !== undefined && position.swap !== undefined
        ? Math.abs(position.fee) - position.swap
        : 0),
    fees:
      position.fee !== undefined && position.swap !== undefined
        ? Math.abs(position.fee) - position.swap
        : 0,
    netPnl: position.netPnl,
    executionCount: 0,
    executionIdsJson: "[]",
    exitsJson: "[]",
    durationMs: position.closedAt
      ? Date.parse(position.closedAt) - Date.parse(position.openedAt)
      : null,
    notes: typeof annotation.notes === "string" ? annotation.notes : null,
    tagsJson: JSON.stringify(annotation.tags ?? []),
    mistakesJson: JSON.stringify(annotation.mistakes ?? []),
    playbookId: typeof annotation.playbookId === "string" ? annotation.playbookId : null,
    rating: typeof annotation.rating === "number" ? annotation.rating : null,
    stopLoss: typeof annotation.stopLoss === "number" ? annotation.stopLoss : null,
    profitTarget: typeof annotation.profitTarget === "number" ? annotation.profitTarget : null,
    reviewedAt: typeof annotation.reviewedAt === "string" ? annotation.reviewedAt : null,
    source: "the5ers",
    costsUnavailable: position.fee === undefined || position.swap === undefined,
    quantityUnitsUnknown: true,
    reportedFee: position.fee,
    reportedSwap: position.swap,
    programValid: position.isValid,
  };
}

/** Store reported positions, never manufacture atomic executions or prices from P&L. */
export async function saveJournalPositions(
  tx: JournalExecutor,
  sourceAccountId: string,
  currency: string,
  retrievedAt: string,
  rows: unknown[],
  complete: boolean,
) {
  const parsed = rows.map(normalizePosition);
  const saved = await getSetting(`${JOURNAL_SOURCE_PREFIX}${sourceAccountId}`, tx);
  const previous = saved ? (JSON.parse(saved) as JournalSource) : undefined;
  const candidates = parsed.filter((p): p is SourcePosition => Boolean(p));
  const base = (p: SourcePosition) => hash([p.symbol, p.direction, p.openedAt]);
  const groups = new Map<string, SourcePosition[]>();
  for (const p of candidates) groups.set(base(p), [...(groups.get(base(p)) ?? []), p]);
  const valid: SourcePosition[] = [];
  let ambiguousPositions = 0;
  for (const [key, group] of groups) {
    const earlier = (previous?.positions ?? []).filter((p) => base(p) === key);
    if (
      group.length === 1 &&
      !earlier.some((p) => p.identityDiscriminator) &&
      !(
        group[0]!.providerId &&
        earlier.some((old) => old.providerId && old.providerId !== group[0]!.providerId)
      )
    ) {
      valid.push(group[0]!);
      continue;
    }
    let discriminators = group.map((p) =>
      p.providerId ? `provider:${p.providerId}` : `entry:${hash([p.quantity, p.entry])}`,
    );
    if (
      new Set(discriminators).size !== discriminators.length &&
      group.every((p) => p.closedAt && p.exit !== null)
    ) {
      discriminators = group.map((p) =>
        p.providerId
          ? `provider:${p.providerId}`
          : `closed:${hash([p.quantity, p.entry, p.closedAt, p.exit])}`,
      );
    }
    if (new Set(discriminators).size !== discriminators.length) {
      ambiguousPositions += group.length;
      continue;
    }
    // Migrate only an exactly matching prior position, preserving its annotations and trade key.
    for (let index = 0; index < group.length; index++) {
      const p = group[index]!;
      let matches = earlier.filter((old) =>
        old.providerId && p.providerId
          ? old.providerId === p.providerId
          : old.quantity === p.quantity &&
            old.entry === p.entry &&
            (!old.closedAt || !p.closedAt || (old.closedAt === p.closedAt && old.exit === p.exit)),
      );
      if (matches.length > 1)
        matches = matches.filter((old) => old.closedAt === p.closedAt && old.exit === p.exit);
      p.identityDiscriminator =
        matches.length === 1 ? matches[0]!.identityDiscriminator : discriminators[index];
      valid.push(p);
    }
  }
  const frequencies = new Map<string, number>();
  for (const position of valid) {
    const key = positionIdentity(position);
    frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
  }
  for (let index = valid.length - 1; index >= 0; index--) {
    if ((frequencies.get(positionIdentity(valid[index]!)) ?? 0) > 1) {
      valid.splice(index, 1);
      ambiguousPositions++;
    }
  }
  const accepted = new Set(valid);
  const skippedPositionIndexes = parsed.flatMap((position, index) =>
    position && accepted.has(position) ? [] : [index],
  );
  const identities = valid.map(positionIdentity);
  requireValue(
    !previous || previous.currency === currency,
    "The5ers history currency changed. Review the journal account before syncing.",
  );
  const merged = new Map((previous?.positions ?? []).map((p) => [positionIdentity(p), p]));
  for (const position of valid) {
    const old = merged.get(positionIdentity(position));
    requireValue(
      !old || (old.quantity === position.quantity && old.entry === position.entry),
      "A The5ers position changed its entry or size. Previous journal history was preserved.",
    );
    requireValue(
      !old?.closedAt || Boolean(position.closedAt),
      "A closed The5ers position became open. Previous journal history was preserved.",
    );
    merged.set(positionIdentity(position), position);
  }
  requireValue(merged.size <= 10_000, "The5ers journal history reached its record limit.");
  const history: JournalSource = {
    sourceAccountId,
    currency,
    retrievedAt,
    complete:
      complete &&
      valid.length === rows.length &&
      (previous?.positions.every((p) => identities.includes(positionIdentity(p))) ?? true),
    positions: [...merged.values()],
  };
  requireValue(
    Buffer.byteLength(JSON.stringify(history)) <= 4 * 1024 * 1024,
    "The5ers journal history exceeded its size limit.",
  );
  const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
    string,
    string
  >;
  const accountId = links[sourceAccountId];
  let importedPositions = 0,
    updatedPositions = 0,
    unchangedPositions = 0;
  if (accountId) {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
    requireValue(
      account && account.currency === currency,
      "The linked journal account currency changed.",
    );
    const existing = new Map(
      (await tx.select().from(trades).where(eq(trades.accountId, accountId))).map((row) => [
        row.key,
        row,
      ]),
    );
    // Preserve earlier windows; write only new or changed provider economics, never local annotations.
    for (const position of history.positions) {
      const projected = journalTradeRow(sourceAccountId, accountId, position);
      const {
        source,
        costsUnavailable,
        quantityUnitsUnknown,
        reportedFee,
        reportedSwap,
        programValid,
        notes,
        tagsJson,
        mistakesJson,
        playbookId,
        rating,
        stopLoss,
        profitTarget,
        reviewedAt,
        ...computed
      } = projected;
      const old = existing.get(projected.key);
      if (
        old &&
        Object.entries(computed).every(([field, value]) => old[field as keyof typeof old] === value)
      ) {
        unchangedPositions++;
        continue;
      }
      const annotation = sourceObject(
        JSON.parse((await getSetting(`the5ers:annotation:${projected.key}`, tx)) ?? "{}"),
      );
      if (annotation.excluded === true) continue;
      const annotated = journalTradeRow(sourceAccountId, accountId, position, annotation);
      await tx
        .insert(trades)
        .values({
          ...computed,
          notes: annotated.notes,
          tagsJson: annotated.tagsJson,
          mistakesJson: annotated.mistakesJson,
          playbookId: annotated.playbookId,
          rating: annotated.rating,
          stopLoss: annotated.stopLoss,
          profitTarget: annotated.profitTarget,
          reviewedAt: annotated.reviewedAt,
        })
        .onConflictDoUpdate({ target: trades.key, set: computed });
      if (old) updatedPositions++;
      else importedPositions++;
    }
    await tx.update(accounts).set({ lastSyncAt: retrievedAt }).where(eq(accounts.id, accountId));
  }
  await setSetting(`${JOURNAL_SOURCE_PREFIX}${sourceAccountId}`, JSON.stringify(history), tx);
  return {
    journaledPositions: valid.length,
    skippedPositions: rows.length - valid.length,
    ambiguousPositions,
    skippedPositionIndexes,
    importedPositions,
    updatedPositions,
    unchangedPositions,
  };
}

/** Project into the existing trade reader so all journal filters and net analytics apply. */
export async function sourceJournalData() {
  const [stored, mapping, native, annotations] = await Promise.all([
    db
      .select()
      .from(settings)
      .where(like(settings.key, `${JOURNAL_SOURCE_PREFIX}%`)),
    getSetting("the5ers:journal-links"),
    db.select().from(accounts),
    db.select().from(settings).where(like(settings.key, "the5ers:annotation:%")),
  ]);
  const links = JSON.parse(mapping ?? "{}") as Record<string, string>;
  const annotationMap = new Map(
    annotations.map((row) => [
      row.key.slice("the5ers:annotation:".length),
      sourceObject(JSON.parse(row.value)),
    ]),
  );
  const result: SourceTradeRow[] = [];
  const coverage: {
    accountId: string;
    complete: boolean;
    retrievedAt: string;
    positions: number;
  }[] = [];
  for (const row of stored) {
    const history = JSON.parse(row.value) as JournalSource;
    const accountId = links[history.sourceAccountId];
    if (!accountId || !native.some((a) => a.id === accountId && a.currency === history.currency))
      continue;
    coverage.push({
      accountId,
      complete: history.complete,
      retrievedAt: history.retrievedAt,
      positions: history.positions.length,
    });
    for (const position of history.positions) {
      const key = `the5ers_${hash([history.sourceAccountId, positionIdentity(position)])}`;
      const annotation = annotationMap.get(key) ?? {};
      if (annotation.excluded === true) continue;
      result.push(journalTradeRow(history.sourceAccountId, accountId, position, annotation));
    }
  }
  return { rows: result, coverage };
}
export async function sourceTradeRows(): Promise<SourceTradeRow[]> {
  return (await sourceJournalData()).rows;
}

export async function reconcilePurchases(tx: JournalExecutor, values: unknown[], timeZone: string) {
  const parsed = values.map(normalizePurchase);
  const canonical = parsed.filter((p): p is NonNullable<typeof p> => Boolean(p));
  const identity = (p: (typeof canonical)[number]) => hash([p.placedAt, p.currency, p.name]);
  const ids = canonical.map(identity);
  requireValue(
    new Set(ids).size === ids.length,
    "Some The5ers purchases cannot be distinguished. No duplicate cash entries were created.",
  );
  let imported = 0,
    matched = 0,
    pending = values.length - canonical.length;
  for (const purchase of canonical) {
    if (purchase.status !== "completed" || purchase.refunded || !purchase.cashVerified) {
      pending++;
      continue;
    }
    const id = `the5ers_purchase_${identity(purchase)}`;
    const existing = await tx.select().from(propEntries).where(eq(propEntries.id, id));
    if (existing.length) {
      if (
        existing[0]!.amountMinor !== purchase.amountMinor ||
        existing[0]!.currency !== purchase.currency
      )
        pending++;
      else matched++;
      continue;
    }
    const occurredOn = dayKeyOf(purchase.placedAt, timeZone);
    const candidates = (
      await tx
        .select()
        .from(propEntries)
        .where(
          and(
            eq(propEntries.firm, "The5ers"),
            eq(propEntries.currency, purchase.currency),
            eq(propEntries.occurredOn, occurredOn),
          ),
        )
    ).filter((e) => !e.voided && e.kind === "expense" && e.amountMinor === purchase.amountMinor);
    // Equal economics without a shared stable order ID cannot prove which manual entry it is.
    if (candidates.length) {
      pending++;
      continue;
    }
    await mutatePropInTransaction(tx, {
      action: "entry.save",
      id,
      revision: 0,
      firm: "The5ers",
      accountId: null,
      kind: "expense",
      category: purchase.category,
      currency: purchase.currency,
      amount: String(fromMinor(purchase.amountMinor, purchase.currency)),
      occurredOn,
      reference: id,
      notes: `${purchase.name}\nThe5ers order placed ${purchase.placedAt}`,
    });
    imported++;
  }
  return { imported, matched, pending };
}

/** Annotation/exclusion only: source economics cannot be edited through journal actions. */
export async function annotateSourceTrade(
  tx: JournalExecutor,
  key: string,
  patch: Record<string, unknown> | ((saved: Record<string, unknown>) => Record<string, unknown>),
) {
  const settingKey = `the5ers:annotation:${key}`;
  await tx.insert(settings).values({ key: settingKey, value: "{}" }).onConflictDoNothing();
  const [row] = await tx.select().from(settings).where(eq(settings.key, settingKey)).for("update");
  const annotation = JSON.parse(row!.value);
  const decoded = { ...(typeof patch === "function" ? patch(annotation) : patch) };
  for (const [json, name] of [
    ["tagsJson", "tags"],
    ["mistakesJson", "mistakes"],
  ]) {
    if (typeof decoded[json!] === "string") {
      decoded[name!] = JSON.parse(decoded[json!] as string);
      delete decoded[json!];
    }
  }
  const merged = { ...annotation, ...decoded };
  if (merged.excluded === true) await tx.delete(trades).where(eq(trades.key, key));
  else {
    const projected = ["notes", "playbookId", "rating", "stopLoss", "profitTarget", "reviewedAt"];
    const tablePatch = Object.fromEntries(
      projected
        .filter((field) => Object.hasOwn(decoded, field))
        .map((field) => [field, decoded[field]]),
    );
    if (decoded.tags !== undefined) tablePatch.tagsJson = JSON.stringify(decoded.tags);
    if (decoded.mistakes !== undefined) tablePatch.mistakesJson = JSON.stringify(decoded.mistakes);
    if (Object.keys(tablePatch).length)
      await tx.update(trades).set(tablePatch).where(eq(trades.key, key));
  }
  await setSetting(settingKey, JSON.stringify({ ...annotation, ...decoded }), tx);
}
