# Baseline recovery verification

## Verified source and isolation

- Archived Git `HEAD` into the Hermes scratch directory; no user database, `.env`, credentials or untracked migration changes were copied.
- Reused installed dependency directories through junctions.
- The original SQLite native binary uses Node module ABI 137. Running the baseline under Node `v24.21.0` (ABI 137) resolves the earlier Node 26 ABI mismatch without rebuilding or replacing user dependencies.
- A direct in-memory SQLite probe returned SQLite `3.53.2`.

## Actual baseline execution

Command (from repository root):

```sh
npx --yes --package=node@24 node node_modules/vitest/vitest.mjs run --root 'C:/Users/phuct/AppData/Local/hermes/cache/scratch/trade-journal-baseline'
```

Result: **59 test files passed, 566 tests passed** on the archived pre-migration source.

The baseline covers SQLite import/dedup/rebuild, notebook deletion, AI scope, IBKR timezone recovery, NinjaTrader reconciliation, prop cash ledger, market data, replay and export paths. No production data was accessed.

## Current migration verification (before the new mutation slices)

- Six focused Postgres/crypto test files passed: **13 tests**.
- They exercise the generated migration with PGlite (PostgreSQL engine compiled to WASM), not a remote Supabase TCP connection.
- Full workspace typecheck currently fails because the previous interrupted work switched the runtime entrypoint to Postgres before all SQLite query callers/tests were ported. This is an incomplete migration, not a deployment-ready build.
- Corrected an invalid widening type predicate in `postgres-schema.test.ts`; schema exports are all tables, so no catch-and-ignore filter is necessary.

## Important newly verified provider caveat

Current official Supabase Postgres.js guide warns that Postgres.js query pipelining can hang or mismatch results with the shared transaction pooler. It also states that `max_pipeline: 0` breaks transactions and is not a valid workaround.

Reference: <https://supabase.com/docs/guides/database/postgres-js>

Before production deployment, test simultaneous requests through the actual Supabase pooler. Prefer a supported non-pipelining driver if those tests cannot prove safety. PGlite cannot verify this network/pooler behavior.

## Remaining baseline gate

The full test baseline is recovered. A synthetic SQLite migration fixture with persisted table counts, hashes and financial aggregates, plus baseline production build/typecheck, still needs to be captured before marking Phase 0 complete. Do not check off the entire phase based only on test success.
