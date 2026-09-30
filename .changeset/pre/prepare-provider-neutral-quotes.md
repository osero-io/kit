---
'@osero/client': major
---

Replace the legacy hosted quote response with the provider-neutral API contract. Same-chain quotes
now return a `ready-to-execute` Hosted Swap Workflow containing the normalized API quote and a
separate execution-only, expiry-bound Wallet Execution Plan. Enso and LI.FI Provider Details are
typed, unknown providers remain inspectable and executable, and hosted approval policy is removed.
