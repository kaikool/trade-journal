# Trade Journal

A single-user trading journal with trade imports, broker connections, analytics,
calendar, daily journal, prop-firm cash tracking and optional AI reflection.
This repository is a customized fork of [LuxAlgo/trade-journal](https://github.com/LuxAlgo/trade-journal).
Upstream hosted services and published packages are separate from this deployment.

The web app uses **Next.js 15**, **PostgreSQL/Drizzle** and **Supabase Storage**.
SQLite is supported only as a legacy migration source. A workstation or VPS is not
required for a Vercel deployment.

## Run locally

Requirements: **Node.js 22+** and **pnpm 11.0.8** (pinned in `package.json`).

```bash
git clone https://github.com/kaikool/trade-journal.git
cd trade-journal
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
```

Configure the database and secrets before continuing:

| Variable                    | Purpose                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | Trusted server-side PostgreSQL connection; use the Supabase transaction pooler for Vercel. |
| `DIRECT_DATABASE_URL`       | Migration connection; otherwise Drizzle falls back to `DATABASE_URL`.                      |
| `JOURNAL_PASSWORD`          | Required login password. Blank configuration blocks app access with HTTP 503.              |
| `JOURNAL_SECRET`            | Stable encryption secret for saved credentials. Keep it across deployments.                |
| `SUPABASE_URL`              | Supabase project URL for file storage.                                                     |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Storage credential. Required for durable uploads and candle caching.           |
| `CRON_SECRET`               | At least 16 characters; required for authenticated daily auto-sync.                        |

Optional AI, The5ers and market-data credentials are documented in
[`.env.example`](.env.example) and the linked setup guides. Never commit secrets
or expose server credentials through `NEXT_PUBLIC_` variables.

```bash
pnpm --filter web db:migrate
pnpm dev
# http://localhost:3000
```

Use a trusted database role that owns the journal tables or has `BYPASSRLS`.
Journal tables have RLS without public policies; files belong in the private
`journal-attachments` bucket. See [Supabase/Vercel setup](docs/supabase-vercel-setup.md).
Apply migrations before deploying an upgrade.

For a production-style local run, use `pnpm preview`; use `pnpm start` to reuse an
existing build. Run one server mode at a time because they share `.next`.

## Trades and accounts

Add executions manually, import a supported statement in **Import**, or configure
a broker connection. Trades belong to a journal account; account and date filters
control analytics. Statement and display timezones are configured separately.
Review import previews and warnings before saving. See [import formats](docs/importers.md).

An empty Dashboard offers generated demo trades in a separate account.
The Prop firms demo is an in-memory preview and does not save cash records.

### The5ers

Connect through **Settings → Connections** using the official read-only MCP service.
Choose trading accounts there and save links. Account names use available program,
size and full account-number metadata; subsequent syncs preserve custom names.

**Sync expenses** updates purchase costs. **Sync all data** reconciles finances
across discovered accounts, including historical accounts, then archives supported
read modules and projects valid positions into the existing account/trade tables.
Trading-account selection does not limit this manual archive's scope.

Provider pages, progress and the resumable queue are persisted in PostgreSQL.
Successful work survives partial failures; repeated sync resumes unfinished work.
Normal page reads use saved journal data. Explicit refresh and active daily sync
contact the provider to discover changes; an unchanged account does not imply that
its remote history never needs to be checked again.

Expenses and payouts use the **same Prop firms ledger** as manual records from
other firms. Paid payout imports currently include the journal owner's confirmation
that these records represent received money; this is an application policy, not a
generic guarantee of the MCP contract. Missing payment dates are flagged in notes.
Amounts and currencies must still be valid, and repeat sync must not duplicate cash.

See [The5ers mapping and limitations](docs/the5ers.md) and
[module archive and database reads](docs/the5ers-module-cache.md).

### Prop firms

Accounts, Payouts and Transactions share one audited cash ledger. Expenses, refunds,
actual receipts and reversals determine cash totals. Pending requests do not count
as received money. Currencies stay separate; no automatic FX conversion is applied.
See [workflows and formulas](docs/prop-firms.md).

### Charts and market data

Entry/exit prices can draw a trade path without candle data. Candlestick replay
requires actual OHLC data from a configured provider or a candle CSV upload.
No remote provider is enabled by default, and opening a trade never fetches new
provider candles automatically. There is currently **no verified default free
XAUUSD feed** in this deployment.

Supported sources are Alpaca, Binance spot, Coinbase Exchange, London Strategic
Edge, OANDA v20 and uploaded CSV. Their instrument coverage, credentials and
subscription permissions differ; crypto prices cannot substitute for forex/metals.

Loaded provider candles are cached in Supabase Storage, with metadata in the existing
`market_csv_datasets` and `settings` tables. Saved charts load without another
provider request. Explicit loads reuse historical coverage and refresh recent
coverage when needed. Contract multipliers are required for monetary derivative
estimates, not for drawing candles. See [market data, cache and replay](docs/market-data.md).

### AI and installation

**Settings → AI** accepts Anthropic or OpenAI credentials. AI requests are optional
and use the selected provider; saving a key does not verify its remote permissions.
See [AI data scope](docs/ai-scope.md).

On supported browsers, use **Install app** or **Add to Home Screen**. The PWA needs
HTTPS. Offline mode shows a notice; private journal/API responses are not cached
on the device.

## Backup

**Settings → Data & backups** exports journal JSON, while trades and cash movements
also support CSV. JSON is not a complete database/Storage backup and there is no
general JSON restore importer. It excludes credentials, candle datasets, saved
market estimates and attachment binaries. Back up PostgreSQL and the private
Storage bucket separately, and retain `JOURNAL_SECRET` securely.

Legacy SQLite migration uses `pnpm migrate:supabase`; it requires an empty target.
Retain the source until verification completes. See [migration/setup](docs/supabase-vercel-setup.md).

## Development

| Directory            | Responsibility                                            |
| -------------------- | --------------------------------------------------------- |
| `apps/web`           | Next.js app, APIs, persistence, source adapters and UI.   |
| `packages/core`      | Framework-independent trade reconstruction and analytics. |
| `packages/importers` | Statement parsers and import normalization.               |
| `scripts`            | License verification and migration tooling.               |
| `docs`               | Setup, feature contracts and historical migration logs.   |

```bash
pnpm format:check
pnpm typecheck
pnpm test
node scripts/check-licenses.mjs
pnpm -r --filter './packages/*' build
pnpm build
```

Tests use synthetic fixtures, PGlite and mocked external services. Passing them
proves the tested behavior; it does not verify a live broker, production database
or market-data subscription. See [Contributing](CONTRIBUTING.md),
[audit remediation history](docs/audit-remediation.md) and [maintenance audit](docs/maintenance-audit.md).

## License and security

[MIT](LICENSE), with upstream copyright retained. Follow [TRADEMARKS.md](TRADEMARKS.md)
for LuxAlgo names/marks and [SECURITY.md](SECURITY.md) for vulnerability reporting.
External requests serve enabled broker, market-data and AI features; browser
speech recognition may use the browser vendor's service. Set
`NEXT_TELEMETRY_DISABLED=1` to disable Next.js framework telemetry.
Trading metrics and AI output are for review and are not investment advice.
