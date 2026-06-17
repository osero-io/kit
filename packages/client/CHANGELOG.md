# @osero/client

## 0.8.0

### Minor Changes

- 45abd63: Add an optional Privy server-wallet adapter at `@osero/client/privy` using `@privy-io/node`.

## 0.7.0

### Minor Changes

- 9c2e3ee: Expand the swap API client to recognize the full multi-chain counter-asset set.

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

### Patch Changes

- 5282d3f: Update the SDK validation dependency set to use viem 2.48.11.
- 390caca: Support building the SDK in workspaces that resolve TypeScript 6.

## 0.6.1

### Patch Changes

- 21eb3a1: Normalize Osero API quote transaction values before building execution plans so API responses using uint256 decimal strings, safe JSON numbers, or hex strings can be passed directly to the wallet adapters.

## 0.6.0

### Minor Changes

- 00a1f05: Add an authenticated Osero API client for swap quotes, assets, and bridge status,
  including `x-api-key` candidate validation, quote referral code overrides, API
  error handling, and wallet-adapter execution plan conversion.

## 0.5.0

### Minor Changes

- ec8f38e: Add SSR / sUSDS APY read helpers. New exports `getSsr`, `getSUsdsApy`, and the pure `ssrToApy` converter return the current Sky Savings Rate as a RAY-scaled `bigint` and as an annualised decimal fraction. Mainnet reads `ssr()` directly off the sUSDS vault; L2s read `getSSR()` off Spark's `SSRAuthOracle`. Also exports the `RAY` and `SECONDS_PER_YEAR` constants and the `ssrAbi` ABI used by both reads.

## 0.4.1

### Patch Changes

- 4d83de1: Update repository URLs in package.json after repo rename from `osero-kit` to `kit`

## 0.4.0

### Minor Changes

- fc7472f: Apply a built-in `DEFAULT_REFERRAL_CODE` (`3000n`) to every action whenever the request does not specify one, add a new `ClientConfig.defaultReferralCode` field to override or opt out at the client level, and treat `referralCode: undefined` on a request as a per-call opt-out. Upgrading without further action will emit `3000n` where calls previously emitted `0n` on PSM3 `Swap` events and the sUSDS `deposit` referral overload.

## 0.3.0

### Minor Changes

- 7d3960c: Add mainnet `mintSUsds` referral support via the sUSDS deposit referral overload while keeping the SDK request shape consistent across mainnet and L2 chains. Update examples to show referral code usage for sUSDS mint flows.

## 0.2.0

### Minor Changes

- 2d62b1d: Add preview helpers for the exact-in USDC, USDS, and sUSDS flows. The client can now quote expected outputs for `previewMintUsds`, `previewMintSUsds`, `previewRedeemUsds`, and `previewRedeemSUsds` across mainnet and supported L2s.

## 0.1.0

### Minor Changes

- 172f7ec: Add ergonomic helpers for reading canonical `USDC`, `USDS`, and `sUSDS` balances through `OseroClient`. This release also updates the roundtrip examples to use the new helpers instead of wiring token contracts manually.
