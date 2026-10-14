# Maintenance audit — 14 October 2026

This review covers repository maintenance after removal of the experimental market
source. It is not an independent penetration test or a live-production data audit.

## Findings and changes

| Finding                                                                                                        | Result                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| README described the upstream checkout and repeated outdated setup/feature details.                            | Replaced with a concise fork-specific guide, actual clone URL, PostgreSQL/Storage setup, sync scope and backup limits; upstream license/attribution retained.                              |
| Contributor setup omitted database/login requirements and described only package tests.                        | Documented app tests, production build fixture, complete CI gates and the separate read-only The5ers adapter.                                                                              |
| Market/prop guides still described SQLite or nonpersistent candles.                                            | Updated to PostgreSQL, private Supabase Storage, saved-chart restoration and bounded cache refresh.                                                                                        |
| The5ers guide described old provider finance panels and selected-account-only cash reads.                      | Documented common ledger, all-account financial sync/module archive, actual Paid-record policy and missing-date notes.                                                                     |
| Obsolete Dashboard/Trades source component rendered nothing but called the shared source hook.                 | Removed the component and its two page mounts, eliminating redundant source reads. Balance cards remain in Accounts.                                                                       |
| Unused imports, locals and mock parameters remained after earlier changes.                                     | Removed dead bindings; enabled `noUnusedLocals` and `noUnusedParameters` in web type checks.                                                                                               |
| Two UI tests checked an always-empty component.                                                                | Removed those tests and redirected privacy/account-scope checks to the real linked-account balance component.                                                                              |
| Drizzle CLI did not read the `.env.local` file used in setup instructions; blank direct URL bypassed fallback. | Load local environment without replacing existing shell variables, ignore blank connection URLs and omit credentials when none are configured. Removed the guessed localhost database URL. |

## Verification

- Baseline: 97 test files / 737 tests passed before cleanup.
- Affected The5ers projection/UI tests: 21 passed after cleanup. Two obsolete
  empty-component tests were removed; privacy/scope assertions now cover the
  actual component rather than an inert placeholder.
- Web/core/importer type checks passed with unused bindings rejected.
- Production dependency audit: zero reported vulnerabilities at inspection time.
- Both workspace packages built successfully.
- Drizzle migration metadata, formatting, license gate and production web build
  are checked as part of this maintenance change.

The build uses an unreachable database fixture, not production credentials. Test
services use fixtures, PGlite and mocks. No production database migration, data
removal, live broker request or external-provider entitlement check was performed.

## Remaining constraints

- A default free XAUUSD candle source is not verified. A new provider needs real
  server access and a coverage/storage-permission check before implementation.
- Paid-payout amount fallback depends on this journal owner's explicit confirmation.
  Generalizing this fork to other users requires a configurable confirmation policy.
- JSON export is not a complete backup or restore format; retain PostgreSQL,
  Storage and the encryption secret separately.
- Historical migration logs document earlier states; current setup and feature
  guides take precedence. No historical log or user data was deleted as cleanup.
