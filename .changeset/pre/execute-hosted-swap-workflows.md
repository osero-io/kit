---
'@osero/client': minor
---

Add a bounded wallet-neutral Hosted Swap Workflow executor. It confirms one approval at a time,
performs provider-locked Quote Refreshes after approvals or expiry, emits serialized lifecycle
progress, and returns the final quote with every confirmed wallet result.
