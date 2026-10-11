# Supabase Storage attachments log

Date: 2026-10-11

Scope: Phase 4 private Supabase Storage attachments only.

## Implemented

- Added server-only Supabase Storage helper in `apps/web/src/server/storage.ts`.
- Switched attachment upload API to:
  - `POST /api/attachments` with `action: "prepare"` to verify owner, size and declared allowlist MIME, create pending metadata, and return a signed direct upload URL.
  - browser direct `PUT` to the signed Storage URL.
  - `POST /api/attachments` with `action: "finalize"` to inspect the Storage object and verify object path, exact size, Storage MIME, and magic-byte MIME before marking metadata `ready`.
- Switched attachment download API to return a short-lived signed Storage redirect instead of proxying bytes through the app server.
- Switched delete API to remove the private Storage object and metadata, returning success when metadata is already gone.
- Added opportunistic cleanup for stale pending uploads during prepare; metadata is deleted only after the private Storage object removal succeeds.
- Updated `components/attachments.tsx` to use prepare, direct signed upload, and finalize.

## Safety notes

- The service role key is used only by the server-side Storage helper.
- The browser receives only signed upload/download URLs and never receives the service role key.
- Large attachment bytes are not sent through the Vercel API route body.
- Finalize rejects mismatched object paths, changed sizes, unsupported magic bytes, and MIME mismatches.
- Listed attachments include only `ready` metadata.

## Test results

RED:

- `pnpm vitest run apps/web/tests/attachments-storage.test.ts`
- Result: failed as expected against the old BLOB/multipart implementation with 3 failing tests.

GREEN:

- `pnpm vitest run apps/web/tests/attachments-storage.test.ts`
- Result: passed, 4 tests.
- `pnpm vitest run apps/web/tests/attachments-storage.test.ts apps/web/tests/journal-features.test.ts apps/web/tests/export-attachments.test.ts`
- Result: passed, 3 files and 11 tests.

Format:

- `pnpm exec prettier --write apps/web/src/app/api/attachments/route.ts apps/web/src/app/api/attachments/[id]/route.ts apps/web/src/components/attachments.tsx apps/web/src/server/storage.ts apps/web/tests/attachments-storage.test.ts docs/supabase-vercel-storage-log.md`
- `pnpm exec prettier --check apps/web/src/app/api/attachments/route.ts apps/web/src/app/api/attachments/[id]/route.ts apps/web/src/components/attachments.tsx apps/web/src/server/storage.ts apps/web/tests/attachments-storage.test.ts docs/supabase-vercel-storage-log.md`
- Result: all matched files use Prettier code style.

Typecheck:

- `pnpm --filter web typecheck`
- Result: failed on existing broader Postgres migration work outside this phase, mostly `.get()`, `.all()`, and `.run()` callers in unrelated route/test files.
- Scoped filter for `attachments`, `storage.ts`, and `components/attachments` did not report errors in the new Phase 4 files.

## Not verified

- Remote Supabase Storage integration was not run because this environment has no Supabase credentials.
- Bucket creation and private bucket policy were not applied from this repo change.
- Cleanup for abandoned pending metadata/objects is opportunistic during future prepares, not scheduled as a background task.
