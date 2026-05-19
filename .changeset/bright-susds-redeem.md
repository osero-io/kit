---
'@osero/client': patch
---

Refresh mainnet `redeemSUsds` phase 2 after sUSDS redeem confirmation so the USDS approval and `buyGem` calldata use the actual USDS received and live Lite PSM `tout`.

The refreshed `buyGem` call applies the configured slippage tolerance to the final USDC output amount. If `tout` rises before the final transaction is built, the plan accepts less USDC rather than spending more USDS; a further `tout` change after the refresh can still make the final transaction revert, leaving the sender with USDS that can be redeemed through `redeemUsds`.
