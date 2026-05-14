---
'@osero/client': patch
---

Normalize Osero API quote transaction values before building execution plans so API responses using uint256 decimal strings, safe JSON numbers, or hex strings can be passed directly to the wallet adapters.
