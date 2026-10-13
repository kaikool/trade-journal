#!/usr/bin/env node
/**
 * CLI Migration Tool: SQLite (journal.db) -> Supabase (PostgreSQL + Supabase Storage)
 */

import { isEncryptedSetting, reencryptEnvelope } from "./encrypted-settings.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Resolve packages from apps/web if not available in current root
const webRequire = createRequire(resolve(process.cwd(), "apps/web/package.json"));
const postgres = webRequire("postgres") as typeof import("postgres");
const { createClient } = webRequire(
  "@supabase/supabase-js",
) as typeof import("@supabase/supabase-js");

interface CliArgs {
  sqlitePath: string;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  targetSecret: string;
  legacySecretFile: string;
  dryRun: boolean;
  force: boolean;
  skipStorage: boolean;
  verbose: boolean;
}

function cleanUrl(url?: string): string {
  if (!url) return "";
  return url
    .replace(/^@url:\s*/i, "")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/`+/g, "")
    .trim();
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Trade Journal: SQLite -> Supabase Migration CLI

Options:
  --sqlite <path>             Path to SQLite file (default: ./data/journal.db or ./apps/web/data/journal.db)
  --database-url <url>        Target DATABASE_URL (or DIRECT_DATABASE_URL)
  --supabase-url <url>        Target SUPABASE_URL
  --supabase-key <key>        Target SUPABASE_SERVICE_ROLE_KEY
  --secret <secret>           Target JOURNAL_SECRET
  --legacy-secret-file <path> Path to old .secret file (default: ./data/.secret if exists)
  --dry-run                   Simulate migration and print parity report without writing
  --force                     Reserved; rejected to prevent overwriting existing journal records
  --skip-storage              Skip uploading binaries to Supabase Storage
  --verbose                   Show verbose debug logging
  --help                      Show this help message
`);
    process.exit(0);
  }

  const defaultSqlite = existsSync("./data/journal.db")
    ? "./data/journal.db"
    : existsSync("./apps/web/data/journal.db")
      ? "./apps/web/data/journal.db"
      : "./data/journal.db";

  const defaultLegacySecret = existsSync("./data/.secret")
    ? "./data/.secret"
    : existsSync("./apps/web/data/.secret")
      ? "./apps/web/data/.secret"
      : "";

  return {
    sqlitePath: getArg("--sqlite") ?? process.env.JOURNAL_SQLITE_PATH ?? defaultSqlite,
    databaseUrl: cleanUrl(
      getArg("--database-url") ?? process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
    ),
    supabaseUrl: cleanUrl(getArg("--supabase-url") ?? process.env.SUPABASE_URL),
    supabaseKey: cleanUrl(getArg("--supabase-key") ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""),
    targetSecret: getArg("--secret") ?? process.env.JOURNAL_SECRET ?? "",
    legacySecretFile: getArg("--legacy-secret-file") ?? defaultLegacySecret,
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    skipStorage: args.includes("--skip-storage"),
    verbose: args.includes("--verbose"),
  };
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function topoSort<T extends { id: string; parent_id?: string | null }>(items: T[]): T[] {
  const result: T[] = [];
  const inserted = new Set<string>();
  let remaining = [...items];
  while (remaining.length > 0) {
    const nextBatch = remaining.filter((item) => !item.parent_id || inserted.has(item.parent_id));
    if (nextBatch.length === 0) {
      result.push(...remaining);
      break;
    }
    for (const item of nextBatch) {
      result.push(item);
      inserted.add(item.id);
    }
    const nextIds = new Set(nextBatch.map((i) => i.id));
    remaining = remaining.filter((item) => !nextIds.has(item.id));
  }
  return result;
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, "luxalgo-trade-journal", 32);
}

async function main() {
  const config = parseArgs();
  if (config.force)
    throw new Error(
      "--force is not supported. Migrate into an empty target or reconcile conflicts explicitly.",
    );

  // Smart resolution of SQLite database location
  let sqlitePath = config.sqlitePath;
  if (!existsSync(sqlitePath)) {
    const candidates = [
      resolve(process.cwd(), "apps/web/data/journal.db"),
      resolve(process.cwd(), "data/journal.db"),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (found) {
      console.log(`  [Notice] "${sqlitePath}" not found. Auto-detected database at: "${found}"`);
      sqlitePath = found;
    } else {
      console.error(`\nError: Source SQLite database not found at "${config.sqlitePath}".`);
      process.exit(1);
    }
  }

  console.log("=== Trade Journal: SQLite to Supabase Migration ===");
  console.log(`Source SQLite:   ${sqlitePath}`);
  console.log(
    `Mode:            ${config.dryRun ? "DRY RUN (Read-only simulation)" : "LIVE MIGRATION"}`,
  );
  console.log(
    `Target Postgres: ${config.databaseUrl ? config.databaseUrl.replace(/:[^:@]+@/, ":***@") : "(Not set)"}`,
  );
  console.log(`Target Storage:  ${config.supabaseUrl || "(Not set)"}`);

  if (!config.dryRun && !config.databaseUrl) {
    console.error(
      "\nError: Destination --database-url (or DATABASE_URL) is required for live migration.",
    );
    process.exit(1);
  }

  // Open SQLite database read-only
  const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true });

  const queryAll = (table: string): any[] => {
    try {
      return sqliteDb.prepare(`SELECT * FROM "${table}"`).all();
    } catch {
      return [];
    }
  };

  const countTable = (table: string): number => {
    try {
      const row = sqliteDb.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as any;
      return Number(row?.c ?? row?.[0] ?? 0);
    } catch {
      return 0;
    }
  };

  // Inspect source tables
  const TABLES = [
    "accounts",
    "import_sources",
    "import_source_aliases",
    "import_batches",
    "executions",
    "playbooks",
    "trades",
    "journal_days",
    "folders",
    "notes",
    "note_templates",
    "trade_rule_checks",
    "progress_rules",
    "progress_checks",
    "missed_trades",
    "attachments",
    "market_csv_datasets",
    "trade_excursions",
    "prop_accounts",
    "prop_entries",
    "prop_receipts",
    "prop_audit",
    "settings",
  ];

  console.log("\nInspecting source SQLite database...");
  const sourceCounts: Record<string, number> = {};
  for (const table of TABLES) {
    sourceCounts[table] = countTable(table);
  }

  let totalSourceRows = 0;
  for (const [table, count] of Object.entries(sourceCounts)) {
    if (count > 0 && config.verbose) console.log(`  - ${table}: ${count} rows`);
    totalSourceRows += count;
  }
  console.log(`Found ${totalSourceRows} total records across ${TABLES.length} tables.`);

  // Setup encryption keys
  let sourceKey: Buffer | null = null;
  let targetKey: Buffer | null = null;
  if (config.legacySecretFile && existsSync(config.legacySecretFile)) {
    try {
      sourceKey = Buffer.from(readFileSync(config.legacySecretFile, "utf8").trim(), "hex");
      console.log(`  Loaded legacy secret key from ${config.legacySecretFile}`);
    } catch (e) {
      console.warn(`  Could not read legacy secret file: ${(e as Error).message}`);
    }
  }
  if (config.targetSecret) {
    targetKey = deriveKey(config.targetSecret);
  }

  const hasEncryptedData =
    queryAll("accounts").some((row) => row.credentials_enc) ||
    queryAll("settings").some((row) => isEncryptedSetting(row.key) && row.value);
  if (!config.dryRun && hasEncryptedData && (!sourceKey || sourceKey.length !== 32 || !targetKey))
    throw new Error(
      "Encrypted credentials require a valid legacy secret file and target JOURNAL_SECRET before migration.",
    );
  const shouldReencrypt = sourceKey && targetKey && !sourceKey.equals(targetKey);
  if (shouldReencrypt) {
    console.log("  Re-encryption active: credentials will be converted to target JOURNAL_SECRET.");
  }

  if (config.dryRun) {
    console.log("\n[DRY RUN] Parity check report (source inspection only):");
    console.table(
      Object.entries(sourceCounts).map(([table, count]) => ({
        Table: table,
        "Source Rows": count,
        Status: count > 0 ? "Ready to migrate" : "Empty",
      })),
    );
    console.log("\nDry run completed successfully. No records were written.");
    process.exit(0);
  }

  // Live migration: Connect to PostgreSQL
  const sql = postgres(config.databaseUrl, {
    max: 1,
    ssl: "require",
    prepare: false,
    connect_timeout: 15,
  });

  // Supabase Storage client
  const ATTACHMENT_BUCKET = "journal-attachments";
  let supabaseStorage: any = null;
  if (!config.skipStorage && config.supabaseUrl && config.supabaseKey) {
    const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    supabaseStorage = supabase.storage;
    console.log(`  Connected to Supabase Storage at ${config.supabaseUrl}`);
  } else if (!config.skipStorage) {
    console.log("  Storage credentials omitted; skipping binary uploads to Supabase Storage.");
  }

  if (!supabaseStorage && (sourceCounts.attachments! > 0 || sourceCounts.market_csv_datasets! > 0))
    throw new Error(
      "Source contains attachments or candles. Configure Supabase Storage before migration; --skip-storage cannot migrate these records safely.",
    );
  const uploadedPaths: string[] = [];
  try {
    await sql.begin(async (transaction) => {
      const sql = transaction;
      // 1. Verify destination connection
      await sql`SELECT 1`;
      console.log("\nConnected to destination PostgreSQL database.");

      // Prevent another writer changing the target between the empty check and inserts.
      for (const table of [...TABLES].sort())
        await sql`LOCK TABLE ${sql(table)} IN SHARE ROW EXCLUSIVE MODE`;
      // 2. Check existing target row counts
      const destCountsBefore: Record<string, number> = {};
      for (const table of TABLES) {
        try {
          const [res] = await sql<
            { count: string }[]
          >`SELECT COUNT(*)::text as count FROM ${sql(table)}`;
          destCountsBefore[table] = Number(res?.count ?? 0);
        } catch {
          throw new Error(
            `Target schema is missing or inaccessible: ${table}. Apply migrations first.`,
          );
        }
      }

      const targetHasData = Object.values(destCountsBefore).some((c) => c > 0);
      if (targetHasData && !config.force) {
        throw new Error(
          "Target database must be empty. Back it up and use a separate migration target.",
        );
      }

      console.log("\nMigrating tables in dependency order...");

      // Helper to insert a batch of records
      const insertBatch = async (table: string, rows: Record<string, any>[]) => {
        if (rows.length === 0) return;
        const CHUNK_SIZE = 250;
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          const chunk = rows.slice(i, i + CHUNK_SIZE);
          await sql`
          INSERT INTO ${sql(table)} ${sql(chunk)}
        `;
        }
      };

      // 1. ACCOUNTS
      const rawAccounts = queryAll("accounts");
      const migratedAccounts = rawAccounts.map((row) => {
        let credentialsEnc = row.credentials_enc;
        if (credentialsEnc && shouldReencrypt) {
          credentialsEnc = reencryptEnvelope(credentialsEnc, sourceKey!, targetKey!);
        }
        return {
          id: row.id,
          name: row.name,
          broker: row.broker ?? "",
          kind: row.kind,
          currency: row.currency ?? "USD",
          initial_balance: Number(row.initial_balance ?? 0),
          profit_calc_method: row.profit_calc_method ?? "fifo",
          credentials_enc: credentialsEnc,
          auto_sync: Boolean(row.auto_sync),
          last_sync_at: row.last_sync_at,
          ibkr_sync_time_zone: row.ibkr_sync_time_zone,
          snapshot_json: row.snapshot_json,
          archived_at: row.archived_at,
          created_at: row.created_at,
        };
      });
      await insertBatch("accounts", migratedAccounts);
      if (config.verbose) console.log(`  -> accounts: ${migratedAccounts.length} rows migrated`);

      // 2. IMPORT_SOURCES
      await insertBatch("import_sources", queryAll("import_sources"));

      // 3. IMPORT_SOURCE_ALIASES
      await insertBatch("import_source_aliases", queryAll("import_source_aliases"));

      // 4. IMPORT_BATCHES
      await insertBatch("import_batches", queryAll("import_batches"));

      // 5. EXECUTIONS
      const rawExecutions = queryAll("executions").map((row) => ({
        id: row.id,
        account_id: row.account_id,
        symbol: row.symbol,
        side: row.side,
        quantity: Number(row.quantity),
        price: Number(row.price),
        fee: Number(row.fee ?? 0),
        executed_at: row.executed_at,
        asset_class: row.asset_class,
        source: row.source,
        import_metadata_json: row.import_metadata_json,
        content_hash: row.content_hash,
        created_at: row.created_at,
      }));
      await insertBatch("executions", rawExecutions);
      if (config.verbose) console.log(`  -> executions: ${rawExecutions.length} rows migrated`);

      // 6. PLAYBOOKS
      await insertBatch("playbooks", queryAll("playbooks"));

      // 7. TRADES
      const rawTrades = queryAll("trades").map((row) => ({
        key: row.key,
        account_id: row.account_id,
        symbol: row.symbol,
        asset_class: row.asset_class,
        direction: row.direction,
        status: row.status,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        quantity: Number(row.quantity),
        open_quantity: Number(row.open_quantity),
        avg_entry: Number(row.avg_entry),
        avg_exit: row.avg_exit !== null ? Number(row.avg_exit) : null,
        gross_pnl: Number(row.gross_pnl),
        fees: Number(row.fees),
        net_pnl: Number(row.net_pnl),
        execution_count: Number(row.execution_count),
        execution_ids_json: row.execution_ids_json,
        exits_json: row.exits_json,
        duration_ms: row.duration_ms !== null ? Number(row.duration_ms) : null,
        notes: row.notes,
        tags_json: row.tags_json,
        mistakes_json: row.mistakes_json,
        playbook_id: row.playbook_id,
        rating: row.rating !== null ? Number(row.rating) : null,
        stop_loss: row.stop_loss !== null ? Number(row.stop_loss) : null,
        profit_target: row.profit_target !== null ? Number(row.profit_target) : null,
        reviewed_at: row.reviewed_at,
      }));
      await insertBatch("trades", rawTrades);
      if (config.verbose) console.log(`  -> trades: ${rawTrades.length} rows migrated`);

      // 8. JOURNAL_DAYS
      await insertBatch("journal_days", queryAll("journal_days"));

      // 9. FOLDERS
      await insertBatch("folders", queryAll("folders"));

      // 10. NOTES
      await insertBatch("notes", queryAll("notes"));

      // 11. NOTE_TEMPLATES
      await insertBatch("note_templates", queryAll("note_templates"));

      // 12. TRADE_RULE_CHECKS
      const rawRuleChecks = queryAll("trade_rule_checks").map((row) => ({
        id: row.id,
        trade_key: row.trade_key,
        playbook_id: row.playbook_id,
        rule: row.rule,
        followed: Boolean(row.followed),
      }));
      await insertBatch("trade_rule_checks", rawRuleChecks);

      // 13. PROGRESS_RULES
      await insertBatch("progress_rules", queryAll("progress_rules"));

      // 14. PROGRESS_CHECKS
      const rawProgressChecks = queryAll("progress_checks").map((row) => ({
        id: row.id,
        rule_id: row.rule_id,
        date: row.date,
        done: Boolean(row.done),
      }));
      await insertBatch("progress_checks", rawProgressChecks);

      // 15. MISSED_TRADES
      const rawMissedTrades = queryAll("missed_trades").map((row) => ({
        id: row.id,
        symbol: row.symbol,
        direction: row.direction,
        observed_at: row.observed_at,
        playbook_id: row.playbook_id,
        entry: row.entry !== null ? Number(row.entry) : null,
        stop: row.stop !== null ? Number(row.stop) : null,
        target: row.target !== null ? Number(row.target) : null,
        notes: row.notes ?? "",
        created_at: row.created_at,
        archived_at: row.archived_at,
      }));
      await insertBatch("missed_trades", rawMissedTrades);

      // 16. ATTACHMENTS (Storage + Postgres)
      const rawAttachments = queryAll("attachments");
      let attachmentUploadCount = 0;
      const migratedAttachments = [];
      for (const row of rawAttachments) {
        const storagePath = `attachments/${row.id}`;
        const data = row.data ? Buffer.from(row.data) : null;
        if (data && supabaseStorage) {
          const { error } = await supabaseStorage
            .from(ATTACHMENT_BUCKET)
            .upload(storagePath, data, { contentType: row.mime, upsert: false });
          if (error) throw new Error(`Attachment ${row.id} could not be uploaded.`);
          uploadedPaths.push(storagePath);
          attachmentUploadCount++;
        }
        migratedAttachments.push({
          id: row.id,
          owner_type: row.owner_type,
          owner_id: row.owner_id,
          name: row.name,
          mime: row.mime,
          size: Number(row.size ?? data?.length ?? 0),
          storage_path: storagePath,
          status: "ready",
          created_at: row.created_at,
        });
      }
      await insertBatch("attachments", migratedAttachments);
      if (attachmentUploadCount > 0) {
        console.log(
          `  -> attachments: ${attachmentUploadCount} binaries uploaded to Supabase Storage`,
        );
      }

      // 17. MARKET_CSV_DATASETS (Storage + Postgres)
      const rawDatasets = queryAll("market_csv_datasets");
      let datasetUploadCount = 0;
      const migratedDatasets = [];
      for (const row of rawDatasets) {
        const storagePath = `datasets/${row.id}`;
        const barsJson = row.bars_json ?? "[]";
        const checksum = sha256(barsJson);
        if (supabaseStorage) {
          const { error } = await supabaseStorage
            .from(ATTACHMENT_BUCKET)
            .upload(storagePath, Buffer.from(barsJson, "utf8"), {
              contentType: "application/json",
              upsert: false,
            });
          if (error) throw new Error(`Dataset ${row.id} could not be uploaded.`);
          uploadedPaths.push(storagePath);
          datasetUploadCount++;
        }
        migratedDatasets.push({
          id: row.id,
          name: row.name,
          symbol: row.symbol,
          resolution: row.resolution,
          currency: row.currency,
          price_basis: row.price_basis,
          storage_path: storagePath,
          checksum,
          format_version: 1,
          bar_count: Number(row.bar_count ?? 0),
          first_time: Number(row.first_time ?? 0),
          last_time: Number(row.last_time ?? 0),
          imported_at: row.imported_at,
        });
      }
      await insertBatch("market_csv_datasets", migratedDatasets);

      // 18. TRADE_EXCURSIONS
      const datasetIds = new Set(migratedDatasets.map((d) => d.id));
      const rawExcursions = queryAll("trade_excursions").map((row) => {
        let datasetId: string | null = null;
        try {
          const est = JSON.parse(row.estimate_json);
          if (est.datasetId && datasetIds.has(est.datasetId)) datasetId = est.datasetId;
        } catch {}
        return {
          trade_key: row.trade_key,
          fingerprint: row.fingerprint,
          provider: row.provider,
          symbol: row.symbol,
          resolution: row.resolution,
          fetched_at: row.fetched_at,
          dataset_id: datasetId,
          estimate_json: row.estimate_json,
        };
      });
      await insertBatch("trade_excursions", rawExcursions);

      // 19. PROP_ACCOUNTS (topological sort for parent_id)
      const rawPropAccounts = topoSort(
        queryAll("prop_accounts").map((row) => ({
          id: row.id,
          firm: row.firm,
          name: row.name,
          program: row.program,
          status: row.status,
          currency: row.currency,
          size_minor: row.size_minor !== null ? Number(row.size_minor) : null,
          parent_id: row.parent_id,
          journal_account_id: row.journal_account_id,
          opened_on: row.opened_on,
          closed_on: row.closed_on,
          renewal_on: row.renewal_on,
          renewal_minor: row.renewal_minor !== null ? Number(row.renewal_minor) : null,
          notes: row.notes ?? "",
          archived: Boolean(row.archived),
          revision: Number(row.revision ?? 1),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      );
      await insertBatch("prop_accounts", rawPropAccounts);

      // 20. PROP_ENTRIES (topological sort for parent_id)
      const rawPropEntries = topoSort(
        queryAll("prop_entries").map((row) => ({
          id: row.id,
          account_id: row.account_id,
          firm: row.firm,
          kind: row.kind,
          category: row.category,
          currency: row.currency,
          amount_minor: Number(row.amount_minor),
          split_bps: Number(row.split_bps),
          fee_minor: Number(row.fee_minor),
          occurred_on: row.occurred_on,
          due_on: row.due_on,
          status: row.status,
          parent_id: row.parent_id,
          reference: row.reference ?? "",
          notes: row.notes ?? "",
          voided: Boolean(row.voided),
          revision: Number(row.revision ?? 1),
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      );
      await insertBatch("prop_entries", rawPropEntries);

      // 21. PROP_RECEIPTS
      const rawPropReceipts = queryAll("prop_receipts").map((row) => ({
        id: row.id,
        payout_id: row.payout_id,
        kind: row.kind,
        amount_minor: Number(row.amount_minor),
        occurred_on: row.occurred_on,
        reference: row.reference ?? "",
        notes: row.notes ?? "",
        voided: Boolean(row.voided),
        created_at: row.created_at,
      }));
      await insertBatch("prop_receipts", rawPropReceipts);

      // 22. PROP_AUDIT
      await insertBatch("prop_audit", queryAll("prop_audit"));

      // 23. SETTINGS
      const rawSettings = queryAll("settings").map((row) => {
        let val = row.value;
        if (isEncryptedSetting(row.key) && shouldReencrypt) {
          val = reencryptEnvelope(val, sourceKey!, targetKey!);
        }
        return { key: row.key, value: val };
      });
      await insertBatch("settings", rawSettings);

      // PARITY VERIFICATION
      console.log("\nVerifying parity between SQLite and PostgreSQL...");
      const destCountsAfter: Record<string, number> = {};
      for (const table of TABLES) {
        const [res] = await sql<
          { count: string }[]
        >`SELECT COUNT(*)::text as count FROM ${sql(table)}`;
        destCountsAfter[table] = Number(res?.count ?? 0);
      }

      const report = TABLES.map((table) => {
        const src = sourceCounts[table] ?? 0;
        const dst = destCountsAfter[table] ?? 0;
        return {
          Table: table,
          "SQLite (Source)": src,
          "Postgres (Destination)": dst,
          Status: src === dst ? "MATCH" : src <= dst ? "MATCH (Target has more)" : "MISMATCH",
        };
      });

      console.table(report);

      const hasMismatch = report.some((r) => r.Status === "MISMATCH");
      if (hasMismatch) {
        throw new Error(
          "Migration parity mismatch. Keep the source database and inspect the target before using it.",
        );
      } else {
        console.log(
          "\nAll table row counts match 100%! Migration to Supabase completed successfully.",
        );
      }
    });
  } catch (error) {
    if (supabaseStorage && uploadedPaths.length) {
      const cleanup = await supabaseStorage.from(ATTACHMENT_BUCKET).remove(uploadedPaths);
      if (cleanup.error)
        console.warn(
          "Storage cleanup failed; remove objects from the failed migration before retrying.",
        );
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
    sqliteDb.close();
  }
}

main().catch((err) => {
  console.error("\nMigration failed with error:", err);
  process.exit(1);
});
