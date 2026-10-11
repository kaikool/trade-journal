import { and, eq } from "drizzle-orm";
import { accounts, db, executions } from "@/db";
import type { JournalExecutor } from "@/db/postgres";
import { isTimeZone } from "@/lib/timezone";
import { requireValue } from "./api";

type Account = typeof accounts.$inferSelect;

export const isIbkrSyncAccount = (account: Account): boolean =>
  account.kind === "sync" && account.broker === "ibkr-flex";

export const canonicalImportTimeZone = (value: unknown): string => {
  requireValue(
    isTimeZone(value) && !/^[+-]/.test(value),
    "Enter a valid IANA default import timezone in Settings → Journal.",
  );
  return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
};

export const hasSyncedExecutions = async (
  accountId: string,
  executor: JournalExecutor = db,
): Promise<boolean> => {
  const [row] = await executor
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.accountId, accountId), eq(executions.source, "sync")))
    .limit(1);
  return Boolean(row);
};

const RECOVERY =
  "Back up your data, verify Default import timezone in Settings → Journal, and connect a separate IBKR account. Compare the corrected history using the account filter; keep the original account and its notes.";

/** Call again inside the insertion transaction: another sync may have finished during fetch. */
export const assertIbkrSyncTimeZone = async (
  account: Account,
  timeZone: string,
  executor: JournalExecutor = db,
): Promise<void> => {
  if (!(await hasSyncedExecutions(account.id, executor))) return;
  requireValue(
    account.ibkrSyncTimeZone !== null,
    `This IBKR account has history from before timezone-aware sync. ${RECOVERY}`,
  );
  requireValue(
    canonicalImportTimeZone(account.ibkrSyncTimeZone) === timeZone,
    `This IBKR account was synced using ${account.ibkrSyncTimeZone}, but the default import timezone is now ${timeZone}. Restore the previous setting to continue syncing this account, or recover with the corrected setting. ${RECOVERY}`,
  );
};

/** Keep provenance with transferred history, including moves through a manual/import account. */
export const ibkrTransferTimeZone = async (
  source: Account,
  destination: Account,
  executor: JournalExecutor = db,
): Promise<string | undefined> => {
  const relevant =
    isIbkrSyncAccount(source) ||
    isIbkrSyncAccount(destination) ||
    source.ibkrSyncTimeZone !== null ||
    destination.ibkrSyncTimeZone !== null;
  if (!relevant || !(await hasSyncedExecutions(source.id, executor))) return undefined;
  requireValue(
    source.ibkrSyncTimeZone !== null,
    `Cannot transfer synced history with an unknown IBKR statement timezone. ${RECOVERY}`,
  );
  requireValue(
    destination.kind !== "sync" || isIbkrSyncAccount(destination),
    "Cannot transfer IBKR synced history into another broker connection. Use a separate manual account to preserve its timezone provenance.",
  );
  const sourceZone = canonicalImportTimeZone(source.ibkrSyncTimeZone);
  if (await hasSyncedExecutions(destination.id, executor)) {
    requireValue(
      destination.ibkrSyncTimeZone !== null &&
        canonicalImportTimeZone(destination.ibkrSyncTimeZone) === sourceZone,
      `Cannot combine synced histories with unknown or different IBKR statement timezones. ${RECOVERY}`,
    );
  }
  return sourceZone;
};
