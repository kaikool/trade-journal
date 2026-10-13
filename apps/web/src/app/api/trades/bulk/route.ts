import { eq, inArray } from "drizzle-orm";
import { db, trades, playbooks } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { deleteExecutionsForTrades } from "@/server/executions";
import { nowIso } from "@/server/ids";

interface BulkBody {
  keys: string[];
  action: "review" | "unreview" | "tag" | "untag" | "playbook" | "delete";
  tag?: string;
  playbookId?: string | null;
}

export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as BulkBody;
  requireValue(body && typeof body === "object", "Invalid bulk request.");
  requireValue(
    Array.isArray(body.keys) &&
      body.keys.length <= 1000 &&
      body.keys.every((key) => typeof key === "string" && key.length <= 2000),
    "Choose at most 1,000 valid trade keys.",
  );
  if (!Array.isArray(body.keys) || body.keys.length === 0) return bad("keys are required");
  const rows = await db.select().from(trades).where(inArray(trades.key, body.keys));

  switch (body.action) {
    case "review":
    case "unreview":
      await db
        .update(trades)
        .set({ reviewedAt: body.action === "review" ? nowIso() : null })
        .where(inArray(trades.key, body.keys));
      return ok({ updated: rows.length });
    case "tag":
    case "untag": {
      requireValue(
        typeof body.tag === "string" && body.tag.trim().length > 0 && body.tag.length <= 200,
        "Enter a tag up to 200 characters.",
      );
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(trades)
          .where(inArray(trades.key, body.keys))
          .orderBy(trades.key)
          .for("update");
        for (const row of locked) {
          const tags = new Set<string>(row.tagsJson ? (JSON.parse(row.tagsJson) as string[]) : []);
          if (body.action === "tag") tags.add(body.tag!);
          else tags.delete(body.tag!);
          requireValue(tags.size <= 100, "A trade supports at most 100 tags.");
          await tx
            .update(trades)
            .set({ tagsJson: JSON.stringify([...tags]) })
            .where(eq(trades.key, row.key));
        }
      });
      return ok({ updated: rows.length });
    }
    case "playbook":
      requireValue(
        body.playbookId == null ||
          (typeof body.playbookId === "string" &&
            Boolean(
              (
                await db
                  .select({ id: playbooks.id })
                  .from(playbooks)
                  .where(eq(playbooks.id, body.playbookId))
                  .limit(1)
              )[0],
            )),
        "Playbook not found.",
      );
      await db
        .update(trades)
        .set({ playbookId: body.playbookId ?? null })
        .where(inArray(trades.key, body.keys));
      return ok({ updated: rows.length });
    case "delete": {
      const byAccount = new Map<string, string[]>();
      for (const row of rows) {
        const ids = JSON.parse(row.executionIdsJson) as string[];
        byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), ...ids]);
      }
      for (const [accountId, executionIds] of byAccount) {
        await deleteExecutionsForTrades(accountId, executionIds);
      }
      return ok({ deleted: rows.length });
    }
    default:
      return bad("Unknown action");
  }
});
