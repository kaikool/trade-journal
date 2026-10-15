import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { accounts, db } from "@/db";
import { syncAccount } from "@/server/sync";
import { ensureAllInventoryAccountsSaved, syncScheduledThe5ers } from "@/server/the5ers/data";
import { connectionSummary } from "@/server/the5ers/oauth";
import { ENABLED_SYNC_BROKER_IDS } from "@/lib/supported-brokers";

export interface GlobalSyncResult {
  syncedBrokers: number;
  failedBrokers: number;
  the5ers?: {
    checked: number;
    synced: number;
    failed: number;
    purchases?: { synced: boolean; pending?: number };
    newAccountsDiscovered?: number;
  };
  syncedAt: string;
  cooldownSkipped?: boolean;
}

let inFlightSync: Promise<GlobalSyncResult> | null = null;
let lastSyncTimestamp = 0;

export async function runGlobalSync(
  options: { force?: boolean; all?: boolean; deadlineMs?: number } = {},
): Promise<GlobalSyncResult> {
  const now = Date.now();
  const COOLDOWN_MS = 10_000; // 10s debounce cooldown

  if (!options.force && inFlightSync) {
    return inFlightSync;
  }

  if (!options.force && now - lastSyncTimestamp < COOLDOWN_MS) {
    return {
      syncedBrokers: 0,
      failedBrokers: 0,
      syncedAt: new Date(lastSyncTimestamp).toISOString(),
      cooldownSkipped: true,
    };
  }

  const syncPromise = (async () => {
    const deadline = Date.now() + (options.deadlineMs ?? 8_500);

    // 1. Sync standard broker accounts
    const conditions = [
      eq(accounts.kind, "sync"),
      isNull(accounts.archivedAt),
      inArray(accounts.broker, [...ENABLED_SYNC_BROKER_IDS]),
    ];

    if (!options.all) {
      conditions.push(eq(accounts.autoSync, true));
    }

    const brokerAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(...conditions))
      .orderBy(asc(accounts.createdAt));

    let syncedBrokers = 0;
    let failedBrokers = 0;

    for (const acc of brokerAccounts) {
      if (Date.now() >= deadline) {
        failedBrokers += brokerAccounts.length - (syncedBrokers + failedBrokers);
        break;
      }
      try {
        await syncAccount(acc.id);
        syncedBrokers++;
      } catch (err) {
        failedBrokers++;
        console.error("[global-sync] Broker sync failed for account", {
          accountId: acc.id,
          errorName: err instanceof Error ? err.name : "UnknownError",
        });
      }
    }

    // 2. Discover new The5ers accounts and sync trades, payouts, purchases
    let the5ersResult: GlobalSyncResult["the5ers"];
    try {
      const the5ersConn = await connectionSummary();
      if (the5ersConn.connected && Date.now() < deadline) {
        let newAccountsDiscovered = 0;
        let inventoryAccounts:
          Awaited<ReturnType<typeof ensureAllInventoryAccountsSaved>>["accounts"] | undefined;
        try {
          const invResult = await ensureAllInventoryAccountsSaved(
            AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
          );
          newAccountsDiscovered = invResult.accountsCount;
          inventoryAccounts = invResult.accounts;
        } catch (invErr) {
          console.error("[global-sync] The5ers ensure inventory failed", invErr);
        }

        const remainingMs = Math.max(1000, deadline - Date.now());
        const scheduled = await syncScheduledThe5ers(Date.now() + remainingMs, inventoryAccounts);
        the5ersResult = {
          checked: scheduled.checked,
          synced: scheduled.synced,
          failed: scheduled.failed,
          purchases: scheduled.purchases,
          newAccountsDiscovered,
        };
      }
    } catch (the5ersErr) {
      console.error("[global-sync] The5ers sync failed", the5ersErr);
    }

    lastSyncTimestamp = Date.now();
    return {
      syncedBrokers,
      failedBrokers,
      the5ers: the5ersResult,
      syncedAt: new Date(lastSyncTimestamp).toISOString(),
    };
  })();

  inFlightSync = syncPromise;
  try {
    return await syncPromise;
  } finally {
    inFlightSync = null;
  }
}
