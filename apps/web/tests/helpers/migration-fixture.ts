import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildRoundTrips, type Execution } from "@luxalgo/journal-core";
import { BOOTSTRAP_SQL } from "../../src/db/bootstrap";

const createdAt = "2026-01-01T00:00:00.000Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Synthetic records only. Never read a user's journal or overwrite an existing database. */
export function createMigrationFixture(path: string) {
  if (existsSync(path)) throw new Error("Fixture destination already exists");
  const sqlite = new Database(path);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(BOOTSTRAP_SQL);
    const insert = (table: string, values: Record<string, unknown>) => {
      const columns = Object.keys(values);
      sqlite
        .prepare(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .run(...Object.values(values));
    };
    const accounts = [
      { id: "usd", name: "Synthetic USD", currency: "USD", kind: "manual", created_at: createdAt },
      { id: "eur", name: "Synthetic EUR", currency: "EUR", kind: "import", created_at: createdAt },
    ];
    const fills: Execution[] = [
      {
        id: "entry",
        accountId: "usd",
        symbol: "TEST",
        side: "buy",
        quantity: 10,
        price: 100,
        fee: 1,
        executedAt: "2026-01-01T10:00:00.000Z",
        source: "manual",
      },
      {
        id: "partial",
        accountId: "usd",
        symbol: "TEST",
        side: "sell",
        quantity: 4,
        price: 102,
        fee: 1,
        executedAt: "2026-01-01T10:30:00.000Z",
        source: "manual",
      },
      {
        id: "flip",
        accountId: "usd",
        symbol: "TEST",
        side: "sell",
        quantity: 8,
        price: 103,
        fee: 2,
        executedAt: "2026-01-01T11:00:00.000Z",
        source: "manual",
      },
      {
        id: "cover",
        accountId: "usd",
        symbol: "TEST",
        side: "buy",
        quantity: 2,
        price: 101,
        fee: 1,
        executedAt: "2026-01-01T12:00:00.000Z",
        source: "manual",
      },
      {
        id: "open",
        accountId: "eur",
        symbol: "EURTEST",
        side: "buy",
        quantity: 1,
        price: 50,
        fee: 1,
        executedAt: "2026-01-02T10:00:00.000Z",
        source: "import",
      },
    ];
    const trips = buildRoundTrips(fills);
    const first = trips[0]!;
    const object = Buffer.from(
      "%PDF-1.4\n% Synthetic migration fixture, not a user document.\n%%EOF",
    );
    const bars = [
      { time: Date.parse(first.openedAt), open: 100, high: 103, low: 99, close: 102, volume: 10 },
    ];
    const barsJson = JSON.stringify(bars);
    sqlite.transaction(() => {
      for (const account of accounts) insert("accounts", account);
      for (const fill of fills)
        insert("executions", {
          id: fill.id,
          account_id: fill.accountId,
          symbol: fill.symbol,
          side: fill.side,
          quantity: fill.quantity,
          price: fill.price,
          fee: fill.fee,
          executed_at: fill.executedAt,
          source: fill.source,
          content_hash: hash(JSON.stringify(fill)),
          created_at: createdAt,
        });
      for (const trip of trips)
        insert("trades", {
          key: trip.key,
          account_id: trip.accountId,
          symbol: trip.symbol,
          direction: trip.direction,
          status: trip.status,
          opened_at: trip.openedAt,
          closed_at: trip.closedAt ?? null,
          quantity: trip.quantity,
          open_quantity: trip.openQuantity,
          avg_entry: trip.avgEntry,
          avg_exit: trip.avgExit ?? null,
          gross_pnl: trip.grossPnl,
          fees: trip.fees,
          net_pnl: trip.netPnl,
          execution_count: trip.executionCount,
          execution_ids_json: JSON.stringify(trip.executionIds),
          exits_json: JSON.stringify(trip.exits),
          duration_ms: trip.durationMs ?? null,
          notes: "Synthetic review",
          tags_json: '["fixture"]',
          mistakes_json: "[]",
          playbook_id: "book",
          rating: 4,
          stop_loss: 95,
          profit_target: 110,
          reviewed_at: createdAt,
        });
      insert("journal_days", {
        date: "2026-01-01",
        note: "Synthetic journal",
        updated_at: createdAt,
      });
      insert("notes", {
        id: "note",
        folder_id: "my-notes",
        title: "Fixture",
        content: "Synthetic note",
        trade_key: first.key,
        day_date: "2026-01-01",
        created_at: createdAt,
        updated_at: createdAt,
      });
      insert("playbooks", {
        id: "book",
        name: "Fixture setup",
        rules_json: '["Wait"]',
        created_at: createdAt,
      });
      insert("settings", { key: "timeZone", value: "UTC" });
      insert("attachments", {
        id: "attachment",
        owner_type: "trade",
        owner_id: first.key,
        name: "fixture.pdf",
        mime: "application/pdf",
        size: object.length,
        data: object,
        created_at: createdAt,
      });
      insert("note_templates", { id: "template", name: "Review", content: "## Setup" });
      insert("trade_rule_checks", {
        id: "check",
        trade_key: first.key,
        playbook_id: "book",
        rule: "Wait",
        followed: 1,
      });
      insert("progress_rules", {
        id: "routine",
        title: "Review",
        stage: "After trading",
        weekdays_json: "[1,2,3,4,5]",
        created_at: createdAt,
      });
      insert("progress_checks", {
        id: "routine-check",
        rule_id: "routine",
        date: "2026-01-01",
        done: 1,
      });
      insert("missed_trades", {
        id: "miss",
        symbol: "TEST",
        direction: "long",
        observed_at: createdAt,
        created_at: createdAt,
      });
      insert("market_csv_datasets", {
        id: "dataset",
        name: "Synthetic candles",
        symbol: "TEST",
        resolution: "1m",
        currency: "USD",
        price_basis: "raw",
        bars_json: barsJson,
        imported_at: createdAt,
        bar_count: bars.length,
        first_time: bars[0]!.time,
        last_time: bars[0]!.time,
      });
      insert("trade_excursions", {
        trade_key: first.key,
        fingerprint: "synthetic-fingerprint",
        provider: "Market data CSV",
        symbol: "TEST",
        resolution: "1m",
        fetched_at: createdAt,
        estimate_json: JSON.stringify({ datasetId: "dataset", mae: -10, mfe: 30 }),
      });
      insert("prop_accounts", {
        id: "prop",
        firm: "Synthetic Firm",
        name: "Fixture funded",
        program: "funded",
        status: "active",
        currency: "USD",
        journal_account_id: "usd",
        opened_on: "2026-01-01",
        created_at: createdAt,
        updated_at: createdAt,
      });
      insert("prop_entries", {
        id: "payout",
        account_id: "prop",
        firm: "Synthetic Firm",
        kind: "payout",
        category: "payout",
        currency: "USD",
        amount_minor: 10000,
        split_bps: 8000,
        fee_minor: 0,
        occurred_on: "2026-01-02",
        status: "completed",
        created_at: createdAt,
        updated_at: createdAt,
      });
      insert("prop_receipts", {
        id: "receipt",
        payout_id: "payout",
        kind: "receipt",
        amount_minor: 8000,
        occurred_on: "2026-01-03",
        created_at: createdAt,
      });
      insert("prop_audit", {
        id: "audit",
        entity_type: "entry",
        entity_id: "payout",
        after_json: '{"fixture":true}',
        reason: "Synthetic fixture",
        created_at: createdAt,
      });
      insert("import_sources", {
        id: "source",
        account_id: "eur",
        format: "generic",
        name: "Fixture source",
        created_at: createdAt,
      });
      insert("import_source_aliases", {
        id: "alias",
        account_id: "eur",
        format: "generic",
        alias_key: "fixture",
        source_id: "source",
      });
      insert("import_batches", {
        id: "batch",
        account_id: "eur",
        format: "generic",
        fingerprint: "fixture",
        raw_hash: "fixture",
        time_zone: "UTC",
        source_ids_json: '["source"]',
        from_time: fills.at(-1)!.executedAt,
        to_time: fills.at(-1)!.executedAt,
        snapshot_json: "[]",
        created_at: createdAt,
      });
    })();
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const counts = Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    );
    return {
      counts,
      accounts: accounts.map(({ id, currency }) => ({ id, currency })),
      trades: trips.map(({ key, accountId, status, netPnl, fees, openQuantity }) => ({
        key,
        accountId,
        status,
        netPnl,
        fees,
        openQuantity,
      })),
      accountTotals: accounts.map(({ id, currency }) => ({
        id,
        currency,
        fees: fills
          .filter((fill) => fill.accountId === id)
          .reduce((sum, fill) => sum + fill.fee, 0),
        netPnl: trips
          .filter((trip) => trip.accountId === id)
          .reduce((sum, trip) => sum + trip.netPnl, 0),
      })),
      attachment: { bytes: object.length, sha256: hash(object) },
      dataset: { bars: bars.length, sha256: hash(barsJson) },
    };
  } finally {
    sqlite.close();
  }
}
