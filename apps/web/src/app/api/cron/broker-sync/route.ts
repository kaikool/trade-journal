import { timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { accounts, db } from "@/db";
import { syncAccount } from "@/server/sync";
import { passwordConfigured } from "@/server/auth";
import { ensureAllInventoryAccountsSaved, syncScheduledThe5ers } from "@/server/the5ers/data";
import { ENABLED_SYNC_BROKER_IDS } from "@/lib/supported-brokers";

export const maxDuration = 300;

function hasValidCronSecret(request: Request, secret: string): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const received = Buffer.from(authorization, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Daily Vercel Cron: only accounts explicitly opted into automatic sync. */
export async function GET(request: Request): Promise<Response> {
  if (!passwordConfigured())
    return Response.json({ error: "JOURNAL_PASSWORD is required" }, { status: 503 });
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim())
    return Response.json({ error: "Cron sync is not configured" }, { status: 503 });
  if (!hasValidCronSecret(request, secret))
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const deadline = Date.now() + 240_000;
  const enabled = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.kind, "sync"),
        eq(accounts.autoSync, true),
        isNull(accounts.archivedAt),
        inArray(accounts.broker, [...ENABLED_SYNC_BROKER_IDS]),
      ),
    )
    .orderBy(asc(accounts.createdAt));

  let synced = 0;
  let failed = 0;
  for (const account of enabled) {
    try {
      await syncAccount(account.id);
      synced++;
    } catch (error) {
      failed++;
      console.error("[cron] Broker auto-sync failed", {
        accountId: account.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  try {
    await ensureAllInventoryAccountsSaved(
      AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    );
  } catch (err) {
    console.error("[cron] The5ers ensure inventory failed", err);
  }

  const the5ers = await syncScheduledThe5ers(deadline);
  synced += the5ers.synced;
  failed += the5ers.failed;
  return Response.json(
    {
      checked: enabled.length + the5ers.checked,
      synced,
      failed,
      ...(the5ers.purchases ? { the5ersPurchases: the5ers.purchases } : {}),
    },
    { status: failed || the5ers.purchases?.synced === false ? 500 : 200 },
  );
}
