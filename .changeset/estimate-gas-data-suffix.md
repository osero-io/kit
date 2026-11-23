---
'@osero/client': patch
---

The viem adapter now estimates gas for the calldata viem broadcasts. With a wallet client created with `dataSuffix` (viem 2.45.0 and later; string or `{ value }` form, as used for ERC-8021 builder codes), viem appends the suffix when it sends a step but not when it estimates, and the adapter passes its estimate to `sendTransaction` as `gas`, so viem does not estimate again. The estimate therefore left out the suffix's calldata cost (16 gas per non-zero byte), which the default `gasBufferBps` of 1500 covers but `gasBufferBps: 0` might not. `sendWith` now estimates the calldata with the suffix appended. This makes no extra RPC request, and nothing changes for wallet clients without `dataSuffix` or on viem without it. The EIP-5792 adapter's sequential fallback gets the same fix; the Privy adapter and EIP-5792 atomic batches do not estimate gas themselves.
