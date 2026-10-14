import { createHash, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, settings } from "@/db";
import { requireValue } from "@/server/api";
import { encryptJson, decryptJson } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";
import { assertConnection } from "./oauth";
import { READ_TOOLS, type ReadTool } from "./contracts";
import type { The5ersMcp } from "./mcp";

const JOB = "the5ers:module-job";
const SUMMARY = "the5ers:module-sync";
const PREFIX = "the5ers:module:";
type Account = { id: string; ref: string };
type Spec = {
  tool: ReadTool;
  operation: string;
  required: string[];
  properties: Record<string, unknown>;
};
type Task = {
  key: string;
  spec: Spec;
  subject: string;
  accountIds: string[];
  args: Record<string, unknown>;
  state: "pending" | "saved" | "failed";
  attemptedAt?: number;
  projectionError?: string;
  page: number;
  parent?: string;
  refIdentity?: string;
  refParameter?: string;
  refRetrievedAt?: number;
  error?: string;
};
type StoredTask = Omit<Task, "spec"> & { specKey: string };
type Job = {
  connectionId: string;
  startedAt: string;
  finishedAt?: string;
  specs: Spec[];
  tasks: Task[];
  unsupported: string[];
};
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Preserve every returned row; omit credentials and short-lived provider references. */
function archiveData(value: unknown, accountRefs?: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => archiveData(item, accountRefs));
  if (value && typeof value === "object") {
    const row = obj(value);
    const entries = Object.entries(row);
    const safe = Object.fromEntries(
      entries
        .filter(
          ([key]) =>
            !/token|password|secret|authorization|credential|cookie|refs?$|^_meta$/i.test(key),
        )
        .map(([key, item]) => [key, archiveData(item, accountRefs)]),
    );
    for (const [key, item] of entries) {
      if (/^(?:account_?ref|ref)$/i.test(key) && typeof item === "string" && accountRefs?.has(item))
        safe.sourceAccountId = accountRefs.get(item);
      if (/^account_?refs$/i.test(key) && Array.isArray(item))
        safe.sourceAccountIds = item.flatMap((ref) =>
          typeof ref === "string" && accountRefs?.has(ref) ? [accountRefs.get(ref)] : [],
        );
    }
    return safe;
  }
  return typeof value === "string"
    ? value.replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]{20,}\b/g, "[redacted]")
    : value;
}
function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!value || typeof value !== "object") return [];
  const row = obj(value);
  return [row, ...Object.values(row).flatMap(objects)];
}
function specsFrom(tools: Record<string, unknown>[]) {
  const specs: Spec[] = [];
  const unsupported: string[] = [];
  for (const tool of tools) {
    const entry = Object.entries(READ_TOOLS).find(
      ([, definition]) => definition.name === tool.name,
    );
    if (!entry) {
      unsupported.push(String(tool.name));
      continue;
    }
    const [alias, definition] = entry;
    const schema = obj(tool.inputSchema);
    const variants = Array.isArray(schema.anyOf)
      ? schema.anyOf.map(obj)
      : Array.isArray(schema.oneOf)
        ? schema.oneOf.map(obj)
        : [schema];
    for (const variant of variants) {
      const properties = obj(variant.properties);
      const operation = obj(properties.operation);
      const operations =
        typeof operation.const === "string"
          ? [operation.const]
          : Array.isArray(operation.enum)
            ? operation.enum
            : [];
      for (const name of operations) {
        if (
          typeof name !== "string" ||
          !(definition.operations as readonly string[]).includes(name)
        ) {
          unsupported.push(`${tool.name}.${name}`);
          continue;
        }
        if (specs.some((s) => s.tool === alias && s.operation === name)) continue;
        specs.push({
          tool: alias as ReadTool,
          operation: name,
          properties,
          required: Array.isArray(variant.required)
            ? variant.required.filter(
                (key): key is string =>
                  typeof key === "string" &&
                  !["operation", "contract_version", "request_context"].includes(key),
              )
            : [],
        });
      }
    }
  }
  return { specs, unsupported };
}
function task(
  spec: Spec,
  subject: string,
  accountIds: string[] = [],
  args: Record<string, unknown> = {},
): Task {
  return {
    key: hash([spec.tool, spec.operation, subject, args]),
    spec,
    subject,
    accountIds,
    args,
    state: "pending",
    page: 1,
  };
}
function enqueue(job: Job, item: Task) {
  if (!job.tasks.some((t) => t.key === item.key)) {
    requireValue(
      job.tasks.length < 100_000,
      "The5ers module sync reached its record limit. Saved data was retained.",
    );
    job.tasks.push(item);
  }
}
function argumentsFor(item: Task, accounts: Account[]) {
  const args = { ...item.args };
  if (item.spec.required.includes("account_ref")) {
    const account = accounts.find((a) => a.id === item.accountIds[0]);
    requireValue(account, "This source account is no longer available.");
    args.account_ref = account.ref;
  }
  if (item.spec.required.includes("account_refs")) {
    args.account_refs = item.accountIds.map((id) => {
      const account = accounts.find((a) => a.id === id);
      requireValue(account, "An account in this comparison is no longer available.");
      return account.ref;
    });
  }
  if (Object.hasOwn(item.spec.properties, "view")) args.view = "all";
  if (Object.hasOwn(item.spec.properties, "page")) args.page = item.page;
  if (Object.hasOwn(item.spec.properties, "limit"))
    args.limit = item.spec.tool === "contest" ? 20 : 50;
  return args;
}
function reference(
  row: Record<string, unknown>,
  parameter: string,
  parent: Task,
): string | undefined {
  if (typeof row[parameter] === "string") return row[parameter] as string;
  const camel = parameter.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (typeof row[camel] === "string") return row[camel] as string;
  if (parameter === "contest_id") {
    const id = row.contestId ?? row.contest_id ?? row.id;
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
  }
  if (typeof row.ref !== "string") return;
  if (
    parameter === "position_ref" &&
    parent.spec.tool === "positions" &&
    (row.symbol || row.positionId)
  )
    return row.ref;
  if (parameter === "purchase_ref" && parent.spec.tool === "purchase") return row.ref;
  if (parameter === "consistency_ref" && parent.spec.tool === "consistency") return row.ref;
}
function discover(job: Job, parent: Task, response: unknown) {
  const candidates = objects(obj(response).data ?? response);
  for (const spec of job.specs) {
    const needed = spec.required.filter((key) => !["account_ref", "account_refs"].includes(key));
    if (needed.length !== 1 || !/(?:_ref|contest_id)$/.test(needed[0]!)) continue;
    const parameter = needed[0]!;
    const eligible =
      parameter === "purchase_ref"
        ? parent.spec.tool === "purchase" && parent.spec.operation === "list"
        : parameter === "position_ref"
          ? parent.spec.tool === "positions" && parent.spec.operation === "list"
          : parameter === "consistency_ref"
            ? parent.spec.tool === "consistency" && parent.spec.operation === "list"
            : parameter === "contest_id"
              ? parent.spec.tool === "contest" &&
                ["upcoming", "mine", "winners"].includes(parent.spec.operation)
              : parameter === "contest_account_ref"
                ? parent.spec.tool === "account" && parent.spec.operation === "list"
                : false;
    if (!eligible) continue;
    for (const [ordinal, row] of candidates.entries()) {
      const ref = reference(row, parameter, parent);
      if (!ref) continue;
      const identity = hash(archiveData(row));
      const subject = hash([parent.subject, parameter, identity, parent.page, ordinal]);
      const args = { [parameter]: ref };
      const child = task(spec, subject, parent.accountIds, args);
      // Key identity must be stable when the provider rotates an opaque reference.
      child.key = hash([spec.tool, spec.operation, subject]);
      child.parent = parent.key;
      child.refIdentity = identity;
      child.refParameter = parameter;
      child.refRetrievedAt = Date.now();
      if (spec.tool === "contest" && spec.operation === "balance_chart") {
        for (const source of ["live", "archived"]) {
          const variant = {
            ...child,
            args: { ...args, source },
            subject: hash([subject, source]),
            key: hash([child.key, source]),
          };
          enqueue(job, variant);
        }
      } else enqueue(job, child);
    }
  }
}
async function savePage(
  connectionId: string,
  item: Task,
  response: unknown,
  runId: string,
  accounts: Account[],
) {
  const data = archiveData(response, new Map(accounts.map((account) => [account.ref, account.id])));
  requireValue(
    Buffer.byteLength(JSON.stringify(data)) <= 4 * 1024 * 1024,
    "The5ers module page exceeded its storage limit.",
  );
  await db.transaction(async (tx) => {
    await assertConnection(connectionId, tx);
    await setSetting(
      `${PREFIX}${item.spec.tool}:${item.spec.operation}:${item.accountIds[0] ?? "global"}:${item.subject}:${item.page}`,
      JSON.stringify({
        tool: item.spec.tool,
        operation: item.spec.operation,
        subject: item.subject,
        accountIds: item.accountIds,
        parent: item.parent,
        sourceIdentity: item.refIdentity,
        page: item.page,
        runId,
        retrievedAt: new Date().toISOString(),
        data,
      }),
      tx,
    );
  });
}
export async function moduleArchiveSummary() {
  const value = await getSetting(SUMMARY);
  return value ? JSON.parse(value) : null;
}
/** Authenticated consumers read archived source data without opening an MCP connection. */
export async function readArchivedModule(
  tool: string,
  operation: string,
  subject = "global",
  accountId?: string,
) {
  requireValue(
    Object.hasOwn(READ_TOOLS, tool) &&
      (READ_TOOLS[tool as ReadTool].operations as readonly string[]).includes(operation),
    "Unknown The5ers module operation.",
  );
  requireValue(
    subject === "global" || /^[a-f0-9]{64}$/.test(subject),
    "Choose a stored account or entity identity.",
  );
  requireValue(!accountId || /^[a-f0-9]{64}$/.test(accountId), "Choose a stored source account.");
  const scope = accountId ?? (subject === "global" ? "global" : "%");
  const rows = await db
    .select()
    .from(settings)
    .where(like(settings.key, `${PREFIX}${tool}:${operation}:${scope}:${subject}:%`));
  const stored = rows.map((row) => JSON.parse(row.value));
  const latestRun = stored
    .map((page) => page.runId ?? "")
    .sort()
    .at(-1);
  const pages = stored
    .filter((page) => (page.runId ?? "") === latestRun)
    .sort((a, b) => a.page - b.page);
  return { tool, operation, subject, available: pages.length > 0, pages };
}
export type ArchiveProjection = (page: {
  tool: ReadTool;
  operation: string;
  subject: string;
  runId: string;
  response: unknown;
}) => Promise<unknown>;
async function runModuleArchive(
  client: The5ersMcp,
  connectionId: string,
  accounts: Account[],
  batchSize = 16,
  project?: ArchiveProjection,
) {
  const stored = await getSetting(JOB);
  let job: Job | undefined;
  if (stored) {
    const decoded = decryptJson<Omit<Job, "tasks"> & { tasks: StoredTask[] }>(stored);
    job = {
      ...decoded,
      tasks: decoded.tasks.map((item) => {
        const spec = decoded.specs.find(
          (spec) => `${spec.tool}.${spec.operation}` === item.specKey,
        );
        requireValue(spec, "The saved module sync contract is unavailable.");
        return { ...item, spec };
      }),
    };
  }
  if (
    !job ||
    job.connectionId !== connectionId ||
    (job.finishedAt && Date.now() - Date.parse(job.finishedAt) >= 15 * 60_000)
  ) {
    const catalogue = await client.payoutContract(true);
    const parsed = specsFrom(catalogue.tools);
    job = {
      connectionId,
      startedAt: new Date().toISOString(),
      specs: parsed.specs,
      tasks: [],
      unsupported: parsed.unsupported,
    };
    await db.transaction(async (tx) => {
      await assertConnection(connectionId, tx);
      await setSetting(
        `${PREFIX}catalogue:tools:global:1`,
        JSON.stringify({ retrievedAt: job!.startedAt, data: catalogue }),
        tx,
      );
    });
    for (const spec of job.specs) {
      if (!spec.required.length) enqueue(job, task(spec, "global"));
      else if (spec.required.every((key) => ["account_ref", "view"].includes(key))) {
        for (const account of accounts) enqueue(job, task(spec, account.id, [account.id]));
      } else if (spec.required.every((key) => key === "account_refs")) {
        for (let index = 0; index < accounts.length; index += 5) {
          const group = accounts.slice(index, index + 5);
          if (group.length === 1 && index > 0) group.unshift(accounts[index - 1]!);
          if (group.length >= 2)
            enqueue(
              job,
              task(
                spec,
                hash(group.map((a) => a.id)),
                group.map((a) => a.id),
              ),
            );
        }
      } else if (
        !spec.required.every((key) => key === "account_ref" || /(?:_ref|contest_id)$/.test(key))
      )
        job.unsupported.push(
          `${READ_TOOLS[spec.tool].name}.${spec.operation}: required inputs unavailable`,
        );
    }
  }
  const current = job;
  // A later inventory page may reveal accounts that were unavailable when the job began.
  for (const spec of current.specs.filter(
    (spec) =>
      spec.required.includes("account_ref") &&
      spec.required.every((key) => ["account_ref", "view"].includes(key)),
  )) {
    for (const account of accounts) enqueue(current, task(spec, account.id, [account.id]));
  }
  if (current.tasks.some((item) => item.state !== "saved")) delete current.finishedAt;
  // Failed reads remain retryable; successful pages are never removed by a failure.
  const waiting = current.tasks
    .filter((t) => t.state === "pending")
    .sort((a, b) => Number(Boolean(b.parent)) - Number(Boolean(a.parent)));
  const retry = current.tasks
    .filter((t) => t.state === "failed" || t.projectionError)
    .sort((a, b) => (a.attemptedAt ?? 0) - (b.attemptedAt ?? 0));
  const queue = [...waiting, ...retry].slice(0, batchSize);
  let processed = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        item.attemptedAt = Date.now();
        const wasSaved = item.state === "saved";
        const hadProjectionError = Boolean(item.projectionError);
        try {
          if (item.parent && Date.now() - (item.refRetrievedAt ?? 0) >= 5 * 60_000) {
            const parent = current.tasks.find((t) => t.key === item.parent);
            requireValue(parent, "The source record for this detail is unavailable.");
            const refreshed = await client.read(
              parent.spec.tool,
              parent.spec.operation,
              argumentsFor(parent, accounts),
            );
            const matches = objects(obj(refreshed).data ?? refreshed).filter(
              (row) => hash(archiveData(row)) === item.refIdentity,
            );
            requireValue(
              matches.length === 1,
              "The source detail reference cannot be renewed without an unambiguous record identity.",
            );
            const ref = reference(matches[0]!, item.refParameter!, parent);
            requireValue(ref, "The source record changed; its saved data was retained.");
            item.args[item.refParameter!] = ref;
            item.refRetrievedAt = Date.now();
          }
          const response = await client.read(
            item.spec.tool,
            item.spec.operation,
            argumentsFor(item, accounts),
          );
          await savePage(connectionId, item, response, current.startedAt, accounts);
          if (project) {
            try {
              await project({
                tool: item.spec.tool,
                operation: item.spec.operation,
                subject: item.subject,
                runId: current.startedAt,
                response,
              });
              delete item.projectionError;
            } catch {
              item.projectionError = "Native trade import failed; the source response was saved.";
            }
          }
          discover(current, item, response);
          const pagination = obj(obj(response).pagination);
          if (pagination.has_more === true && Object.hasOwn(item.spec.properties, "page")) {
            requireValue(
              item.page < 1000,
              "The5ers pagination limit was reached; saved pages were retained.",
            );
            const next = {
              ...item,
              page: item.page + 1,
              key: hash([item.spec.tool, item.spec.operation, item.subject, item.page + 1]),
              state: "pending" as const,
            };
            enqueue(current, next);
          }
          item.state = "saved";
          delete item.error;
          if (!wasSaved || (hadProjectionError && !item.projectionError)) processed++;
        } catch {
          item.state = "failed";
          item.error = "Source read failed; previously saved data was retained.";
        }
      }
    }),
  );
  const saved = current.tasks.filter((t) => t.state === "saved").length;
  const failed = current.tasks.filter((t) => t.state === "failed" || t.projectionError).length;
  const projectionFailed = current.tasks.filter((item) => item.projectionError).length;
  const remaining = current.tasks.filter(
    (item) => item.state !== "saved" || item.projectionError,
  ).length;
  if (!remaining) current.finishedAt ??= new Date().toISOString();
  const summary = {
    complete: remaining === 0 && !current.unsupported.length,
    saved,
    total: current.tasks.length,
    remaining,
    failed,
    projectionFailed,
    processed,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt,
    unsupported: current.unsupported,
    modules: Object.fromEntries(
      current.specs.map((spec) => [
        spec.tool,
        {
          saved: current.tasks.filter((t) => t.spec.tool === spec.tool && t.state === "saved")
            .length,
          total: current.tasks.filter((t) => t.spec.tool === spec.tool).length,
        },
      ]),
    ),
  };
  await db.transaction(async (tx) => {
    await assertConnection(connectionId, tx);
    await setSetting(
      JOB,
      encryptJson({
        ...current,
        tasks: current.tasks.map(({ spec, ...item }) => ({
          ...item,
          specKey: `${spec.tool}.${spec.operation}`,
        })),
      }),
      tx,
    );
    await setSetting(SUMMARY, JSON.stringify(summary), tx);
  });
  return summary;
}

/** Only one resumable writer advances the queue at a time. No network call holds a DB lock. */
export async function syncModuleArchive(
  client: The5ersMcp,
  connectionId: string,
  accounts: Account[],
  batchSize = 16,
  project?: ArchiveProjection,
) {
  const key = "the5ers:module-sync-lease";
  const token = randomUUID();
  const acquired = await db.transaction(async (tx) => {
    await assertConnection(connectionId, tx);
    await tx.insert(settings).values({ key, value: "{}" }).onConflictDoNothing();
    const [row] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
    const lease = JSON.parse(row!.value);
    if (lease.until > Date.now()) return false;
    await setSetting(key, JSON.stringify({ token, until: Date.now() + 120_000 }), tx);
    return true;
  });
  if (!acquired)
    return {
      complete: false,
      saved: 0,
      total: 0,
      remaining: 0,
      failed: 0,
      ...(await moduleArchiveSummary()),
      busy: true,
      processed: 0,
    };
  try {
    return await runModuleArchive(client, connectionId, accounts, batchSize, project);
  } finally {
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(settings).where(eq(settings.key, key)).for("update");
      if (JSON.parse(row?.value ?? "{}").token === token) await setSetting(key, "{}", tx);
    });
  }
}
