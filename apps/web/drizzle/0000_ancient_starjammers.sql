CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"broker" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"initial_balance" double precision DEFAULT 0 NOT NULL,
	"profit_calc_method" text DEFAULT 'fifo' NOT NULL,
	"credentials_enc" text,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"last_sync_at" text,
	"ibkr_sync_time_zone" text,
	"snapshot_json" text,
	"archived_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" double precision NOT NULL,
	"price" double precision NOT NULL,
	"fee" double precision DEFAULT 0 NOT NULL,
	"executed_at" text NOT NULL,
	"asset_class" text,
	"source" text NOT NULL,
	"import_metadata_json" text,
	"content_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'user' NOT NULL,
	"created_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"fingerprint" text NOT NULL,
	"raw_hash" text NOT NULL,
	"time_zone" text NOT NULL,
	"source_ids_json" text NOT NULL,
	"from_time" text NOT NULL,
	"to_time" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_source_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"alias_key" text NOT NULL,
	"source_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_days" (
	"date" text PRIMARY KEY NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_csv_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"resolution" text NOT NULL,
	"currency" text NOT NULL,
	"price_basis" text NOT NULL,
	"storage_path" text NOT NULL,
	"checksum" text NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"bar_count" integer NOT NULL,
	"first_time" bigint NOT NULL,
	"last_time" bigint NOT NULL,
	"imported_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missed_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"observed_at" text NOT NULL,
	"playbook_id" text,
	"entry" double precision,
	"stop" double precision,
	"target" double precision,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "note_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tags_json" text,
	"trade_key" text,
	"day_date" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"date" text NOT NULL,
	"done" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "progress_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"stage" text NOT NULL,
	"weekdays_json" text NOT NULL,
	"created_at" text NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "prop_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"firm" text NOT NULL,
	"name" text NOT NULL,
	"program" text NOT NULL,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"size_minor" bigint,
	"parent_id" text,
	"journal_account_id" text,
	"opened_on" text NOT NULL,
	"closed_on" text,
	"renewal_on" text,
	"renewal_minor" bigint,
	"notes" text DEFAULT '' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prop_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_json" text,
	"after_json" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prop_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"firm" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"split_bps" integer NOT NULL,
	"fee_minor" bigint NOT NULL,
	"occurred_on" text NOT NULL,
	"due_on" text,
	"status" text NOT NULL,
	"parent_id" text,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"voided" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prop_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"payout_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"occurred_on" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"voided" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_excursions" (
	"trade_key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"provider" text NOT NULL,
	"symbol" text NOT NULL,
	"resolution" text NOT NULL,
	"fetched_at" text NOT NULL,
	"dataset_id" text,
	"estimate_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_rule_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"trade_key" text NOT NULL,
	"playbook_id" text NOT NULL,
	"rule" text NOT NULL,
	"followed" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" text,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" text NOT NULL,
	"closed_at" text,
	"quantity" double precision NOT NULL,
	"open_quantity" double precision NOT NULL,
	"avg_entry" double precision NOT NULL,
	"avg_exit" double precision,
	"gross_pnl" double precision NOT NULL,
	"fees" double precision NOT NULL,
	"net_pnl" double precision NOT NULL,
	"execution_count" integer NOT NULL,
	"execution_ids_json" text NOT NULL,
	"exits_json" text NOT NULL,
	"duration_ms" bigint,
	"notes" text,
	"tags_json" text,
	"mistakes_json" text,
	"playbook_id" text,
	"rating" integer,
	"stop_loss" double precision,
	"profit_target" double precision,
	"reviewed_at" text
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_source_aliases" ADD CONSTRAINT "import_source_aliases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_source_aliases" ADD CONSTRAINT "import_source_aliases_source_id_import_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."import_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prop_accounts" ADD CONSTRAINT "prop_accounts_parent_id_prop_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."prop_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prop_accounts" ADD CONSTRAINT "prop_accounts_journal_account_id_accounts_id_fk" FOREIGN KEY ("journal_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prop_entries" ADD CONSTRAINT "prop_entries_account_id_prop_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."prop_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prop_entries" ADD CONSTRAINT "prop_entries_parent_id_prop_entries_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."prop_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prop_receipts" ADD CONSTRAINT "prop_receipts_payout_id_prop_entries_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."prop_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_excursions" ADD CONSTRAINT "trade_excursions_trade_key_trades_key_fk" FOREIGN KEY ("trade_key") REFERENCES "public"."trades"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_excursions" ADD CONSTRAINT "trade_excursions_dataset_id_market_csv_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."market_csv_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_owner" ON "attachments" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_path_unique" ON "attachments" USING btree ("storage_path");--> statement-breakpoint
CREATE UNIQUE INDEX "executions_account_hash" ON "executions" USING btree ("account_id","content_hash");--> statement-breakpoint
CREATE INDEX "executions_account_symbol" ON "executions" USING btree ("account_id","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batch_unique" ON "import_batches" USING btree ("account_id","format","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "import_source_alias_unique" ON "import_source_aliases" USING btree ("account_id","format","alias_key");--> statement-breakpoint
CREATE INDEX "market_csv_symbol_resolution" ON "market_csv_datasets" USING btree ("symbol","resolution");--> statement-breakpoint
CREATE UNIQUE INDEX "market_csv_storage_path_unique" ON "market_csv_datasets" USING btree ("storage_path");--> statement-breakpoint
CREATE INDEX "notes_folder" ON "notes" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "progress_checks_date" ON "progress_checks" USING btree ("date");--> statement-breakpoint
CREATE INDEX "prop_audit_entity" ON "prop_audit" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "prop_entries_account_date" ON "prop_entries" USING btree ("account_id","occurred_on");--> statement-breakpoint
CREATE INDEX "prop_entries_date" ON "prop_entries" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "prop_receipts_payout" ON "prop_receipts" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "trade_rule_checks_trade" ON "trade_rule_checks" USING btree ("trade_key");--> statement-breakpoint
CREATE INDEX "trades_account_closed" ON "trades" USING btree ("account_id","closed_at");--> statement-breakpoint
CREATE INDEX "trades_symbol" ON "trades" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "trades_opened" ON "trades" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "trades_account_opened" ON "trades" USING btree ("account_id","opened_at");--> statement-breakpoint
INSERT INTO "folders" ("id", "name", "kind", "created_at") VALUES
	('all', 'All notes', 'system', '2026-01-01T00:00:00Z'),
	('trade-notes', 'Trade notes', 'system', '2026-01-01T00:00:00Z'),
	('daily-journal', 'Daily journal', 'system', '2026-01-01T00:00:00Z'),
	('session-recaps', 'Session recaps', 'system', '2026-01-01T00:00:00Z'),
	('my-notes', 'My notes', 'system', '2026-01-01T00:00:00Z')
ON CONFLICT ("id") DO NOTHING;