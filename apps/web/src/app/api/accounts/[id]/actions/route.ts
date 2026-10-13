import { and, eq, inArray } from "drizzle-orm";
import {
  accounts,
  settings,
  db,
  executions,
  trades,
  notes,
  attachments,
  tradeRuleChecks,
  importSources,
  importSourceAliases,
  importBatches,
} from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { getSetting } from "@/server/settings";
import { JOURNAL_SOURCE_PREFIX } from "@/server/the5ers/journal";
import { nowIso } from "@/server/ids";
import { rebuildAccountInTransaction } from "@/server/rebuild";
import { syncAccount } from "@/server/sync";
import { ibkrTransferTimeZone } from "@/server/ibkr-sync-timezone";

type Params = { params: Promise<{ id: string }> };

interface ActionBody {
  action: "archive" | "unarchive" | "clear" | "sync" | "transfer";
  /** For "transfer": destination account id. */
  toAccountId?: string;
}

export const POST = handler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  if (!account) return bad("Account not found", 404);
  const body = (await request.json()) as ActionBody;

  switch (body.action) {
    case "archive":
      await db.update(accounts).set({ archivedAt: nowIso() }).where(eq(accounts.id, id));
      return ok({ archived: true });
    case "unarchive":
      await db.update(accounts).set({ archivedAt: null }).where(eq(accounts.id, id));
      return ok({ archived: false });
    case "clear":
      await db.transaction(async (tx) => {
        const links = JSON.parse((await getSetting("the5ers:journal-links", tx)) ?? "{}") as Record<
          string,
          string
        >;
        for (const [source, target] of Object.entries(links))
          if (target === id)
            await tx.delete(settings).where(eq(settings.key, `${JOURNAL_SOURCE_PREFIX}${source}`));
        await tx.delete(trades).where(eq(trades.accountId, id));
        await tx.delete(executions).where(eq(executions.accountId, id));
        await tx.update(accounts).set({ ibkrSyncTimeZone: null }).where(eq(accounts.id, id));
      });
      return ok({ cleared: true });
    case "sync":
      return ok({ sync: await syncAccount(id) });
    case "transfer": {
      const sourceLinks = JSON.parse((await getSetting("the5ers:journal-links")) ?? "{}") as Record<
        string,
        string
      >;
      requireValue(
        !Object.values(sourceLinks).includes(id),
        "Change this The5ers account's journal link in Accounts instead of transferring execution history.",
      );
      if (!body.toAccountId) return bad("toAccountId is required");
      const destinationId = body.toAccountId;
      requireValue(destinationId !== id, "Choose a different destination account.");
      const [destination] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, destinationId))
        .limit(1);
      if (!destination) return bad("Destination account not found", 404);

      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(accounts)
          .where(inArray(accounts.id, [id, destinationId]))
          .orderBy(accounts.id)
          .for("update");
        const currentSource = locked.find((a) => a.id === id);
        const currentDestination = locked.find((a) => a.id === destinationId);
        requireValue(currentSource && currentDestination, "Account not found.");
        requireValue(
          currentSource.currency === currentDestination.currency,
          "Transfer requires accounts with the same currency.",
        );
        const sourceTrades = await tx.select().from(trades).where(eq(trades.accountId, id));
        const destinationTrades = await tx
          .select()
          .from(trades)
          .where(eq(trades.accountId, destinationId));
        const sourceFills = await tx.select().from(executions).where(eq(executions.accountId, id));
        const destinationFills = await tx
          .select()
          .from(executions)
          .where(eq(executions.accountId, destinationId));
        const hashes = new Set(destinationFills.map((fill) => fill.contentHash));
        requireValue(
          !sourceFills.some((fill) => hashes.has(fill.contentHash)),
          "Destination already contains matching fills. Nothing was transferred.",
        );
        const timeZone = await ibkrTransferTimeZone(currentSource, currentDestination, tx);
        if (timeZone !== undefined)
          await tx
            .update(accounts)
            .set({ ibkrSyncTimeZone: timeZone })
            .where(eq(accounts.id, destinationId));
        await tx
          .update(executions)
          .set({ accountId: destinationId })
          .where(eq(executions.accountId, id));
        await rebuildAccountInTransaction(destinationId, tx);
        const rebuilt = new Map(
          (await tx.select().from(trades).where(eq(trades.accountId, destinationId))).map(
            (trade) => [trade.key, trade],
          ),
        );
        const identity = (row: typeof trades.$inferSelect) =>
          JSON.stringify([
            row.direction,
            row.openedAt,
            row.closedAt,
            (JSON.parse(row.executionIdsJson) as string[]).sort(),
          ]);
        // Reject merges and key collisions rather than losing or overwriting either review.
        requireValue(
          rebuilt.size === sourceTrades.length + destinationTrades.length &&
            destinationTrades.every(
              (trade) =>
                rebuilt.has(trade.key) && identity(rebuilt.get(trade.key)!) === identity(trade),
            ) &&
            sourceTrades.every((trade) => {
              const key = destinationId + trade.key.slice(id.length);
              return rebuilt.has(key) && identity(rebuilt.get(key)!) === identity(trade);
            }),
          "These histories would merge or change trade identities. Use a separate destination account; nothing was transferred.",
        );
        for (const source of sourceTrades) {
          const newKey = destinationId + source.key.slice(id.length);
          await tx
            .update(trades)
            .set({
              notes: source.notes,
              tagsJson: source.tagsJson,
              mistakesJson: source.mistakesJson,
              playbookId: source.playbookId,
              rating: source.rating,
              stopLoss: source.stopLoss,
              profitTarget: source.profitTarget,
              reviewedAt: source.reviewedAt,
            })
            .where(eq(trades.key, newKey));
          await tx.update(notes).set({ tradeKey: newKey }).where(eq(notes.tradeKey, source.key));
          await tx
            .update(attachments)
            .set({ ownerId: newKey })
            .where(and(eq(attachments.ownerType, "trade"), eq(attachments.ownerId, source.key)));
          const checks = await tx
            .select()
            .from(tradeRuleChecks)
            .where(eq(tradeRuleChecks.tradeKey, source.key));
          for (const check of checks)
            await tx
              .update(tradeRuleChecks)
              .set({ id: JSON.stringify([newKey, check.playbookId, check.rule]), tradeKey: newKey })
              .where(eq(tradeRuleChecks.id, check.id));
        }
        await tx
          .update(importSources)
          .set({ accountId: destinationId })
          .where(eq(importSources.accountId, id));
        await tx
          .update(importSourceAliases)
          .set({ accountId: destinationId })
          .where(eq(importSourceAliases.accountId, id));
        await tx
          .update(importBatches)
          .set({ accountId: destinationId })
          .where(eq(importBatches.accountId, id));
        await tx.delete(trades).where(eq(trades.accountId, id));
        await tx.update(accounts).set({ ibkrSyncTimeZone: null }).where(eq(accounts.id, id));
      });
      return ok({ transferred: true });
    }
    default:
      return bad("Unknown action");
  }
});
