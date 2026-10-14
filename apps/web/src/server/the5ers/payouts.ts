import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { propAccounts, propEntries, propReceipts } from "@/db";
import type { JournalExecutor } from "@/db/postgres";
import { sourceFields, sourceInstant, sourceMoney, sourceCurrency } from "@/lib/the5ers-normalize";
import { fromMinor, toMinor } from "@/lib/prop-firms";
import { dayKeyOf } from "@luxalgo/journal-core";
import { requireValue } from "@/server/api";
import { getSetting } from "@/server/settings";
import { mutatePropInTransaction, propToday } from "@/server/prop-firms";

export const payoutKey = (accountId: string, value: unknown) => {
  const row = sourceFields(value);
  const identity = [row.id, row.payoutid, row.withdrawalid, row.requestid, row.paymentid].find(
    (value) =>
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" &&
        value.trim().length > 0 &&
        !/^(?:n\/?a|none|null|undefined|unknown|not available|[-–—]+)$/i.test(value.trim())),
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        accountId,
        identity ??
          ((row.requestedat ?? row.createdat ?? row.requestdate)
            ? [
                row.requestedat ?? row.createdat ?? row.requestdate,
                row.currency,
                row.amount ?? row.total ?? row.netamount ?? row.paidamount ?? row.receivedamount,
              ]
            : value),
      ]),
    )
    .digest("hex");
};

export function sourceRecords(history: { pages: unknown[] }, collection: string): unknown[] {
  return history.pages.flatMap((page) => {
    const envelope = sourceFields(page);
    if (Array.isArray(envelope.data)) return envelope.data;
    const body = sourceFields(envelope.data ?? page);
    const rows =
      body[collection] ??
      (collection === "payouts" ? body.withdrawals : undefined) ??
      body.items ??
      body.notifications ??
      body.history;
    return Array.isArray(rows) ? rows : [];
  });
}

/** Only explicit settlement facts can automatically become cash receipts. */
export function settledPayout(value: unknown) {
  const row = sourceFields(value);
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  const currency = sourceCurrency(row.currency);
  const receivedAt = sourceInstant(
    row.receivedat ?? row.paidat ?? row.settledat ?? row.paymentdate ?? row.completedat,
  );
  const requestedAt = sourceInstant(row.requestedat ?? row.createdat ?? row.requestdate);
  // A generic amount may be gross, before profit split or commission.
  const amountMinor = currency
    ? sourceMoney(row.receivedamount ?? row.paidamount ?? row.netamount ?? row.netpaid, currency)
    : undefined;
  if (
    !["completed", "paid", "received", "settled"].includes(status) ||
    !currency ||
    !receivedAt ||
    !requestedAt ||
    requestedAt > receivedAt ||
    !amountMinor ||
    row.reversed === true
  )
    return;
  return { currency, receivedAt, requestedAt, amountMinor };
}

export async function recordPayoutReceipt(
  tx: JournalExecutor,
  sourceAccountId: string,
  source: unknown,
  confirmation?: { accountId: string; amount: string; receivedOn: string },
) {
  const timeZone = (await getSetting("timeZone", tx)) ?? "UTC";
  const settlement = settledPayout(source);
  if (!settlement && !confirmation) {
    const existing = await tx
      .select({ id: propReceipts.id })
      .from(propReceipts)
      .innerJoin(propEntries, eq(propReceipts.payoutId, propEntries.id))
      .where(
        and(
          eq(propReceipts.id, `the5ers_received_${payoutKey(sourceAccountId, source)}`),
          eq(propReceipts.voided, false),
          eq(propEntries.voided, false),
        ),
      );
    return existing.length ? ("matched" as const) : ("pending" as const);
  }
  const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
    string,
    string
  >;
  const candidates = (
    await tx.select().from(propAccounts).where(eq(propAccounts.firm, "The5ers"))
  ).filter(
    (a) =>
      !a.archived &&
      ["funded", "instant_funded", "live"].includes(a.program) &&
      (confirmation
        ? a.id === confirmation.accountId
        : a.journalAccountId === links[sourceAccountId] && a.currency === settlement!.currency),
  );
  if (!confirmation && candidates.length !== 1) return "pending" as const;
  requireValue(
    candidates.length === 1,
    "Choose a funded The5ers prop account to record money received.",
  );
  const account = candidates[0]!;
  let amountMinor = settlement?.amountMinor;
  if (confirmation) {
    try {
      amountMinor = toMinor(confirmation.amount, account.currency);
    } catch {
      requireValue(false, "Enter a valid amount in the account currency.");
    }
  }
  requireValue(
    amountMinor !== undefined && amountMinor > 0,
    "Enter the positive amount actually received, after fees and profit split.",
  );
  const receivedOn = confirmation?.receivedOn ?? dayKeyOf(settlement!.receivedAt, timeZone);
  const requestedAt = sourceInstant(
    sourceFields(source).requestedat ?? sourceFields(source).createdat,
  );
  const occurredOn = requestedAt ? dayKeyOf(requestedAt, timeZone) : receivedOn;
  if (!confirmation && (occurredOn < account.openedOn || receivedOn > (await propToday(tx))))
    return "pending" as const;
  requireValue(
    occurredOn >= account.openedOn,
    "The payout predates this prop account. Choose the matching funding phase.",
  );
  const key = payoutKey(sourceAccountId, source);
  const entryId = `the5ers_payout_${key}`;
  const receiptId = `the5ers_received_${key}`;
  const [existingReceipt] = await tx
    .select()
    .from(propReceipts)
    .where(eq(propReceipts.id, receiptId));
  if (existingReceipt) {
    if (
      !confirmation &&
      (existingReceipt.amountMinor !== amountMinor ||
        existingReceipt.occurredOn !== receivedOn ||
        existingReceipt.voided)
    )
      return "pending" as const;
    const [existingEntry] = await tx
      .select()
      .from(propEntries)
      .where(eq(propEntries.id, existingReceipt.payoutId));
    requireValue(
      existingEntry &&
        existingEntry.accountId === account.id &&
        existingEntry.currency === account.currency &&
        !existingEntry.voided,
      "This payout is already recorded against another account or currency, or was voided.",
    );
    requireValue(
      existingReceipt.amountMinor === amountMinor &&
        existingReceipt.occurredOn === receivedOn &&
        !existingReceipt.voided,
      "This payout receipt changed or was voided locally. Review the existing transaction before recording a correction.",
    );
    return "matched" as const;
  }
  // Do not count a manually recorded settlement twice.
  const manual = await tx
    .select({ id: propReceipts.id })
    .from(propReceipts)
    .innerJoin(propEntries, eq(propReceipts.payoutId, propEntries.id))
    .where(
      and(
        eq(propEntries.accountId, account.id),
        eq(propEntries.voided, false),
        eq(propReceipts.voided, false),
        eq(propReceipts.kind, "receipt"),
        eq(propReceipts.amountMinor, amountMinor),
        eq(propReceipts.occurredOn, receivedOn),
      ),
    );
  if (manual.length) {
    if (!confirmation) return "pending" as const;
    requireValue(
      false,
      "A matching receipt is already in this account's ledger. Open that transaction to avoid counting it twice.",
    );
  }
  let [entry] = await tx
    .select()
    .from(propEntries)
    .where(eq(propEntries.id, entryId))
    .for("update");
  if (!entry) {
    await mutatePropInTransaction(tx, {
      action: "entry.save",
      id: entryId,
      revision: 0,
      accountId: account.id,
      firm: "The5ers",
      kind: "payout",
      currency: account.currency,
      amount: String(fromMinor(amountMinor, account.currency)),
      splitPercent: "100",
      fee: "0",
      status: "approved",
      occurredOn,
      reference: entryId,
      notes:
        "The5ers payout: net settlement after profit split and fees, not gross trading profit.",
    });
    [entry] = await tx.select().from(propEntries).where(eq(propEntries.id, entryId));
  }
  requireValue(
    entry && entry.accountId === account.id && entry.currency === account.currency && !entry.voided,
    "The existing payout has a different account or currency, or was voided.",
  );
  await mutatePropInTransaction(tx, {
    action: "receipt.add",
    id: receiptId,
    payoutId: entryId,
    revision: entry.revision,
    kind: "receipt",
    amount: String(fromMinor(amountMinor, account.currency)),
    occurredOn: receivedOn,
    reference: receiptId,
    notes: confirmation
      ? "Actual money received confirmed by the journal owner."
      : "Explicit net settlement reported by The5ers.",
  });
  const [received] = await tx.select().from(propEntries).where(eq(propEntries.id, entryId));
  await mutatePropInTransaction(tx, {
    action: "entry.save",
    id: entryId,
    revision: received!.revision,
    accountId: account.id,
    firm: "The5ers",
    kind: "payout",
    currency: account.currency,
    amount: String(fromMinor(amountMinor, account.currency)),
    splitPercent: "100",
    fee: "0",
    status: "completed",
    occurredOn,
    reference: entryId,
    notes: entry.notes,
    reason: "Recorded The5ers net settlement.",
  });
  return "imported" as const;
}
