---
'@osero/client': minor
---

Expand the swap API client to recognize the full multi-chain counter-asset set.

`OSERO_API_COUNTER_ASSET_IDS`, `OSERO_API_SOURCE_CHAIN_IDS`, and the
`/swap/assets` + quote response decoders now cover the stablecoins AUSD, GHO,
PYUSD, RLUSD, USDC, USDC.e, USDD, USDG, USDT, USDe, USDtb, and frxUSD across the
existing chains plus Avalanche C-Chain, BNB Smart Chain, HyperEVM, Monad,
Polygon, Unichain, Berachain, and Plasma. The `OseroApiChainKey`
and `OseroApiAssetSymbol` unions widen to match, and `getSwapQuote` accepts the
new counter assets.

The asset surface is now driven by exported `OSERO_API_CHAINS`,
`OSERO_API_COUNTER_ASSETS`, and `OSERO_API_VAULT_ASSET` registries (one row per
chain/asset), alongside new `OseroApiAsset` and `OseroApiAssetDecimals` types.
Existing asset ids, chain ids, and the `OseroApiClient` surface are unchanged.
Quote and asset decoders also reject internally inconsistent API responses.
The viem adapter now rejects execution plans whose transaction chain does not
match the connected wallet chain before estimating gas or sending.
