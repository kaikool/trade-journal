import { asc, eq } from "drizzle-orm";
import { accounts, trades, propAccounts, db } from "@/db";
import { bad, handler, ok } from "@/server/api";
import { encryptJson } from "@/server/crypto";
import { newId, nowIso } from "@/server/ids";
import { syncAccount } from "@/server/sync";
import { isEnabledSyncBroker } from "@/lib/supported-brokers";
import { validateAccountBody } from "@/server/account-validation";
import { setSetting, deleteSetting, getSetting } from "@/server/settings";

export const GET = handler(async (request: Request) => {
  const all = await db.select().from(accounts).orderBy(asc(accounts.createdAt));
  const links = JSON.parse((await getSetting("the5ers:journal-links")) ?? "{}") as Record<
    string,
    string
  >;
  const selection = JSON.parse((await getSetting("the5ers:selection")) ?? "[]") as {
    id: string;
    journalAccountId?: string;
  }[];
  const selected = new Set(selection.map((a) => a.journalAccountId ?? links[a.id]));

  const traded = new Set(
    (await db.select({ accountId: trades.accountId }).from(trades).groupBy(trades.accountId)).map(
      (a) => a.accountId,
    ),
  );
  // Older cash imports created empty journal accounts. Keep their ledger links,
  // but omit those automatic shells from the trading workspace.
  const rows = all.filter(
    (a) =>
      !(
        a.id.startsWith("the5ers_") &&
        a.broker === "The5ers" &&
        !selected.has(a.id) &&
        !traded.has(a.id) &&
        !a.initialBalance &&
        !a.snapshotJson &&
        /^The5ers(?:[ ·-]+(?:meta-trader-[\w-]+|c-trader|trader-evolution)[ ·-]+|[-])(?:…|\.\.\.)/.test(
          a.name,
        )
      ),
  );

  // Load prop firm account metadata to reflect status
  const propList = await db.select().from(propAccounts);
  const propByJournalId = new Map(
    propList.filter((p) => p.journalAccountId).map((p) => [p.journalAccountId!, p]),
  );
  const propById = new Map(propList.map((p) => [p.id, p]));

  // Read visible accounts configured for Journal / Dashboard / Trades
  const visibleSetting = await getSetting("journal:visible-accounts");
  let visibleSet: Set<string>;
  if (visibleSetting) {
    try {
      visibleSet = new Set(JSON.parse(visibleSetting));
    } catch {
      visibleSet = new Set(rows.filter((a) => !a.archivedAt).map((a) => a.id));
    }
  } else {
    // By default, all unarchived accounts are visible
    visibleSet = new Set(rows.filter((a) => !a.archivedAt).map((a) => a.id));
  }

  if (new URL(request.url).searchParams.get("summary") === "1") {
    return ok({
      accounts: rows.map((a) => ({
        id: a.id,
        name: a.name,
        broker: a.broker,
        currency: a.currency,
        archivedAt: a.archivedAt,
        visibleInJournal: visibleSet.has(a.id),
      })),
    });
  }

  return ok({
    accounts: rows.map(({ credentialsEnc, ...safe }) => {
      const prop = propByJournalId.get(safe.id) ?? propById.get(safe.id);
      const isPropActive = prop
        ? ["active", "funded", "open"].includes(prop.status.toLowerCase())
        : !safe.archivedAt;
      return {
        ...safe,
        name: safe.name,
        the5ersSourceId: Object.entries(links).find(([, target]) => target === safe.id)?.[0],
        the5ersSelected: selected.has(safe.id),
        visibleInJournal: visibleSet.has(safe.id),
        propStatus: prop?.status ?? (safe.archivedAt ? "archived" : "active"),
        propProgram: prop?.program,
        propSizeMinor: prop?.sizeMinor,
        isActive: isPropActive,
        connected: credentialsEnc !== null,
        snapshot: safe.snapshotJson ? JSON.parse(safe.snapshotJson) : null,
      };
    }),
  });
});

export const PUT = handler(async (request: Request) => {
  const body = (await request.json()) as {
    action?: "set" | "select-all" | "select-active" | "deselect-all";
    accountIds?: string[];
  };
  const all = await db.select().from(accounts);
  const propList = await db.select().from(propAccounts);
  const propByJournalId = new Map(
    propList.filter((p) => p.journalAccountId).map((p) => [p.journalAccountId!, p]),
  );
  const propById = new Map(propList.map((p) => [p.id, p]));

  let nextVisible: string[] = [];
  if (body.action === "select-all") {
    nextVisible = all.map((a) => a.id);
  } else if (body.action === "select-active") {
    nextVisible = all
      .filter((a) => {
        const prop = propByJournalId.get(a.id) ?? propById.get(a.id);
        if (prop) return ["active", "funded", "open"].includes(prop.status.toLowerCase());
        return !a.archivedAt;
      })
      .map((a) => a.id);
  } else if (body.action === "deselect-all") {
    nextVisible = [];
  } else if (body.action === "set" && Array.isArray(body.accountIds)) {
    const allSet = new Set(all.map((a) => a.id));
    nextVisible = body.accountIds.filter((id) => allSet.has(id));
  } else {
    return bad("Provide a valid visibility action.");
  }

  await setSetting("journal:visible-accounts", JSON.stringify(nextVisible));
  return ok({ visibleAccounts: nextVisible });
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
  brokerAccountId?: string;
}

export const POST = handler(async (request: Request) => {
  const body = (await request.json()) as CreateBody;
  validateAccountBody(body, true);
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

  if (body.kind === "sync" && body.brokerAccountId)
    await setSetting(`brokerAccount:${id}`, body.brokerAccountId.trim());

  // First sync happens right away so the account isn't born empty.
  let sync = null;
  if (body.kind === "sync") {
    try {
      sync = await syncAccount(id);
    } catch (error) {
      // Bad credentials shouldn't strand a half-created account.
      await db.delete(accounts).where(eq(accounts.id, id));
      await deleteSetting(`brokerAccount:${id}`);
      return bad(error instanceof Error ? error.message : "Broker connection failed", 502);
    }
  }
  return ok({ id, sync });
});
