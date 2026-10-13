# The5ers integration

The journal uses the [official The5ers MCP service](https://www.the5ers.com/the5ers-mcp/) at `https://mcp.the5ers.com/mcp`. All provider operations are read-only. The journal never places trades, requests payouts, or changes Hub records.

## Connect and link

1. Open **Settings → Connections**. **Check connection** checks discovery; **Connect The5ers** starts OAuth authorization-code flow with PKCE S256.
2. Authorize the read scopes in The5ers. The callback returns to **Accounts**.
3. Choose accounts, optionally select an existing same-currency journal account, and click **Save links**. Links are saved first; the app then refreshes each account's history and distinguishes a link failure from a history-refresh failure.
4. Enable daily refresh if desired. Automatic account reads recheck the current lifecycle status and run only for active accounts. Available/disabled accounts remain selectable and support manual refresh.

Accounts uses the journal's existing cards, badges, checkboxes and buttons. Active/available is the default filter; other statuses and counts are available through the status selector. Provider `disabled` is not interpreted as breached or closed. Existing journal names, capital, annotations, manual records and cash entries are retained. Starting capital is configured independently; current balance is never substituted for initial capital.

The inventory reader requests 50 records per page, accepts larger valid provider responses and collects distinct account identities across overlapping pages. A matching reported total confirms coverage even when `has_more` is inconsistent. Repeated pages stop further reads with partial coverage; they do not block linking an account that is present and independently verified in a fresh read. Missing selected accounts, ambiguous fingerprints, unknown currency and conflicting journal links still fail closed. Additional-account coverage notices and technical details are collapsible.

Opaque refs expire. Account identity uses masked label, platform and a valid creation instant, not a broker account number. Contest accounts are a separate reference space and cannot be linked through the trading-account adapter. Inventory is bounded by 20 requests, 1,000 records and 4 MiB.

## Data mapping and calculations

| Provider facts                                                       | Journal use                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Account balance/equity                                               | Compact account and dashboard balances; amounts are quoted rather than recomputed |
| Position symbol, side, open/close time, size, entry/exit and net P&L | Existing Trades reader, Dashboard analytics and daily Journal/calendar            |
| Position fee/swap                                                    | Reported values in trade details; never subtracted from reported net P&L again    |
| Completed purchase cash                                              | Existing audited Prop Firms expense ledger and cash totals                        |
| Program rules, consistency and provider statistics                   | Compact account metrics; raw source details stay collapsed                        |
| Payout history/eligibility                                           | Requests stay separate; verified settlements populate audited cash receipts       |
| Credits, coupons, achievements and notifications                     | Existing Benefits/Activity sections                                               |

### Positions

The public contract returns position refs as `ref`; the adapter also accepts the older `position_ref` form. References are encrypted in a ten-minute cache for detail reads and are never persistent journal identity. Detail keys remain stable across refreshes. Expired references are renewed by listing positions for the same account and matching the verified position identity; the app also makes one bounded renewal attempt when the provider rejects a locally valid reference. This does not refetch all account sections or remove saved trades.

A position is normalized only when side, positive reported size, entry price, explicit closed/open status and an offset-bearing open timestamp are valid. Closed positions additionally require close time, exit price and finite reported net P&L. Naive wall times, invalid calendar dates, unknown directions and missing amounts are not guessed. Source reads request UTC context; valid instants are stored in UTC and grouped/formatted in the configured journal timezone.

Normalized positions live in bounded per-source history settings and are projected into the shared trade reader. No atomic executions are fabricated. A stable local identity uses source account, symbol, direction and normalized open instant. Simultaneous positions use explicit stable provider IDs or distinct entry/size facts to separate their identities, preserving existing trade keys and annotations where a prior record matches. Truly indistinguishable groups remain for review and retain their previous history; they do not block unrelated valid positions. Full raw rows remain in the sanitized snapshot for diagnosis. Changed entry/size facts on an existing unambiguous position preserve previous history rather than silently rewriting it. Repeated refreshes update an existing position once; partial windows retain prior history and mark coverage incomplete. Exactly matching existing native trades take precedence to avoid duplicate statistics. Aliases across different broker symbol names are not inferred.

Net P&L, wins/losses, profit factor, equity, drawdown, calendar and intraday curves use reported position outcomes. Invalidated program positions still happened and are included in journal outcomes; this is not a program risk-engine verdict. Provider account statistics can describe a different scope and are not asserted to equal the journal's filtered history.

Fee/swap sign conventions and size units are not assumed. Gross P&L and aggregate costs are unavailable when a selection contains net-only source positions. ROI on notional, monetary R and market-excursion estimates are unavailable for unverified position units. Reported fee/swap remain visible individually. Absolute drawdown is computed; percentage drawdown requires valid initial capital. Missing history is disclosed on Trades/Dashboard instead of presented as a complete account history.

Verified reported positions are also persisted in the existing `trades` table without inventing execution records. Refresh writes new or changed economics only; unchanged rows, local annotations and exclusions survive repeat syncs and execution rebuilds. Legacy snapshots with corroborated account currency are imported automatically when their journal section is opened; no provider refetch is needed. A version marker prevents repeated conversion. One explicit account-scoped currency is sufficient when no source disagrees and it matches the journal account; missing or conflicting currency remains visible in Sync details rather than silently choosing USD. Legacy selected accounts missing a journal link get a same-currency import account, without replacing user records. Normal page reads use stored database history; an explicit source refresh still scans the paginated provider history to detect new positions and corrections. No unverified remote date filter or cursor is assumed.

Journal annotations, tags, playbooks, review status and local exclusion work for these reported trades. Deleting a reported trade excludes it locally and does not delete the provider record or revive it on refresh. Clearing the linked account removes stored projected history; a later provider refresh can fetch it again. Re-link connected accounts in Accounts rather than transfer their reported history as executions.

### Purchase expenses

Purchase history loads automatically in **Prop Firms → Transactions**, with a manual refresh button. Completed, valid orders are reconciled into the same audited ledger used by manual entries. One order is one expense: `priceUsd` is a conversion of `price`, not another charge. Amounts retain each order's own currency and use exact integer minor units. Program categories are mapped only when explicit; otherwise they are Other.

Line `netPaid`, credits and discounts are USD even when the order was paid in another currency. When credits were applied, line `netPaid` can establish USD cash, but a non-USD cash conversion is not invented. Unsupported amounts, pending orders, refunded items and possible duplicate manual costs remain for review. Local identity uses purchase time/currency/product names rather than the expiring order ref. Indistinguishable orders are rejected; changed cash amounts require review instead of creating another charge. Previously posted amounts are not silently overwritten.

Expense date is the order's `placedAt` instant converted to the journal timezone; the original UTC instant remains in notes. The source does not provide a separate bank settlement date. Purchase expenses stay firm-wide unless attribution can be verified; no account is guessed from a cart or progression chain. Refund amounts/dates and ambiguous cash records require reconciliation with the existing ledger.

### Payout settlements

Account refresh and **Prop firms → Payouts → Payout history** fetch and persist payout history. Opening Payouts loads history once for selected accounts that have no saved payout section. Both `payouts` and `withdrawals` collections are supported; withdrawal IDs remain stable across refreshes. Subsequent page reads use the saved history. Explicit completed settlements with a verified currency, request timestamp, payment timestamp and net received amount are recorded in the existing audited `prop_entries` and `prop_receipts` tables. A generic request `amount` is not treated as net cash after profit split and commission.

Records missing settlement facts offer **Record money received**: select a funded The5ers prop account and confirm the actual amount and payment date. Saving records the net settlement and updates **Payouts received** immediately. This writes only to the local journal, never requests a payout from The5ers. The receipt identity remains stable across refreshes and repeated confirmations; matching manual receipts prevent automatic duplicate posting. Corrections and local reversals remain under the existing ledger workflow.

The official payout history excludes cancelled, declined, terminated and reversed records. Its coverage is incomplete even after all pages are read; absence from a later response does not delete a receipt or imply reversal. Requests without settlement evidence stay separate from cash totals. Provider field contracts beyond explicit supported settlement fields require owner confirmation rather than guessed profit splits, fees or payment dates.

## Configuration and daily refresh

Required: a nonempty `JOURNAL_PASSWORD`; missing configuration locks the entire app with HTTP 503. Invalid sessions return HTTP 401. Set `JOURNAL_SECRET` for stable encrypted credential storage and the normal PostgreSQL database variables.

Optional The5ers OAuth variables are documented in `.env.example`. A pre-registered `THE5ERS_OAUTH_CLIENT_ID` takes priority. Otherwise discovery selects HTTPS client metadata (CIMD) when advertised, then dynamic registration (DCR). Unsupported registration or blocked discovery reports a concrete error. Endpoints are constrained to the official authorization host. No client secret is needed for supported public automatic registration. The callback is `/api/the5ers/callback` on the journal production origin; an explicit `THE5ERS_REDIRECT_URI` can configure it.

Set `CRON_SECRET` for the existing Vercel `/api/cron/broker-sync` schedule, `0 16 * * *` UTC. Other deployments call it with `Authorization: Bearer <CRON_SECRET>`. Opted-in, nonarchived active accounts refresh positions first; successful scheduled account reads also refresh purchase expenses within the shared time budget. The cron response exposes purchase success/pending status and fails when that refresh fails. Refresh-token absence or expiry requires reconnecting.

Disconnect removes local OAuth credentials, selections, pending states, temporary snapshots and opaque-ref caches. Journal position history, annotations, native accounts and posted expenses remain. Revoke the grant in The5ers separately when needed.

## Security, backup and validation

All APIs require the journal session before provider/data reads; public OAuth client metadata exposes only app identity and callback information. State is session-bound, one-use and expires after ten minutes. Tokens and opaque caches are encrypted, operations are allowlisted, replies are bounded, and provider text is rendered as text. Source financial values respect privacy mode.

No schema migration or new dependencies are required. Position CSV export includes verified net P&L and leaves unknown gross/cost columns empty. JSON export includes `reportedPositions` with annotations but excludes OAuth credentials and opaque refs. A full database backup is needed to preserve the source history settings and link mapping, along with secure retention of `JOURNAL_SECRET` for authorization.

The current public `tools/list` schemas were inspected on 2026-10-13. User screenshots confirmed live OAuth, account and purchase reads. Automated tests use synthetic contract fixtures and PostgreSQL-compatible PGlite; they do not prove a logged-in production account was exercised from the development environment. Tests cover link/save failures, overlapping/partial pages, corrected position refs, net-only analytics, missing fields, timezone boundaries, repeated refresh, native/manual duplicate avoidance, local annotations/exclusions and purchase currency/cost treatment.

OAuth implementation follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Descope discovery](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/discovery-url) and [registration](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/registration-methods).

Account cards expose the actual database trade count and a collapsed Sync diagnostics download. The exported snapshot is already sanitized provider data and excludes OAuth tokens and encrypted reference caches. Use this snapshot to diagnose a production response contract; synthetic tests alone do not establish successful production ingestion.

Payout history is account-scoped. An empty `payouts` response for a selected evaluation account does not establish that another funded account has no received payouts; select that account to inspect its history.

Position pagination stops when the reported total is satisfied, even if a provider incorrectly keeps `has_more` true. Repeated complete page payloads do not append duplicate records; absent proof of full coverage, the retained history is marked partial. The snapshot records reported totals and repeated-page evidence for troubleshooting.
