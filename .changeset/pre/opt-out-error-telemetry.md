---
'@osero/client': minor
---

Add opt-out error telemetry.

The SDK now reports a curated subset of the typed errors it returns — SDK bugs, hosted API contract
drift, server-side API failures, and failed on-chain executions — to Osero's Sentry project. Caller
mistakes, user cancellations, wallet signing failures, network and RPC outages, quote expiry, and
API key or rate-limit responses are never reported, and API keys, headers, wallet addresses, and
amounts are never attached. Reporting uses a private `@sentry/core` client loaded on first use, so
it never touches a host application's own Sentry setup. Disable it with
`configureTelemetry({ enabled: false })`, `OSERO_TELEMETRY=0`, or `DO_NOT_TRACK=1`. Hosted API
requests to `*.osero.org` now carry a `sentry-trace` header so API-side events can be correlated.
