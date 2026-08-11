---
'@osero/client': patch
---

Refresh the mainnet `mintSUsds` USDS deposit step after `sellGem` confirmation so SDK adapters deposit the actual USDS received. The static fallback plan remains slippage-adjusted for inspection and custom executors that do not evaluate refresh hooks.
