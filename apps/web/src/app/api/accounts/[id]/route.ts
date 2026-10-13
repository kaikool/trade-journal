import { eq } from "drizzle-orm";
import { accounts, db, executions, trades } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { rebuildAccountInTransaction } from "@/server/rebuild";
import { hasSyncedExecutions, isIbkrSyncAccount } from "@/server/ibkr-sync-timezone";
import { isEnabledSyncBroker } from "@/lib/supported-brokers";
import { validateAccountBody } from "@/server/account-validation";
import { deleteSetting } from "@/server/settings";

type Params = { params: Promise<{ id: string }> };

interface PatchBody {
  name?: string;
  broker?: string;
  currency?: string;
  initialBalance?: number;
  profitCalcMethod?: "fifo" | "lifo" | "wavg";
  autoSync?: boolean;
}

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  if (!account) return bad("Account not found", 404);

  const body = (await request.json()) as PatchBody;
  validateAccountBody(body);
  if (account.kind === "sync" && body.broker !== undefined && !isEnabledSyncBroker(body.broker))
    return bad("Choose a broker from the available list.");
  const patch: Partial<typeof accounts.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.broker !== undefined) patch.broker = body.broker;
  if (body.currency !== undefined) patch.currency = body.currency;
  if (body.initialBalance !== undefined) patch.initialBalance = body.initialBalance;
  if (body.autoSync !== undefined) patch.autoSync = body.autoSync;
  if (body.profitCalcMethod !== undefined) patch.profitCalcMethod = body.profitCalcMethod;

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1)
      .for("update");
    requireValue(current, "Account not found.");
    if (body.broker !== undefined && body.broker !== current.broker && isIbkrSyncAccount(current)) {
      const synced = await hasSyncedExecutions(id, tx);
      requireValue(
        !synced,
        "An IBKR account with synced history cannot change brokers. Connect a separate account to preserve its timestamp history.",
      );
    }
    if (Object.keys(patch).length > 0) {
      await tx.update(accounts).set(patch).where(eq(accounts.id, id));
    }
    // A new profit-calc method changes per-exit attribution — recompute.
    if (body.profitCalcMethod && body.profitCalcMethod !== current.profitCalcMethod) {
      await rebuildAccountInTransaction(id, tx);
    }
  });
  return ok({ updated: true });
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  await db.transaction(async (tx) => {
    await tx.delete(trades).where(eq(trades.accountId, id));
    await tx.delete(executions).where(eq(executions.accountId, id));
    await tx.delete(accounts).where(eq(accounts.id, id));
    await deleteSetting(`brokerAccount:${id}`, tx);
  });
  return ok({ deleted: true });
});
