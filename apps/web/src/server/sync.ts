import { connect, listBrokers as sdkListBrokers, type BrokerId } from "@luxalgo/broker-sdk";
import { eq } from "drizzle-orm";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { accounts, db, executions } from "@/db";
import { getSetting, setSetting } from "./settings";
import { decryptJson, encryptJson } from "./crypto";
import { nowIso } from "./ids";
import { insertExecutionsInTransaction, type InsertResult } from "./executions";
import { requireValue } from "./api";
import { filterEnabledSyncBrokers, isEnabledSyncBroker } from "@/lib/supported-brokers";

/** All broker connectivity goes through @luxalgo/broker-sdk, never direct API code. */
export const listBrokers = () => filterEnabledSyncBrokers(sdkListBrokers());

export interface SyncOutcome extends InsertResult {
  accountId: string;
  equity: number | null;
  positions: number;
  syncedAt: string;
}

export const syncAccount = async (accountId: string): Promise<SyncOutcome> => {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) throw new Error("Account not found");
  if (account.kind !== "sync" || !account.credentialsEnc) {
    throw new Error("Account is not broker-connected");
  }
  if (!isEnabledSyncBroker(account.broker)) {
    throw new Error("This account is not available for synchronization.");
  }

  const credentials = decryptJson<Record<string, string>>(account.credentialsEnc);
  const connection = connect({
    broker: account.broker as BrokerId,
    credentials,
    // Some brokers rotate tokens on every fetch (Questrade): persist or die.
    onCredentialsRotated: async (next: Record<string, string>) => {
      await db
        .update(accounts)
        .set({ credentialsEnc: encryptJson(next) })
        .where(eq(accounts.id, accountId));
    },
  } as Parameters<typeof connect>[0]);

  const snapshot = await connection.fetchSnapshot();
  const syncedAt = nowIso();
  const bindingKey = `brokerAccount:${accountId}`;
  const selectedId = await getSetting(bindingKey);
  requireValue(
    selectedId || snapshot.accounts.length === 1,
    "This connection contains multiple broker accounts. Connect one account at a time using its broker account ID.",
  );
  const brokerAccount = selectedId
    ? snapshot.accounts.find((a) => a.id === selectedId)
    : snapshot.accounts[0];
  requireValue(brokerAccount, "The selected broker account is unavailable.");
  requireValue(
    /^[A-Z]{3}$/.test(brokerAccount.currency) && Number.isFinite(brokerAccount.equity),
    "Broker returned an invalid account currency or balance.",
  );
  const rows: ImportedExecution[] = brokerAccount.trades.map((trade) => ({
    symbol: trade.symbol,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    fee: trade.fee ?? 0,
    feeReported: trade.fee !== undefined,
    // The SDK omits unparseable timestamps; a fill with no time can't be
    // journaled meaningfully, so it is dropped rather than guessed at.
    executedAt: trade.executedAt ?? "",
  }));
  const timed = rows.filter((row) => row.executedAt !== "");
  const untimed = rows.length - timed.length;

  const equity = brokerAccount.equity;
  const positions = brokerAccount.positions;
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");
    requireValue(current, "Account not found.");
    const binding = await getSetting(bindingKey, tx);
    requireValue(
      !binding || binding === brokerAccount.id,
      "Broker account selection changed during sync. Try again.",
    );
    const [savedFill] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.accountId, accountId))
      .limit(1);
    requireValue(
      binding || !savedFill,
      "This legacy account has no broker account provenance. Connect a separate account and compare its history before retiring the original.",
    );
    requireValue(
      !savedFill || current.currency === brokerAccount.currency,
      "Broker account currency changed. Use a separate journal account.",
    );
    await setSetting(bindingKey, brokerAccount.id, tx);
    // Validation, history provenance, deduplication and sync status commit together.
    const inserted = await insertExecutionsInTransaction(tx, accountId, timed, "sync");
    await tx
      .update(accounts)
      .set({
        lastSyncAt: syncedAt,
        currency: brokerAccount.currency,
        snapshotJson: JSON.stringify({
          brokerAccountId: brokerAccount.id,
          currency: brokerAccount.currency,
          equity,
          positions,
          fetchedAt: snapshot.fetchedAt,
        }),
      })
      .where(eq(accounts.id, accountId));
    return inserted;
  });
  if (untimed > 0) {
    result.skipped += untimed;
    if (result.skippedReasons.length < 5)
      result.skippedReasons.push(`${untimed} fill(s) had no usable timestamp.`);
  }

  return { accountId, ...result, equity, positions: positions.length, syncedAt };
};
