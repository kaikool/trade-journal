# The5ers source archive

`Sync all data` first reconciles the common financial ledger, then reads every
advertised, allowlisted read operation from the live MCP tool catalogue. The
archive covers all discovered trading accounts, including disabled accounts;
selection controls daily updates, not the scope of this manual archive.

Data is stored in the existing Supabase/Postgres `settings` table. No database
migration is required. Each response page has its own indexed key:

```
the5ers:module:<module>:<operation>:<account-id-or-global>:<subject>:<page>
```

Values contain `data`, `retrievedAt`, `runId`, `accountIds`, `subject`, `page`, and
parent/record identity when a response refers to a position, purchase or contest.
All returned rows are preserved. Credentials and ephemeral provider references
are omitted from readable snapshots; references required to resume detail reads
are kept only in an encrypted job. Stale references are renewed through their
parent operation before a detail read.

The live catalogue is stored at `the5ers:module:catalogue:tools:global:1`.
`the5ers:module-sync` contains public progress and per-module counts.
`the5ers:module-job` contains the encrypted resumable queue. A short DB lease
prevents concurrent callers from losing one another's progress. Successful pages
are retained when another operation fails. Failed tasks remain retryable.

Pagination and dependent operations (position details/executions, purchase
accounts, contest details) add work to the queue, so the total can increase during
sync. The app advances up to six sections per API call, with a 35-second work budget.
Queue/progress checkpoints are saved before work and after each result, not only
at the end of a batch. Completed sections are skipped when resuming; failed native
projections retry their saved source page without another MCP read. Closing the browser stops the
client runner; another click resumes the saved queue. An incomplete run is never
reported as complete. A completed run is reused for 15 minutes. The next run
updates snapshots. Unknown/unallowlisted operations are reported rather than
executed. Operations requiring absent records or unsupported provider data do
not produce fabricated business records.

## Read from the database

Application/server code should use:

```ts
import { readArchivedModule } from "@/server/the5ers/modules";

const history = await readArchivedModule("positions", "list", sourceAccountId, sourceAccountId);
// history.pages contains response pages, ordered by page, from the latest run.
// history.available is false until that operation has been saved.
```

An authenticated HTTP equivalent is:

```
GET /api/the5ers?view=module&module=positions&operation=list&subject=<source-id>&accountId=<source-id>
```

These reads do not open an MCP connection. `subject` is `global` for user-wide
operations and a source-account hash for account operations. Dependent records
have a stable derived subject hash; their parent and account metadata are stored
with their response. The account scope in keys makes account-specific reads
possible without loading every account's module snapshots.

## Existing business tables

Available position pages are projected into the existing `accounts` and
`trades` tables using `saveJournalPositions`. Every native trade retains its
`account_id`. New/changed provider economics are upserted; notes, tags, ratings,
Reviewed state, local exclusions, custom account names and capital are preserved.
The importer keeps earlier trade history and does not clear tables on partial
source results. Missing currency or unrecognizable positions remain in the
source archive without fabricated native trades.

Execution responses are saved under `positions.trades`; a position summary is
not converted into invented execution rows. Existing native executions from
other imports remain unchanged. Payouts and costs still use `prop_accounts`,
`prop_entries`, `prop_receipts`, and their audited shared ledger, rather than
being counted twice from source snapshots.

Settings reads a lightweight connection/progress response rather than transferring
all payout and position history after every batch. The browser waits for an occupied
lease and keeps advancing pending work even if one batch contains only failed reads.
Once only failures remain and a retry makes no progress, it stops with an incomplete
status. Partial financial runs retain successful account coverage beyond the
15-minute freshness interval, so long-running syncs do not restart saved histories.
