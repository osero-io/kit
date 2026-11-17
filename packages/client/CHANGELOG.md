# @osero/client

## 1.1.0

### Minor Changes

- f2fb235: Add the remaining capabilities from the v1 audit. Everything here is additive: no export, type, error code, default, or existing behaviour changed, and every new field is optional.

  **Resume from a failure.**

  - `executionResumeStateFromError(plan, error)` builds the `resume` option for the next `sendWith` call from a failed execution. It returns state only when that is safe: every confirmed step on the error must carry its receipt, and the step that failed must provably not have taken effect (it was never sent, the wallet explicitly rejected it, or it was mined and reverted). When the failed step may already have been submitted, such as a receipt timeout or an EIP-5792 batch whose status never arrived, it returns a `ValidationError` naming the hash or batch id to check. Pass `{ unresolvedStep: 'assume-not-executed' }` after confirming the step did not execute.
  - `serializeExecutionResumeState(state)` and `deserializeExecutionResumeState(json)` persist resume state as bigint-safe canonical JSON, like the plan serializers.
  - Completed steps on an execution error (`error.execution.completed`) now carry optional `submittedHash`, `replacement`, and `confirmation`. Every bundled adapter sets them. `JSON.stringify(error.execution)` keeps working: the bigint receipt fields are written as decimal strings.
  - `error.execution.batchId` is set on EIP-5792 failures once the wallet has accepted a batch.
  - `QuoteExpiredError` has an optional `execution` context. When a quote expires between steps, it names the step that was not sent and lists the steps already confirmed.

  **Wait for a cross-chain transfer without the quote.** `OseroApiClient.waitForTransferStatus({ sourceTransactionHash, statusContext }, options)` polls with the same options and semantics as `waitForSwapCompletion`, so a restarted process can resume waiting from a persisted status request. `waitForSwapCompletion` is unchanged.

  **Richer simulation.** `simulateExecutionPlan` results gain:

  - `feeData.basis` (`'max-fee-per-gas'` or `'gas-price'`) and `feeData.maxFeePerGas`. `feeData.gasPrice` keeps its value and meaning.
  - `revert: { reason?, data? }` on a failed step, when the node returned a revert reason or raw revert data.
  - an optional fourth argument `{ quote }`. Given the prepared quote the plan came from, the result's `quote` field echoes the expected amount and the minimum output or maximum input. A quote for a different plan is a `ValidationError`.

  **Opt-in local gas estimates.** `prepareSwap` accepts `gasEstimates: 'independent-steps'`. It estimates, at the quote block, the steps that do not depend on an earlier step (the first step) and attaches `estimatedGas` with source `'local-simulation'`. The default is `'none'`, which makes no extra RPC call. A failed estimate omits the field and never fails `prepareSwap`. Estimates do not change the plan ID.

  **Route discovery.** `listSwapRoutes(chainId)` lists each supported local pair with its modes, how each mode enforces its slippage bound, and its referral capability.

  **Executor capabilities.**

  - `ExecutorCapabilities.supportedChainIds` is an optional declaration of the chains an executor can submit to. The SDK's capability preflight rejects a plan with a step on another chain when a capability object sets it. The bundled adapters leave it unset, and the preflight is internal, so a custom executor must enforce its own declaration.
  - When the Privy Wallet API returns a response without a standard transaction hash, the `UnsupportedCapabilityError` now carries an optional `execution` context naming the step and the steps already confirmed.

  **Refresh Context forward compatibility.** Primitive fields the API adds to a Refresh Context are preserved and sent back unchanged on refresh. A Refresh Context without extra fields is sent byte-for-byte as before.

  Release tooling: the packed-consumer check now typechecks the ethers and Privy entrypoints with their peers installed at the supported floors (viem 2.28.0, ethers 6.14.0, `@privy-io/node` 0.19.0), the adapter files have per-file coverage floors, and CI bundles the browser-supported entrypoints and fails on any Node.js built-in import.

### Patch Changes

- f2fb235: Close the bug and security gaps left from the v1 audit. No export, type, error code, or default changed. The observable behaviour changes are:

  **Approval calldata must be canonical.** An approval step is accepted only when its calldata is byte-for-byte the canonical encoding of `approve(spender, amount)`. Calldata that decodes to the right spender and amount but carries extra bytes after the arguments was previously accepted and is now rejected. This applies to hosted quotes (`getSwapQuote`, `refreshSwapQuote`, and `executeSwap` return `ApiResponseError`) and to plans you build or load yourself (`createTransactionRequest`, `createExecutionPlan`, `deserializeExecutionPlan`, `resumeExecutionPlan`, and every `sendWith` return `ValidationError`). Approvals built with `createApprovalTransaction` are unaffected.

  **A cancelled or replaced transaction is no longer treated as confirmed.** In the viem, Privy, and EIP-5792 adapters, if a submitted transaction is cancelled or replaced by a different transaction, `sendWith` now returns `ConfirmationError` at stage `replacement` with the submitted hash, and no later step is broadcast. Previously the replacement's receipt was recorded as a successful step. This matches the ethers adapter. A transaction that was only repriced still succeeds, for any number of confirmations. viem names the kind of replacement only when one confirmation is requested; with more, the viem and Privy adapters compare the replacement viem found in the mined block with what was submitted and accept it only if its sender, target, calldata, and value are exactly the same. This adds no RPC request. To observe that block, the adapter's receipt wait no longer joins a `waitForTransactionReceipt` you started yourself on the same client and hash: it polls for the receipt on its own, so that wait's `confirmations` no longer stand in for the ones passed to `sendWith`. Block-number polling is still shared. On viem releases that keep polling after a receipt wait times out (2.28 does), each timed-out adapter wait on a hash now leaves its own receipt poller behind, where retries used to join a single one.

  **Repriced transactions are labelled `repriced`.** For a repriced step the viem adapter now reports `replacement.reason` as `'repriced'` instead of `'replaced'`, matching ethers. The Privy adapter now also reports `submittedHash` and `replacement` for a repriced step instead of only the effective hash. The EIP-5792 adapter cannot verify a wallet-built batch transaction, so a change of the batch transaction's hash while it waits for extra confirmations now fails with `ConfirmationError` at stage `replacement`.

  **Privy `sendWith` no longer throws on a malformed plan.** A malformed plan passed together with `idempotencyKeys`, a `null` plan, or an `idempotencyKeys` value that is not an object made `sendWith` throw a `TypeError`. Each now returns `ValidationError` and makes no Wallet API call.

  **EIP-5792 failures are classified.** The EIP-5792 adapter returned `UnexpectedError` for failures it can identify. Now:

  - a `wallet_sendCalls` failure returns `SigningError` for an unauthorized account (code `4100`) and `BroadcastError` for anything else that is not a user rejection or an atomic-capability refusal (code `5760`, which still falls back to sequential sends or returns `UnsupportedCapabilityError`); a response without a batch ID returns `BroadcastError`;
  - a batch status wait that fails or times out returns `ConfirmationError`, with the batch ID in the message;
  - a malformed, failed, or non-atomic batch status returns `ConfirmationError`;
  - a batch that reverted as a whole still returns `TransactionError`, and its `execution.completed` now lists the steps confirmed before the batch instead of being empty;
  - a partial revert (status `600`, or a status `500` that carries a successful receipt or is not reported as atomic) now returns `ConfirmationError` instead of `TransactionError`, because some calls may be on chain;
  - an unreadable receipt during the extra-confirmation wait now returns `ConfirmationError` instead of `TransactionError`.

  **EIP-5792 batch progress is reported as it happens.** Progress events for an atomic batch were emitted only after the batch succeeded, so a failed batch reported nothing. `preflight-complete` and `step-started` are now emitted when the wallet accepts the batch, `step-submitted` when the wallet reports the batch's transaction hash, and `step-confirmed` and `plan-completed` only after confirmation. For a successful batch the same events are emitted, with all submissions before all confirmations.

  **A progress callback failure on an EIP-5792 batch reports every confirmed step.** When `onProgress` threw during an atomic batch, the returned `ProgressCallbackError` listed only the steps before the failing event in `execution.completed`, even though the whole batch had confirmed. It now lists every batched step.

  **Unknown Transfer States keep polling.** A normalized transfer `state` this SDK release does not know is decoded as `'unknown'` instead of failing the response with `ApiResponseError`. `waitForSwapCompletion` keeps polling on it.

  **Referral codes in responses are not range-checked.** The response decoder rejected referral codes outside 3000–3999 even though requests accept any code and the range was documented as not enforced client-side. Any non-negative safe integer the API returns is now accepted. The code must still match the one you requested.

  **Multicall works on Unichain.** `getTokenBalances` with `multicall: 'require'` always failed on chain 130, and `'prefer'` always fell back to three separate reads, because the Unichain chain definition did not declare Multicall3. It now does, so `getChain(130).viemChain.contracts.multicall3` is set.

  Documentation: the adapter defaults and per-stage error mappings are now specified in `docs/osero-sdk/adapters.md`, and the README states the supported runtimes.

- b0f412a: `executeSwap` no longer sends a redundant approval after an approval has confirmed. No export, type, error code, or default changed.

  **What was wrong.** After an approval confirmed, `executeSwap` refreshed the quote and re-read the allowance at the block returned by `getBlockNumber()`. viem answers that call from a cache for the client's `cacheTime` (4 seconds on Ethereum by default). When the approval confirmed inside that window, the allowance was read at a block from before the approval, came back as insufficient, and the same approval was sent again. Each repeat cost gas and a wallet prompt, and enough of them ended the swap with `ApprovalLimitError`. Setting `cacheTime: 0` on the public client was the only way to avoid it.

  **What changed.**

  - `getSwapQuote`, `refreshSwapQuote`, and `executeSwap` read the allowance at a fresh block: they call `getBlockNumber({ cacheTime: 0 })` on the client from `publicClientProvider`. This is one uncached `eth_blockNumber` request per chain for each quote that has an Approval Step to check. Quotes without one make no RPC request, as before.
  - Inside `executeSwap`, the allowance check after a confirmed approval never reads below that approval's receipt block (`confirmation.blockNumber` of the approval result, when the handler reports it). If the RPC still reports an older head, the SDK asks again up to four times, 250 ms apart, and then reads at the receipt block. An RPC that cannot serve that block returns `RpcError` and no further approval is requested. Cancelling through `signal` during the wait returns `CancelError`.
  - `simulateExecutionPlan`, `quoteSwap`, and `prepareSwap` now also pin their reads to a fresh block in the same way. A simulation, quote, or prepared plan requested right after a transaction no longer reflects state from before it. Each call now makes one uncached `eth_blockNumber` request; a large `cacheTime` on the public client no longer saves that request.

  Approval and refresh limits, progress events and their order, and the hosted API requests are unchanged.

## 1.0.1

### Patch Changes

- 0e0d10a: Allow `@privy-io/node` 0.36 as a peer dependency.

## 1.0.0

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

- 5bca250: Require slippage inputs to name basis points explicitly.

  `parseSlippage` now accepts `{ bps: string }`, rejecting the legacy unitless string input.

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
- 4b8ac15: Support the hosted API's 0x integration.

  `'0x'` joins `'enso'` and `'lifi'` as a first-class Quote Provider across every
  provider discriminator. 0x is one provider spanning the same-chain 0x Swap API
  and the 0x Cross-Chain API, so it reports a single tag either way, and its
  allowance requirements arrive as ordinary Approval Steps bound to the returned
  spender.

  - `isOseroApiZeroXProviderDetails` narrows quote Provider Details to the 0x
    support id, curated route, gas and network-fee estimates, and the
    `integratorFee` / `zeroExFee` / `bridgeNativeFee` breakdown.
    `quote.expectedOutput` is already net of all three.
  - Status Context is now a provider-discriminated union. A 0x context carries
    the required `providerQuoteId`, which is serialized into every status poll;
    polling a 0x context without it fails locally as a `ValidationError`.
    Unrecognised primitive fields from a future provider's context are echoed
    back unchanged instead of dropped.
  - `isOseroApiZeroXTransferStatusProviderDetails` narrows Transfer Status
    Provider Details to the original 0x status, failure reason, and recovery
    status.
  - Every Transfer Status gains a nullable `recoveryContext` with normalized
    `state` and `reason`, so a failed cross-chain transfer is no longer
    unconditionally terminal. `waitForSwapCompletion` accepts `waitForRecovery`
    to keep polling while automatic recovery is pending.
  - `prepareRecoveryExecutionPlan(status, submitter)` turns a sender-free
    Recovery Action into a wallet-agnostic Execution Plan under the new
    `RECOVER_CROSS_CHAIN_TRANSFER` operation. A recovery deadline becomes the
    plan's quote expiry, so adapters refuse a closed window. Only a `failed`
    transfer whose recovery is `action-required` authorizes a submission; every
    other state is rejected rather than built into a signable plan, and
    `isOseroApiActionableRecovery` narrows to that one submittable combination.

### Minor Changes

- 7fcfe4a: Add manual hosted Approval Step and provider-locked Quote Refresh transitions. Insufficient
  allowance now returns one exact approval-only Wallet Execution Plan, while refreshed quotes restart
  allowance preparation before exposing replacement execution calldata.
- 32d4137: Add an opt-in EIP-5792 wallet adapter.

  The adapter submits pending execution-plan steps as one atomic call batch when the wallet supports
  it and falls back to sequential viem execution by default. `prepareSwap({ execution: 'atomic-batch' })`
  marks the plan so a capable wallet must send every pending step in one bundle. Mainnet USDC to sUSDS
  then sizes the USDS approval and deposit as the 1:1 scaled USDC amount.

- 7fcfe4a: Add a bounded wallet-neutral Hosted Swap Workflow executor. It confirms one approval at a time,
  performs provider-locked Quote Refreshes after approvals or expiry, emits serialized lifecycle
  progress, and returns the final quote with every confirmed wallet result.
- 7fcfe4a: Add optional hosted quote expiry constraints to Wallet Execution Plans. Expiry now participates in
  plan identity and persistence, and viem, ethers, and Privy executions fail with a typed
  `QuoteExpiredError` when the quote expires before broadcast.
- 0cf4e72: Add opt-out error telemetry.

  The SDK now reports a curated subset of the typed errors it returns — SDK bugs, hosted API contract
  drift, server-side API failures, and failed on-chain executions — to Osero's Sentry project. Caller
  mistakes, user cancellations, wallet signing failures, network and RPC outages, quote expiry, and
  API key or rate-limit responses are never reported, and API keys, headers, wallet addresses, and
  amounts are never attached. Reporting uses a private `@sentry/core` client loaded on first use, so
  it never touches a host application's own Sentry setup. Disable it with
  `configureTelemetry({ enabled: false })`, `OSERO_TELEMETRY=0`, or `DO_NOT_TRACK=1`. Hosted API
  requests to `*.osero.org` now carry a `sentry-trace` header so API-side events can be correlated.

- 5bca250: Add account-free local swap quotes.

  The new `quoteSwap` action returns block-pinned swap economics without requiring an account,
  reading allowances, constructing calldata, or creating an execution plan.

### Patch Changes

- Promote the prerelease line to a stable release.
- 8562478: Call the hosted API fetch implementation as a plain function instead of as a method, so browsers
  that enforce the fetch receiver no longer throw `TypeError: Illegal invocation`. This applies to
  both the default global fetch and a caller-supplied `fetch` override.
- c50ab01: Allow `@privy-io/node` 0.34 as a peer dependency.
- b11897f: Reject hosted quote approval steps whose required amount exceeds the exact-input quote amount.
- Integrate the pnpm 12, Changesets 3, Turborepo, and TypeScript 7 tooling upgrades into the v1 prerelease branch while preserving release validation and prerelease publishing safeguards.
- 875222b: Widen `SDK_VERSION` to `string` so the published declaration no longer embeds the release version and the public API report stays stable across releases.
- 11021ed: Replace Nx with Turborepo for workspace orchestration and compile the SDK with TypeScript 7.

## 1.0.0-next.6

### Major Changes

- Replace the 0.x pair-specific preview/action surface with a single typed `prepareSwap` API. It
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

- Require slippage inputs to name basis points explicitly.

  `parseSlippage` now accepts `{ bps: string }`, rejecting the legacy unitless string input.

- Replace legacy bridge-status requests and responses with normalized Transfer Status. Status requests
  now keep the source transaction hash and complete quote Status Context together, known Enso and LI.FI
  Provider Details are typed, and unknown providers remain inspectable. Polling continues for pending
  and unknown states and returns completed or failed Transfer Status observations without discarding
  provider diagnostics.
- Replace the legacy hosted quote response with the provider-neutral API contract. Same-chain quotes
  now return a `ready-to-execute` Hosted Swap Workflow containing the normalized API quote and a
  separate execution-only, expiry-bound Wallet Execution Plan. Enso and LI.FI Provider Details are
  typed, unknown providers remain inspectable and executable, and hosted approval policy is removed.
- Publish the breaking v1 hosted API migration as a provider-neutral Hosted Swap Workflow. Replace
  the legacy Enso-shaped quote and bridge status with discriminated approval and ready states,
  provider-locked Quote Refresh, expiry-bound Wallet Execution Plans, bounded high-level execution,
  and normalized Transfer Status polling.
- Support the hosted API's 0x integration.

  `'0x'` joins `'enso'` and `'lifi'` as a first-class Quote Provider across every
  provider discriminator. 0x is one provider spanning the same-chain 0x Swap API
  and the 0x Cross-Chain API, so it reports a single tag either way, and its
  allowance requirements arrive as ordinary Approval Steps bound to the returned
  spender.

  - `isOseroApiZeroXProviderDetails` narrows quote Provider Details to the 0x
    support id, curated route, gas and network-fee estimates, and the
    `integratorFee` / `zeroExFee` / `bridgeNativeFee` breakdown.
    `quote.expectedOutput` is already net of all three.
  - Status Context is now a provider-discriminated union. A 0x context carries
    the required `providerQuoteId`, which is serialized into every status poll;
    polling a 0x context without it fails locally as a `ValidationError`.
    Unrecognised primitive fields from a future provider's context are echoed
    back unchanged instead of dropped.
  - `isOseroApiZeroXTransferStatusProviderDetails` narrows Transfer Status
    Provider Details to the original 0x status, failure reason, and recovery
    status.
  - Every Transfer Status gains a nullable `recoveryContext` with normalized
    `state` and `reason`, so a failed cross-chain transfer is no longer
    unconditionally terminal. `waitForSwapCompletion` accepts `waitForRecovery`
    to keep polling while automatic recovery is pending.
  - `prepareRecoveryExecutionPlan(status, submitter)` turns a sender-free
    Recovery Action into a wallet-agnostic Execution Plan under the new
    `RECOVER_CROSS_CHAIN_TRANSFER` operation. A recovery deadline becomes the
    plan's quote expiry, so adapters refuse a closed window. Only a `failed`
    transfer whose recovery is `action-required` authorizes a submission; every
    other state is rejected rather than built into a signable plan, and
    `isOseroApiActionableRecovery` narrows to that one submittable combination.

### Minor Changes

- Add manual hosted Approval Step and provider-locked Quote Refresh transitions. Insufficient
  allowance now returns one exact approval-only Wallet Execution Plan, while refreshed quotes restart
  allowance preparation before exposing replacement execution calldata.
- Add an opt-in EIP-5792 wallet adapter.

  The adapter submits pending execution-plan steps as one atomic call batch when the wallet supports
  it and falls back to sequential viem execution by default. `prepareSwap({ execution: 'atomic-batch' })`
  marks the plan so a capable wallet must send every pending step in one bundle. Mainnet USDC to sUSDS
  then sizes the USDS approval and deposit as the 1:1 scaled USDC amount.

- Add a bounded wallet-neutral Hosted Swap Workflow executor. It confirms one approval at a time,
  performs provider-locked Quote Refreshes after approvals or expiry, emits serialized lifecycle
  progress, and returns the final quote with every confirmed wallet result.
- Add optional hosted quote expiry constraints to Wallet Execution Plans. Expiry now participates in
  plan identity and persistence, and viem, ethers, and Privy executions fail with a typed
  `QuoteExpiredError` when the quote expires before broadcast.
- Add opt-out error telemetry.

  The SDK now reports a curated subset of the typed errors it returns — SDK bugs, hosted API contract
  drift, server-side API failures, and failed on-chain executions — to Osero's Sentry project. Caller
  mistakes, user cancellations, wallet signing failures, network and RPC outages, quote expiry, and
  API key or rate-limit responses are never reported, and API keys, headers, wallet addresses, and
  amounts are never attached. Reporting uses a private `@sentry/core` client loaded on first use, so
  it never touches a host application's own Sentry setup. Disable it with
  `configureTelemetry({ enabled: false })`, `OSERO_TELEMETRY=0`, or `DO_NOT_TRACK=1`. Hosted API
  requests to `*.osero.org` now carry a `sentry-trace` header so API-side events can be correlated.

- Add account-free local swap quotes.

  The new `quoteSwap` action returns block-pinned swap economics without requiring an account,
  reading allowances, constructing calldata, or creating an execution plan.

### Patch Changes

- Call the hosted API fetch implementation as a plain function instead of as a method, so browsers
  that enforce the fetch receiver no longer throw `TypeError: Illegal invocation`. This applies to
  both the default global fetch and a caller-supplied `fetch` override.
- c50ab01: Allow `@privy-io/node` 0.34 as a peer dependency.
- Reject hosted quote approval steps whose required amount exceeds the exact-input quote amount.
- Integrate the pnpm 12, Changesets 3, Turborepo, and TypeScript 7 tooling upgrades into the v1 prerelease branch while preserving release validation and prerelease publishing safeguards.
- Widen `SDK_VERSION` to `string` so the published declaration no longer embeds the release version and the public API report stays stable across releases.
- 11021ed: Replace Nx with Turborepo for workspace orchestration and compile the SDK with TypeScript 7.

## 1.0.0-next.5

### Minor Changes

- 0cf4e72: Add opt-out error telemetry.

  The SDK now reports a curated subset of the typed errors it returns — SDK bugs, hosted API contract
  drift, server-side API failures, and failed on-chain executions — to Osero's Sentry project. Caller
  mistakes, user cancellations, wallet signing failures, network and RPC outages, quote expiry, and
  API key or rate-limit responses are never reported, and API keys, headers, wallet addresses, and
  amounts are never attached. Reporting uses a private `@sentry/core` client loaded on first use, so
  it never touches a host application's own Sentry setup. Disable it with
  `configureTelemetry({ enabled: false })`, `OSERO_TELEMETRY=0`, or `DO_NOT_TRACK=1`. Hosted API
  requests to `*.osero.org` now carry a `sentry-trace` header so API-side events can be correlated.

### Patch Changes

- b11897f: Reject hosted quote approval steps whose required amount exceeds the exact-input quote amount.
- 875222b: Widen `SDK_VERSION` to `string` so the published declaration no longer embeds the release version and the public API report stays stable across releases.

## 1.0.0-next.4

### Minor Changes

- 32d4137: Add an opt-in EIP-5792 wallet adapter.

  The adapter submits pending execution-plan steps as one atomic call batch when the wallet supports
  it and falls back to sequential viem execution by default. `prepareSwap({ execution: 'atomic-batch' })`
  marks the plan so a capable wallet must send every pending step in one bundle. Mainnet USDC to sUSDS
  then sizes the USDS approval and deposit as the 1:1 scaled USDC amount.

## 1.0.0-next.3

### Major Changes

- 5bca250: Require slippage inputs to name basis points explicitly.

  `parseSlippage` now accepts `{ bps: string }`, rejecting the legacy unitless string input.

- 4b8ac15: Support the hosted API's 0x integration.

  `'0x'` joins `'enso'` and `'lifi'` as a first-class Quote Provider across every
  provider discriminator. 0x is one provider spanning the same-chain 0x Swap API
  and the 0x Cross-Chain API, so it reports a single tag either way, and its
  allowance requirements arrive as ordinary Approval Steps bound to the returned
  spender.

  - `isOseroApiZeroXProviderDetails` narrows quote Provider Details to the 0x
    support id, curated route, gas and network-fee estimates, and the
    `integratorFee` / `zeroExFee` / `bridgeNativeFee` breakdown.
    `quote.expectedOutput` is already net of all three.
  - Status Context is now a provider-discriminated union. A 0x context carries
    the required `providerQuoteId`, which is serialized into every status poll;
    polling a 0x context without it fails locally as a `ValidationError`.
    Unrecognised primitive fields from a future provider's context are echoed
    back unchanged instead of dropped.
  - `isOseroApiZeroXTransferStatusProviderDetails` narrows Transfer Status
    Provider Details to the original 0x status, failure reason, and recovery
    status.
  - Every Transfer Status gains a nullable `recoveryContext` with normalized
    `state` and `reason`, so a failed cross-chain transfer is no longer
    unconditionally terminal. `waitForSwapCompletion` accepts `waitForRecovery`
    to keep polling while automatic recovery is pending.
  - `prepareRecoveryExecutionPlan(status, submitter)` turns a sender-free
    Recovery Action into a wallet-agnostic Execution Plan under the new
    `RECOVER_CROSS_CHAIN_TRANSFER` operation. A recovery deadline becomes the
    plan's quote expiry, so adapters refuse a closed window. Only a `failed`
    transfer whose recovery is `action-required` authorizes a submission; every
    other state is rejected rather than built into a signable plan, and
    `isOseroApiActionableRecovery` narrows to that one submittable combination.

### Minor Changes

- 5bca250: Add account-free local swap quotes.

  The new `quoteSwap` action returns block-pinned swap economics without requiring an account,
  reading allowances, constructing calldata, or creating an execution plan.

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
