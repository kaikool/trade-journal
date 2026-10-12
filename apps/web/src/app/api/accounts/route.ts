import { asc, eq } from "drizzle-orm";
import { accounts, db } from "@/db";
import { bad, handler, ok } from "@/server/api";
import { encryptJson } from "@/server/crypto";
import { newId, nowIso } from "@/server/ids";
import { syncAccount } from "@/server/sync";
import { isEnabledSyncBroker } from "@/lib/supported-brokers";

export const GET = handler(async (request: Request) => {
  if (new URL(request.url).searchParams.get("summary") === "1") {
    const list = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        broker: accounts.broker,
        archivedAt: accounts.archivedAt,
      })
      .from(accounts)
      .orderBy(asc(accounts.createdAt));
    return ok({ accounts: list });
  }
  const rows = await db.select().from(accounts).orderBy(asc(accounts.createdAt));
  return ok({
    accounts: rows.map(({ credentialsEnc, ...safe }) => ({
      ...safe,
      connected: credentialsEnc !== null,
      snapshot: safe.snapshotJson ? JSON.parse(safe.snapshotJson) : null,
    })),
  });
});

interface CreateBody {
  name?: string;
  kind?: "sync" | "import" | "manual";
  broker?: string;
  currency?: string;
  initialBalance?: number;
  profitCalcMethod?: "fifo" | "lifo" | "wavg";
  credentials?: Record<string, string>;
  autoSync?: boolean;
}

export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as CreateBody;
  if (!body.name || !body.kind) return bad("name and kind are required");
  if (body.kind === "sync" && (!body.broker || !body.credentials)) {
    return bad("sync accounts need a broker and credentials");
  }
  if (body.kind === "sync" && !isEnabledSyncBroker(body.broker!)) {
    return bad("Choose a broker from the available list.");
  }

  const id = newId();
  await db.insert(accounts).values({
    id,
    name: body.name,
    broker: body.broker ?? "",
    kind: body.kind,
    currency: body.currency ?? "USD",
    initialBalance: body.initialBalance ?? 0,
    profitCalcMethod: body.profitCalcMethod ?? "fifo",
    credentialsEnc: body.kind === "sync" ? encryptJson(body.credentials) : null,
    autoSync: body.autoSync ?? body.kind === "sync",
    createdAt: nowIso(),
  });

  // First sync happens right away so the account isn't born empty.
  let sync = null;
  if (body.kind === "sync") {
    try {
      sync = await syncAccount(id);
    } catch (error) {
      // Bad credentials shouldn't strand a half-created account.
      await db.delete(accounts).where(eq(accounts.id, id));
      return bad(error instanceof Error ? error.message : "Broker connection failed", 502);
    }
  }
  return ok({ id, sync });
});
