---
'@osero/client': minor
---

Add an opt-in EIP-5792 wallet adapter.

The adapter submits pending execution-plan steps as one atomic call batch when the wallet supports
it and falls back to sequential viem execution by default. `prepareSwap({ execution: 'atomic-batch' })`
marks the plan so a capable wallet must send every pending step in one bundle. Mainnet USDC to sUSDS
then sizes the USDS approval and deposit as the 1:1 scaled USDC amount.
