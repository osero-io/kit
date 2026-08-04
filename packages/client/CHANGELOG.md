# @osero/client

## 1.0.0-next.2

### Patch Changes

- 8562478: Call the hosted API fetch implementation as a plain function instead of as a method, so browsers
  that enforce the fetch receiver no longer throw `TypeError: Illegal invocation`. This applies to
  both the default global fetch and a caller-supplied `fetch` override.

## 1.0.0-next.1

### Major Changes

- 7fcfe4a: Replace legacy bridge-status requests and responses with normalized Transfer Status. Status requests
  now keep the source transaction hash and complete quote Status Context together, known Enso and LI.FI
  Provider Details are typed, and unknown providers remain inspectable. Polling continues for pending
  and unknown states and returns completed or failed Transfer Status observations without discarding
  provider diagnostics.
- 7fcfe4a: Replace the legacy hosted quote response with the provider-neutral API contract. Same-chain quotes
  now return a `ready-to-execute` Hosted Swap Workflow containing the normalized API quote and a
  separate execution-only, expiry-bound Wallet Execution Plan. Enso and LI.FI Provider Details are
  typed, unknown providers remain inspectable and executable, and hosted approval policy is removed.
- 7fcfe4a: Publish the breaking v1 hosted API migration as a provider-neutral Hosted Swap Workflow. Replace
  the legacy Enso-shaped quote and bridge status with discriminated approval and ready states,
  provider-locked Quote Refresh, expiry-bound Wallet Execution Plans, bounded high-level execution,
  and normalized Transfer Status polling.

### Minor Changes

- 7fcfe4a: Add manual hosted Approval Step and provider-locked Quote Refresh transitions. Insufficient
  allowance now returns one exact approval-only Wallet Execution Plan, while refreshed quotes restart
  allowance preparation before exposing replacement execution calldata.
- 7fcfe4a: Add a bounded wallet-neutral Hosted Swap Workflow executor. It confirms one approval at a time,
  performs provider-locked Quote Refreshes after approvals or expiry, emits serialized lifecycle
  progress, and returns the final quote with every confirmed wallet result.
- 7fcfe4a: Add optional hosted quote expiry constraints to Wallet Execution Plans. Expiry now participates in
  plan identity and persistence, and viem, ethers, and Privy executions fail with a typed
  `QuoteExpiredError` when the quote expires before broadcast.

## 1.0.0-next.0

### Major Changes

- a9f7ba8: Replace the 0.x pair-specific preview/action surface with a single typed `prepareSwap` API. It
  returns a rich exact-input or exact-output quote tied to a flat, versioned, account/chain-bound
  `ExecutionPlan`. Amounts, slippage, referrals, approval policy, and unprotected-route consent are
  explicit domain inputs. Referral attribution and public RPC fallback default to disabled, while
  allowance-aware exact approvals are the default.

  Wallet adapters now preflight the complete plan before broadcasting, estimate fresh buffered gas,
  report truthful signing/broadcast/confirmation/revert stages, preserve submitted and replacement
  hashes, emit progress, and support receipt-verified confirmed-prefix recovery. Every SDK error has
  stable literal discriminants and contextual JSON output; operational calls keep failures in
  `Result`/`ResultAsync`.

  The public surface is intentionally split across the root, `/actions`, `/api`, `/contracts`,
  `/viem`, `/ethers`, and `/privy` entrypoints. Legacy local action functions, nested plan variants,
  and internal flattening/type-guard helpers are removed.

  Refactor the hosted Osero API client around API-authoritative asset refs. The SDK no longer ships a gating registry, so a deployed build keeps working as the hosted API adds and removes assets, chains, and bridge protocols.

  `getSwapQuote` accepts any asset ref — a canonical id (`'ethereum:usdc'`), an arbitrary string id, or a `{ chainId, address }` locator encoded on the wire as `'<chainId>:<0xaddress>'`. Known ids still autocomplete, but nothing is rejected locally on membership: the hosted API is the sole authority and answers unsupported refs with HTTP 400 and a stable API response code (for example `SWAP_ASSET_NOT_SUPPORTED`). That server code is exposed as `ApiRequestError.apiCode`; `ApiRequestError.code` remains the SDK error discriminant `API_REQUEST_FAILED`. Responses decode structurally, so assets, chains, protocols, kinds, directions, and states unknown to this SDK release decode normally.

  Registry exports are renamed to advisory `KNOWN_` snapshots — `OSERO_API_KNOWN_ASSETS`, `OSERO_API_KNOWN_CHAINS`, `OSERO_API_KNOWN_ASSET_IDS`, `OSERO_API_KNOWN_CHAIN_IDS`, and `OSERO_API_KNOWN_BRIDGE_PROTOCOLS` — that only power editor autocomplete and offline UI hints. The input/output splits (`OSERO_API_INPUT_*`, `OSERO_API_OUTPUT_*`, `OseroApiInputAssetId`, `OseroApiOutputAssetId`) and the source-chain allowlist (`OSERO_API_SOURCE_CHAIN_IDS`, `OseroApiSourceChainId`) are removed. `getSupportedAssets()` is the sanctioned live list, and the new `matchOseroApiAsset(assets, ref)` helper pre-flights a ref against it.

  Client-side validation narrows to wire grammar and execution safety (EVM addresses, hex payloads, uint256 amounts, 32-byte tx hashes). Server-policy checks that 0.x ran locally are now enforced by the API instead of pre-flight `ValidationError`s: asset/pair membership and slippage failures come back as 400s with stable codes (`SWAP_ASSET_NOT_SUPPORTED`, `SWAP_PAIR_NOT_SUPPORTED`, `SLIPPAGE_INVALID`, `SLIPPAGE_OUT_OF_RANGE`), an out-of-range referral code is a plain 400 from request validation, and a printable-ASCII but invalid API key is a 401. Empty keys and keys containing non-ASCII, whitespace, or control characters remain local `ValidationError`s. `getTokenBalance` additionally accepts any ERC-20 address alongside the canonical token symbols.

  Hosted API Execution Plans tag execution transactions as `SWAP_EXACT_IN`; derive user-facing labels from `quote.pair.source` and `quote.pair.destination`. See `docs/osero-sdk/upgrading-0-to-1.md` for the full migration guide.

## Unreleased

### Major Changes

- Replace pair-specific preview/action helpers with one typed `prepareSwap` API covering the
  verified exact-input and exact-output route matrix. Preparation now returns a rich quote bound to
  a versioned flat `ExecutionPlan`.
- Make amounts, slippage, referrals, approval policy, account, and chain binding explicit.
  Referral attribution and public RPC fallback now default to disabled; exact allowance-aware
  approval is the default authorization policy.
- Require slippage constructors to name their unit explicitly as
  `parseSlippage({ bps: value })`; the legacy unitless string input is rejected.
- Replace nested plan variants with deterministic step IDs, plan identity, canonical
  serialization, confirmed-prefix recovery, progress callbacks, and executor capability
  requirements.
- Replace broad/generic failures with stable literal error codes and contextual, JSON-safe error
  fields. Operational APIs return `Result`/`ResultAsync`; executor preflight validates the complete
  plan before any broadcast.
- Split the intentional public surface across root, `/actions`, `/api`, `/contracts`, `/viem`,
  `/ethers`, and `/privy`. Legacy action functions and internal flattening/type-guard helpers are
  no longer exported.

### Minor Changes

- Add account-free `quoteSwap` for read-only local route economics. It returns the same block-pinned
  amounts, fees, route, and slippage-protection details used by preparation without reading
  allowances, constructing calldata, or returning an execution plan.

### Security and Reliability

- Verify hosted quote sender, amount, source-chain relationships, approval target/value, and decoded
  ERC-20 `approve(spender, amount)` calldata before exposing executable plans.
- Recheck live allowance at a recorded block and rebuild approval transactions locally. Hosted gas
  values remain advisory metadata and never bypass fresh executor estimation.
- Add account/chain/checksum binding, all-step preflight, fresh buffered gas estimation, truthful
  signing/broadcast/confirmation/revert stages, ethers replacement tracking, and standard-hash
  enforcement for Privy.
- Add cancellable bounded bridge completion polling, independent-step plan simulation with live fee
  and balance provenance, explicit balance multicall policy, and stable log-domain APY conversion.

### Release Gates

- Add a clean-build tarball allowlist, MIT license packaging, declaration API report, packed ESM and
  TypeScript consumers, optional-peer isolation, Node 20/24 compatibility, all-source coverage
  thresholds, shared adapter contracts, and pinned-block fork gates for every supported chain.

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
