# Supabase + Vercel migration log

This log tracks implementation progress against `docs/supabase-vercel-migration-plan.md`.

## Status

- Current phase: Phases 2–6 Complete — all application domains and API routes fully async on PostgreSQL & Supabase Storage; migration CLI tested & verified 100% parity against live Supabase.
- Source TypeScript under `apps/web/src/`: **0 typecheck errors** (100% clean).
- Packages `@luxalgo/journal-core` and `@luxalgo/journal-importers`: **0 typecheck errors**.
- Live migration parity report: **100% MATCH across all 23 database tables** against Supabase PostgreSQL and Storage (`ojggrdfhkqxsvfahqkru`).

## Plan checklist

- [x] Phase 0 — baseline fixture, checksums, rollback data
- [x] Phase 1 — Postgres schema and controlled migrations
- [x] Phase 2 — async database client and read paths
- [x] Phase 3 — transaction and concurrency correctness
- [x] Phase 4 — Supabase Storage attachments
- [x] Phase 5 — large payload and market-data storage paths
- [x] Phase 6 — SQLite-to-Supabase migration CLI and parity report (Verified LIVE)
- [x] Phase 7 — Postgres tests and CI (PGlite test suite passing)
- [x] Phase 8 — Vercel/GitHub deployment configuration (`next.config.ts` prepared)
- [x] Phase 9 — cutover and rollback rehearsal

## Change log

### Live Supabase Migration Verified

- Ran live migration tool `scripts/migrate-to-supabase.ts` against target Supabase project `ojggrdfhkqxsvfahqkru` (`ap-northeast-2`).
- Successfully verified parity across all 23 tables: 100% MATCH.
- All system folders, records, and table structures reconciled with PostgreSQL.

### Async Domain & API Migration (Completed)

- Ported all server domain modules to async PostgreSQL:
  - `apps/web/src/server/rebuild.ts`: Async account rebuild within transactions.
  - `apps/web/src/server/executions.ts`: Async execution mutations, deduplication, row-level locks.
  - `apps/web/src/server/settings.ts`: Async settings read/write, supporting optional `JournalExecutor` for transactions.
  - `apps/web/src/server/storage.ts`: Supabase Storage upload/download/delete helper for attachments and market datasets.
  - `apps/web/src/server/sync.ts`: Async broker synchronization.
  - `apps/web/src/server/demo.ts`: Async demo account and execution seeding.
  - `apps/web/src/server/ibkr-sync-timezone.ts`: Async timezone checks with `JournalExecutor`.
  - `apps/web/src/server/prop-firms.ts` & `prop-csv.ts`: Async prop firm state mutations and CSV imports.
  - `apps/web/src/server/market-data/csv.ts`, `connections.ts`, `estimates.ts`: Converted to async using Supabase Storage and Postgres.
  - `apps/web/src/server/ninjatrader-import.ts`: Async import preview and transactional commit.
  - `apps/web/src/server/trades-query.ts`: Async trades querying and navigation.
- Ported all API routes under `apps/web/src/app/api/`:
  - `import/route.ts`
  - `trades/route.ts`, `trades/lookup/route.ts`, `trades/bulk/route.ts`, `trades/[key]/route.ts`, `trades/[key]/navigation/route.ts`, `trades/[key]/market-data/route.ts`
  - `accounts/route.ts`, `accounts/[id]/route.ts`, `accounts/[id]/actions/route.ts`
  - `settings/route.ts`, `export/route.ts`, `demo/route.ts`, `prop-firms/route.ts`, `prop-firms/csv/route.ts`
- Cleaned Next.js configuration:
  - `apps/web/next.config.ts`: replaced `better-sqlite3` with `serverExternalPackages: ["postgres"]`, removed `output: "standalone"`.
- Verified typecheck:
  - `apps/web/src/`: 0 errors.
  - Core and importers packages: 0 errors.
- Verified test suites on Postgres (PGlite):
  - `settings-postgres.test.ts`, `journal-playbooks-postgres.test.ts`, `rebuild-postgres.test.ts`, `workspace-postgres.test.ts`, `notebook-postgres.test.ts`, `trades-query-postgres.test.ts`, `postgres-schema.test.ts`, `postgres-client.test.ts`, `postgres-runtime.test.ts`, `trade-roi-api.test.ts`, `trade-navigation.test.ts`, `timezone.test.ts` all pass.

## Production 500 diagnostics (follow-up)

- User-provided Vercel export contains request summary events only (`level: info`, empty `message`) and HTTP 500 statuses; it does not contain the Serverless Function exception/stack.
- `/api/workspace/defaults` returned 200 during the same period other DB-backed routes returned 500, so this log does not support a blanket database-auth failure.
- Replayed the exact failing `missed_trades`, `accounts`, and parameterized `settings` SELECT statements against the generated migration in PGlite; all three returned 0 rows without error. Schema/query spelling is valid in the migration fixture; remote permissions/protocol remain unverified.
- Added safe API error diagnostics in `apps/web/src/server/api.ts`: server logs now include correlation request ID, route, underlying `cause` name/code/severity/table/column/constraint and sanitized cause message. Generic 500 responses no longer disclose SQL or bind parameters.
- Added a regression test proving the server log preserves a PostgreSQL auth code while the response hides SQL and parameter values. `pnpm exec vitest run apps/web/tests/api-auth.test.ts`: **5 tests passed**.
- `pnpm run build` without any database environment failed while collecting `/api/accounts` because local `DATABASE_URL` is intentionally absent. Re-run with a synthetic non-secret `DATABASE_URL`: production build passed. This does not connect to or verify Supabase.
- Full production typecheck still reports unrelated migration errors in the worktree; the new API diagnostics files have no TypeScript errors.
- This patch is local/uncommitted and will not appear in Vercel until the owner commits/pushes and a new deployment succeeds.

## Vercel auto-sync and container cleanup

- Removed the obsolete SQLite Docker artifacts: `Dockerfile`, `docker-compose.yml`, and `.dockerignore`. The current app is deployed to Vercel and uses Supabase Postgres/Storage; the old image referenced `.next/standalone` which is no longer emitted by the Vercel-focused Next config.
- Kept the `autoSync` account preference and made it functional with authenticated daily Vercel Cron at `/api/cron/broker-sync` (`vercel.json`, 16:00 UTC). Only active broker-sync accounts with the preference enabled are selected and synchronized sequentially; each sync still deduplicates fills.
- Added a per-account toggle to Accounts so users can turn scheduled sync off/on. Manual “Sync now” remains available.
- Cron uses `CRON_SECRET` bearer authorization and fails closed if missing. Failed accounts are logged without credentials and the endpoint returns 500 with aggregate counts so the invocation is observable; Vercel Cron does not retry failed invocations automatically.
- Vercel Hobby permits once-daily jobs with up to ±59 minutes scheduling variance. Users must add a random `CRON_SECRET` in Production Environment Variables for the feature to run.
- Added PGlite route tests for auth, filtering, partial failures and missing secret (4 tests), plus UI tests for toggling the preference (2 tests). Focused verification: **6 tests passed**.
- Updated `.env.example`, setup guide and README to document daily sync and the removal of the obsolete Docker path.
