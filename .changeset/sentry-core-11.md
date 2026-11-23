---
'@osero/client': patch
---

Telemetry now depends on `@sentry/core` 11 (`^11.9.0`, was `^10.73.0`). The private Sentry client is still loaded lazily and only when an event qualifies, and it still never touches a host application's Sentry setup. Reported events carry the same data as before. No export, type, or default of `@osero/client` changed.
