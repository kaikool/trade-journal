# The5ers source integration

This integration reads the [official The5ers MCP service](https://www.the5ers.com/the5ers-mcp/) at `https://mcp.the5ers.com/mcp`. It does not place trades, request payouts, or change Hub records.

## Implementation plan and delivery

1. Verify the public MCP endpoint, read operations and OAuth protected-resource metadata. Completed: initialization, tool inventory and the unauthenticated 401 challenge were inspected. Authenticated response schemas are not publicly supplied.
2. Add OAuth authorization-code flow with PKCE S256, session-bound state, encrypted credentials, token refresh, account selection and source UI. Implemented with synthetic contract tests.
3. Refresh selected source snapshots through the existing daily cron, keep account isolation, redact credentials and opaque references, and mark partial coverage. Implemented with synthetic contract tests.
4. Discover and select pre-registered, CIMD or DCR client registration, then validate real authenticated records. Automatic selection is implemented and tested; live validation is pending. Pending: OAuth discovery returned HTTP 403 (Cloudflare error 1010) in the research environment. No authorization or token endpoint paths were inferred.
5. Implement native journal execution normalization only after native fill identities, timestamp conventions, instrument units, price precision, fee/swap treatment and correction semantics have been verified. Pending. This release imports **zero executions** into journal analytics.

## Server configuration

Keep the existing `DATABASE_URL`, required `JOURNAL_PASSWORD` and encryption key `JOURNAL_SECRET`. Manual client registration is **not** assumed to be necessary. Connect selects a configured client first, then CIMD when advertised, then DCR when advertised. The5ers can restrict client/callback admission. No invented client ID, authorization endpoint or registration URL is used.

- CIMD publishes a public document at `/api/the5ers/client-metadata`; it contains only app identity and callback, not account data or credentials. Only GET is exempted from session authentication, and the required journal password gate still applies.
- DCR requests a public PKCE client using the advertised registration endpoint. Its returned client ID is encrypted and reused for the same issuer/callback/scope set to avoid registering on every click. Disconnect removes user authorization and snapshots but retains this application registration for reuse; it is not a user token.
- Discovery follows OAuth metadata and both OpenID Connect forms for issuers with paths. Missing endpoints (404/410) permit fallback. A refusal such as 403 stops the attempt and reports the HTTP status; it does not trigger attempts to bypass access controls.

Configuration is optional except the existing journal secrets:

- `THE5ERS_OAUTH_CLIENT_ID`: optional pre-registered client identifier; leave empty for automatic registration.
- `THE5ERS_OAUTH_CLIENT_SECRET`: only if The5ers registers a confidential client.
- `THE5ERS_REDIRECT_URI`: optional explicit callback. Otherwise derive it from `VERCEL_PROJECT_PRODUCTION_URL`, or the current request origin outside Vercel, followed by `/api/the5ers/callback`. Explicit callbacks must match the journal origin. HTTP localhost is accepted for development only.
- `THE5ERS_AUTHORIZATION_URL` and `THE5ERS_TOKEN_URL`: leave both empty for standard protected-resource/authorization-server discovery, or set both to URLs explicitly supplied by The5ers. Only HTTPS URLs on `auth.hub.the5ers.com` are accepted. Explicit endpoint overrides require a provider-approved client ID. Missing discovery does not trigger guessed endpoints.

No The5ers client credentials are included in the repository. This setup uses the provider's web authorization flow; no MT5 terminal or desktop bridge is required for this source connector. A usable OAuth client is obtained automatically only if The5ers advertises and permits one of the automatic methods.

Open **The5ers**, use **Check connection** to test discovery from the app runtime without registering anything, then choose **Connect The5ers**, authorize the read-only scopes, and choose **Load accounts**. Select up to ten trading accounts and save. **Refresh account** saves the provider's balance, statistics, rules, consistency, payout eligibility and position source records. Additional buttons fetch health, daily summaries, balance/program history, position details/executions, payout history, purchases, credits, coupons, achievements, notifications and affiliate records when supported.

Unsupported account response formats stop selection/sync and can still be inspected through **Account source data** with credential/reference redaction. Do not share financial source records publicly.

## Automatic refresh

Enable daily refresh for the selected accounts and configure `CRON_SECRET`. The existing Vercel `/api/cron/broker-sync` schedule is `0 16 * * *` (UTC); it now also refreshes these The5ers snapshots. Scheduled The5ers reads share a 240-second budget; accounts that cannot complete within it count as failures and can be refreshed manually. Other deployments must invoke the route with `Authorization: Bearer <CRON_SECRET>` on their own scheduler. Missing journal password blocks this route with HTTP 503. A bad cron secret returns HTTP 401.

Access tokens and refresh tokens are encrypted in PostgreSQL. If The5ers does not issue a refresh token, automatic reads stop after access expires until reconnection. Disconnect removes locally stored credentials, selections, snapshots and pending requests; revoke the provider-side grant separately in The5ers if needed. It does not revoke the grant remotely.

## Coverage and account identity

Opaque account/position references expire and are never treated as persistent native broker IDs. The current strict account adapter accepts `accounts` or `data.accounts` (or an array in `data`), a boolean `pagination.has_more`, and each row's `ref`, `label`, platform and timezone-bearing creation timestamp. Platform aliases are `tradingPlatform`, `platform`, `tradingSystem`; creation aliases are `createdAt`, `creationDate`, `created_at`. These shapes are covered by **synthetic tests**, not confirmed live response captures.

Account selection fingerprints masked label, platform and creation instant. Missing fields, duplicate fingerprints, changed identities or repeated pages stop synchronization without merging accounts. This fingerprint is not a native account ID. Contest accounts use separate references and are excluded. Inventory is limited to 20 pages of 50 accounts. Position history is limited to ten pages of 100 positions and explicitly marked partial if more exist. Opaque position references are encrypted and expire locally after ten minutes; refresh before reading details.

Snapshots upsert separately for each selected account. Repeated refreshes replace source snapshots; they do not duplicate journal fills. Previous snapshots are retained when no requested data can be retrieved. A partial snapshot marks unavailable sections explicitly instead of replacing missing amounts with zero. No extra fee or swap subtraction is applied to reported net P&L. Invalidated trades remain visible as source records.

Provider coverage varies: position details are platform-dependent, daily-performance operations are not universal, payout histories can be incomplete, coupons expose active records, and notifications omit some message/account details. Source totals are not asserted to reconcile to journal trade metrics.

## Security and backup

The API requires a valid journal session; missing password returns 503 and invalid session returns 401 before reading data. Authorization state expires after ten minutes, belongs to the initiating journal session, and is consumed once. OAuth redirects must match the journal origin. Authorization-response issuer identifiers are checked and required when the provider advertises RFC 9207 support. Source records respect the journal privacy toggle and remain hidden until privacy mode is turned off. All MCP tools/operations are server allowlisted; browser requests cannot supply opaque provider references or arbitrary endpoint URLs. External responses have time and size bounds. Provider content is rendered as plain text and never interpreted as instructions or HTML.

Source snapshots live in PostgreSQL settings. Standard journal JSON export does not include The5ers source snapshots or OAuth credentials. Back up the database and `JOURNAL_SECRET` securely if source snapshots and authorization must be retained. Database migration/key rotation recognizes the encrypted The5ers connection, pending state and reference-cache settings. No new schema migration is required for this integration.

OAuth behavior is based on the full [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Descope discovery documentation](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/discovery-url), and [Descope registration documentation](https://docs.descope.com/agentic-identity-hub/core-components/mcp-servers/registration-methods). Reading these confirms the mechanisms, not their enabled configuration on The5ers.
