---
'@osero/client': major
---

Refactor the hosted Osero API client around capability-driven swap assets.

`getSwapQuote` now accepts registered input/output asset pairs instead of only counter-asset ↔ sUSDS pairs. The registry adds first-class `ethereum:usds` metadata, enabling routes such as USDS → USDC and USDT → USDS while keeping `ethereum:susds` supported as both an input and output.

Hosted API quote execution plans now tag execution transactions with the generic `SWAP` operation. Consumers that previously keyed UI or analytics off hosted quote operations like `MINT_SUSDS` or `REDEEM_SUSDS_FOR_USDC` should derive labels from `quote.pair.from` and `quote.pair.to` instead.

Registry exports were renamed from counter/vault terminology to input/output terminology. See `docs/osero-sdk/upgrading-0-to-1.md` for the full migration guide.
