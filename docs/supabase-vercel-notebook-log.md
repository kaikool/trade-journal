# Supabase/Vercel Notebook Route Port Log

Date: 2026-10-11

## Scope

- Ported only the authorized notebook/journal/folders/playbooks/workspace/trade-rule route scope to async Postgres Drizzle calls:
  - `apps/web/src/app/api/folders/**`
  - `apps/web/src/app/api/notes/**`
  - `apps/web/src/app/api/journal/**`
  - `apps/web/src/app/api/playbooks/**`
  - `apps/web/src/app/api/workspace/**`
  - `apps/web/src/app/api/trades/[key]/rules/route.ts`
- Did not edit `migration-log.md`, db settings/shared files, execution/rebuild/sync/account/import paths, or secrets/env files.

## Changes

- Replaced SQLite-style `.get()`, `.all()`, and `.run()` usage in the scoped route handlers with awaited Postgres Drizzle queries.
- Converted scoped transactions to async transaction callbacks.
- Preserved note folder soft-delete behavior: deleting a folder moves notes to `my-notes` and keeps the folder tombstone.
- Awaited async settings and trade-query helpers in journal/workspace/rule handlers.
- Added PGlite-backed integration coverage using `apps/web/tests/helpers/postgres.ts`:
  - `apps/web/tests/notebook-postgres.test.ts`
  - `apps/web/tests/journal-playbooks-postgres.test.ts`
  - `apps/web/tests/workspace-postgres.test.ts`

## Tests

- RED run before route changes:
  - `pnpm vitest run apps/web/tests/notebook-postgres.test.ts apps/web/tests/journal-playbooks-postgres.test.ts apps/web/tests/workspace-postgres.test.ts`
  - Failed as expected: 3 files failed, 6 tests failed from unported sync route DB calls.
- GREEN focused run after changes:
  - `pnpm vitest run apps/web/tests/notebook-postgres.test.ts apps/web/tests/journal-playbooks-postgres.test.ts apps/web/tests/workspace-postgres.test.ts`
  - Passed: 3 files, 6 tests.
- Broader Postgres-focused run:
  - `pnpm vitest run apps/web/tests/rebuild-postgres.test.ts apps/web/tests/settings-postgres.test.ts apps/web/tests/trades-query-postgres.test.ts apps/web/tests/notebook-postgres.test.ts apps/web/tests/journal-playbooks-postgres.test.ts apps/web/tests/workspace-postgres.test.ts`
  - Passed: 6 files, 14 tests.
- Typecheck:
  - `pnpm --filter web typecheck`
  - Failed from unrelated unported routes/tests outside this scope, including remaining SQLite-style `.get()`, `.all()`, `.run()` calls and async helper callsites in account, attachment, export, prop-firm, sync, timezone, navigation, and ROI areas.
