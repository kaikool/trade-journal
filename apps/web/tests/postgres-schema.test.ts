import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import * as schema from "../src/db/schema.pg";

const config = (table: Parameters<typeof getTableConfig>[0]) => getTableConfig(table);
const columnTypes = (table: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(config(table).columns.map((column) => [column.name, column.getSQLType()]));

describe("Postgres schema", () => {
  it("defines every durable journal table", () => {
    const names = Object.values(schema)
      .map((table) => config(table).name)
      .sort();

    expect(names).toEqual(
      [
        "accounts",
        "attachments",
        "executions",
        "folders",
        "import_batches",
        "import_source_aliases",
        "import_sources",
        "journal_days",
        "market_csv_datasets",
        "missed_trades",
        "note_templates",
        "notes",
        "playbooks",
        "progress_checks",
        "progress_rules",
        "prop_accounts",
        "prop_audit",
        "prop_entries",
        "prop_receipts",
        "settings",
        "trade_excursions",
        "trade_rule_checks",
        "trades",
      ].sort(),
    );
  });

  it("preserves numeric semantics and uses native booleans", () => {
    expect(columnTypes(schema.accounts)).toMatchObject({
      initial_balance: "double precision",
      auto_sync: "boolean",
    });
    expect(columnTypes(schema.executions)).toMatchObject({
      quantity: "double precision",
      price: "double precision",
      fee: "double precision",
    });
    expect(columnTypes(schema.propAccounts)).toMatchObject({ archived: "boolean" });
  });

  it("stores large objects by private storage path instead of database blobs", () => {
    expect(columnTypes(schema.attachments)).toMatchObject({ storage_path: "text" });
    expect(columnTypes(schema.attachments)).not.toHaveProperty("data");
    expect(columnTypes(schema.marketCsvDatasets)).toMatchObject({
      storage_path: "text",
      checksum: "text",
      format_version: "integer",
    });
    expect(columnTypes(schema.marketCsvDatasets)).not.toHaveProperty("bars_json");
  });

  it("materializes the market dataset relation used for estimate invalidation", () => {
    expect(columnTypes(schema.tradeExcursions)).toMatchObject({ dataset_id: "text" });
  });

  it("seeds the required system folders in the initial migration", () => {
    const migration = readFileSync(
      new URL("../drizzle/0000_ancient_starjammers.sql", import.meta.url),
      "utf8",
    );
    for (const id of ["all", "trade-notes", "daily-journal", "session-recaps", "my-notes"])
      expect(migration).toContain(`'${id}'`);
    expect(migration).toContain('ON CONFLICT ("id") DO NOTHING');
  });
});
