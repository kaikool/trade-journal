# Contributing

This customized fork keeps the upstream MIT license and attribution. Read
[README.md](README.md) for the current architecture and deployment requirements.

## Setup

Use Node.js 22+ and the pinned pnpm 11.0.8. Install with
`pnpm install --frozen-lockfile`, copy `apps/web/.env.example` to
`apps/web/.env.local`, configure PostgreSQL, login/encryption secrets and private
Supabase Storage, then run `pnpm --filter web db:migrate` and `pnpm dev`.
Tests use their own fixtures/PGlite and do not require production credentials.

## Checks

CI runs these gates:

```bash
pnpm format:check
pnpm typecheck
pnpm test
node scripts/check-licenses.mjs
pnpm -r --filter './packages/*' build
DATABASE_URL=postgres://build:build@127.0.0.1:9/journal pnpm build
```

The final URL is a deliberately unreachable build fixture. Do not migrate or
run the application against it. Use `--maxWorkers=1` for Vitest on a constrained
development machine. Type checks reject unused locals and parameters in the web app.

## Ground rules

- Use `@luxalgo/broker-sdk` for its supported broker connections. The The5ers
  integration is a separate read-only MCP adapter with allowlisted operations.
- Keep shared analytics in `packages/core`; isolate provider normalization and
  persistence from UI components. Do not change financial semantics as cleanup.
- Tests should defend behavior, account isolation, cash correctness and data
  preservation. Do not treat mocked requests as evidence of live provider access.
- Importers must match a documented format or use the column mapper. New formats
  need fixtures; anonymized source exports are preferable to invented contracts.
- Read [design.md](docs/design.md) before chart/UI changes. P&L color must not be
  the only indication of an outcome.
- Keep credentials server-side and encrypted at rest. Never commit keys or
  database dumps. External providers are optional and require verified access.
- Preserve user names, annotations and existing history during synchronization.
  Partial reads must not erase saved data or fabricate complete coverage.
- Update the relevant feature guide whenever its behavior or configuration changes.
