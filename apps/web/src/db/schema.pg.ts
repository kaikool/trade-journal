import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
/** PostgreSQL target schema for Supabase. Keep names aligned with the SQLite schema. */
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  broker: text("broker").notNull().default(""),
  kind: text("kind", { enum: ["sync", "import", "manual"] }).notNull(),
  currency: text("currency").notNull().default("USD"),
  initialBalance: doublePrecision("initial_balance").notNull().default(0),
  profitCalcMethod: text("profit_calc_method", { enum: ["fifo", "lifo", "wavg"] })
    .notNull()
    .default("fifo"),
  credentialsEnc: text("credentials_enc"),
  autoSync: boolean("auto_sync").notNull().default(false),
  lastSyncAt: text("last_sync_at"),
  ibkrSyncTimeZone: text("ibkr_sync_time_zone"),
  snapshotJson: text("snapshot_json"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
}).enableRLS();
export const importSources = pgTable("import_sources", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  format: text("format").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
}).enableRLS();
export const importSourceAliases = pgTable(
  "import_source_aliases",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    aliasKey: text("alias_key").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => importSources.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("import_source_alias_unique").on(table.accountId, table.format, table.aliasKey),
  ],
).enableRLS();
export const importBatches = pgTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    fingerprint: text("fingerprint").notNull(),
    rawHash: text("raw_hash").notNull(),
    timeZone: text("time_zone").notNull(),
    sourceIdsJson: text("source_ids_json").notNull(),
    fromTime: text("from_time").notNull(),
    toTime: text("to_time").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("import_batch_unique").on(table.accountId, table.format, table.fingerprint),
  ],
).enableRLS();
export const executions = pgTable(
  "executions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    quantity: doublePrecision("quantity").notNull(),
    price: doublePrecision("price").notNull(),
    fee: doublePrecision("fee").notNull().default(0),
    executedAt: text("executed_at").notNull(),
    assetClass: text("asset_class"),
    source: text("source", { enum: ["sync", "import", "manual"] }).notNull(),
    importMetadataJson: text("import_metadata_json"),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("executions_account_hash").on(table.accountId, table.contentHash),
    index("executions_account_symbol").on(table.accountId, table.symbol),
  ],
).enableRLS();
export const trades = pgTable(
  "trades",
  {
    key: text("key").primaryKey(),
    accountId: text("account_id").notNull(),
    symbol: text("symbol").notNull(),
    assetClass: text("asset_class"),
    direction: text("direction", { enum: ["long", "short"] }).notNull(),
    status: text("status", { enum: ["open", "win", "loss", "breakeven"] }).notNull(),
    openedAt: text("opened_at").notNull(),
    closedAt: text("closed_at"),
    quantity: doublePrecision("quantity").notNull(),
    openQuantity: doublePrecision("open_quantity").notNull(),
    avgEntry: doublePrecision("avg_entry").notNull(),
    avgExit: doublePrecision("avg_exit"),
    grossPnl: doublePrecision("gross_pnl").notNull(),
    fees: doublePrecision("fees").notNull(),
    netPnl: doublePrecision("net_pnl").notNull(),
    executionCount: integer("execution_count").notNull(),
    executionIdsJson: text("execution_ids_json").notNull(),
    exitsJson: text("exits_json").notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    notes: text("notes"),
    tagsJson: text("tags_json"),
    mistakesJson: text("mistakes_json"),
    playbookId: text("playbook_id"),
    rating: integer("rating"),
    stopLoss: doublePrecision("stop_loss"),
    profitTarget: doublePrecision("profit_target"),
    reviewedAt: text("reviewed_at"),
  },
  (table) => [
    index("trades_account_closed").on(table.accountId, table.closedAt),
    index("trades_symbol").on(table.symbol),
    index("trades_opened").on(table.openedAt),
    index("trades_account_opened").on(table.accountId, table.openedAt),
  ],
).enableRLS();
export const journalDays = pgTable("journal_days", {
  date: text("date").primaryKey(),
  note: text("note").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
}).enableRLS();
export const folders = pgTable("folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["system", "user"] })
    .notNull()
    .default("user"),
  createdAt: text("created_at").notNull(),
  deletedAt: text("deleted_at"),
}).enableRLS();
export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    folderId: text("folder_id").notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull().default(""),
    tagsJson: text("tags_json"),
    tradeKey: text("trade_key"),
    dayDate: text("day_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("notes_folder").on(table.folderId)],
).enableRLS();
export const playbooks = pgTable("playbooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  rulesJson: text("rules_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
}).enableRLS();
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
}).enableRLS();
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storagePath: text("storage_path").notNull(),
    status: text("status", { enum: ["pending", "ready"] })
      .notNull()
      .default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("attachments_owner").on(table.ownerType, table.ownerId),
    uniqueIndex("attachments_storage_path_unique").on(table.storagePath),
  ],
).enableRLS();
export const noteTemplates = pgTable("note_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  content: text("content").notNull(),
}).enableRLS();
export const tradeRuleChecks = pgTable(
  "trade_rule_checks",
  {
    id: text("id").primaryKey(),
    tradeKey: text("trade_key").notNull(),
    playbookId: text("playbook_id").notNull(),
    rule: text("rule").notNull(),
    followed: boolean("followed").notNull(),
  },
  (table) => [index("trade_rule_checks_trade").on(table.tradeKey)],
).enableRLS();
export const progressRules = pgTable("progress_rules", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  stage: text("stage").notNull(),
  weekdaysJson: text("weekdays_json").notNull(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
}).enableRLS();
export const progressChecks = pgTable(
  "progress_checks",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    date: text("date").notNull(),
    done: boolean("done").notNull(),
  },
  (table) => [index("progress_checks_date").on(table.date)],
).enableRLS();
export const missedTrades = pgTable("missed_trades", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  observedAt: text("observed_at").notNull(),
  playbookId: text("playbook_id"),
  entry: doublePrecision("entry"),
  stop: doublePrecision("stop"),
  target: doublePrecision("target"),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
}).enableRLS();
export const marketCsvDatasets = pgTable(
  "market_csv_datasets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    resolution: text("resolution").notNull(),
    currency: text("currency").notNull(),
    priceBasis: text("price_basis").notNull(),
    storagePath: text("storage_path").notNull(),
    checksum: text("checksum").notNull(),
    formatVersion: integer("format_version").notNull().default(1),
    barCount: integer("bar_count").notNull(),
    firstTime: bigint("first_time", { mode: "number" }).notNull(),
    lastTime: bigint("last_time", { mode: "number" }).notNull(),
    importedAt: text("imported_at").notNull(),
  },
  (table) => [
    index("market_csv_symbol_resolution").on(table.symbol, table.resolution),
    uniqueIndex("market_csv_storage_path_unique").on(table.storagePath),
  ],
).enableRLS();
export const tradeExcursions = pgTable("trade_excursions", {
  tradeKey: text("trade_key")
    .primaryKey()
    .references(() => trades.key, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  provider: text("provider").notNull(),
  symbol: text("symbol").notNull(),
  resolution: text("resolution").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  datasetId: text("dataset_id").references(() => marketCsvDatasets.id, { onDelete: "cascade" }),
  estimateJson: text("estimate_json").notNull(),
}).enableRLS();
export const propAccounts = pgTable("prop_accounts", {
  id: text("id").primaryKey(),
  firm: text("firm").notNull(),
  name: text("name").notNull(),
  program: text("program").notNull(),
  status: text("status").notNull(),
  currency: text("currency").notNull(),
  sizeMinor: bigint("size_minor", { mode: "number" }),
  parentId: text("parent_id").references((): AnyPgColumn => propAccounts.id),
  journalAccountId: text("journal_account_id").references(() => accounts.id, {
    onDelete: "set null",
  }),
  openedOn: text("opened_on").notNull(),
  closedOn: text("closed_on"),
  renewalOn: text("renewal_on"),
  renewalMinor: bigint("renewal_minor", { mode: "number" }),
  notes: text("notes").notNull().default(""),
  archived: boolean("archived").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}).enableRLS();
export const propEntries = pgTable(
  "prop_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").references(() => propAccounts.id),
    firm: text("firm").notNull(),
    kind: text("kind").notNull(),
    category: text("category").notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    splitBps: integer("split_bps").notNull(),
    feeMinor: bigint("fee_minor", { mode: "number" }).notNull(),
    occurredOn: text("occurred_on").notNull(),
    dueOn: text("due_on"),
    status: text("status").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => propEntries.id),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    voided: boolean("voided").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("prop_entries_account_date").on(table.accountId, table.occurredOn),
    index("prop_entries_date").on(table.occurredOn),
  ],
).enableRLS();
export const propReceipts = pgTable(
  "prop_receipts",
  {
    id: text("id").primaryKey(),
    payoutId: text("payout_id")
      .notNull()
      .references(() => propEntries.id),
    kind: text("kind").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    occurredOn: text("occurred_on").notNull(),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    voided: boolean("voided").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("prop_receipts_payout").on(table.payoutId)],
).enableRLS();
export const propAudit = pgTable(
  "prop_audit",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json").notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("prop_audit_entity").on(table.entityType, table.entityId)],
).enableRLS();
