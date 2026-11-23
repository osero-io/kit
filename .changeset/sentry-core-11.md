---
'@osero/client': minor
---

`@osero/client` now requires Node.js 20.19+, 22.12+, or 23.2+ (`engines.node` is `>=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0`, was `>=20`). Node.js 20.0 to 20.18 and 22.0 to 22.11 are no longer supported. On those versions Yarn 1 refuses to install the package and npm installs it with an `EBADENGINE` warning. Upgrade Node.js before upgrading the SDK. Browser support is unchanged.

**Why.** Telemetry now depends on `@sentry/core` 11 (`^11.9.0`, was `^10.73.0`), and `@sentry/core` 11 declares exactly this Node.js range.

The private Sentry client is still loaded lazily, only when an event qualifies, and still never touches a host application's Sentry setup. Reported events carry the same data as before with one difference: in the exception entry for an error's `cause`, the mechanism `type` is now `chained` instead of `osero.client`. The top-level exception is unchanged. No export, type, or default of `@osero/client` changed.
