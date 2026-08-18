---
'@osero/client': minor
---

Add an opt-in EIP-5792 wallet adapter.

The adapter submits pending execution-plan steps as one atomic call batch when the wallet supports
it and falls back to sequential viem execution by default.
