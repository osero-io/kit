# Upgrade from 0.8.0 to 1.0

`@osero/client` 1.0 is a deliberate breaking release. It replaces pair-specific local action builders, ambiguous primitive inputs, nested plans, broad errors, and permissive execution defaults with one preparation model that is safe to persist and execute in production.

This guide uses `0.8.0`, the last 0.x release, as its starting point. The hosted API also moves from an sUSDS-shaped allowlist and Enso-shaped response to a provider-neutral, refreshing Hosted Swap Workflow. There is no compatibility mode for either the old local action surface or the old hosted response.

Upgrade the package and runtime together:

```sh
pnpm add @osero/client@^1.0.0 viem@'>=2.21.22 <3'
```

Version 1 requires Node.js 20 or newer and ESM. Install `ethers@^6.14.0` or `@privy-io/node@^0.19.0` only when using that adapter.

## Migration sequence

1. Configure explicit RPC transports.
2. Replace primitive amounts/slippage/referrals with domain constructors.
3. Replace preview + action calls with one `prepareSwap` call.
4. Update plan inspection from nested variants to `plan.steps`.
5. Update adapters to pass explicit options and consume rich transaction results.
6. Switch error handling to stable `error.code` discriminants.
7. If applicable, migrate the hosted request, response, execution, refresh, and status lifecycle as one change.

## Client configuration

### RPC fallback is no longer implicit

0.x could silently use viem public fallback RPCs. 1.0 requires a configured transport unless the application explicitly opts into that policy:

```ts
import { OseroClient } from '@osero/client';
import { http } from 'viem';

const client = OseroClient.create({
  transports: {
    1: http(process.env.ETHEREUM_RPC_URL),
    8453: http(process.env.BASE_RPC_URL),
  },
});
```

`client.getPublicClient(chainId)` now returns a typed result. `allowPublicRpc: true` remains available for applications that knowingly accept public endpoint limits.

### Defaults are domain values and explicit policies

| 0.x                                           | 1.0                                                   |
| --------------------------------------------- | ----------------------------------------------------- |
| `defaultSlippageBps: 25`                      | `defaultSlippage: parseSlippage({ bps: '25' }).value` |
| `defaultReferralCode: 3001n`                  | configured or request-level `referral`                |
| omitted referral inherited built-in `3000n`   | default is no attribution                             |
| implicit public RPC                           | `allowPublicRpc: true` opt-in                         |
| executor confirmation hidden in client config | executor `confirmations` option                       |

Constructors reject malformed runtime data before it reaches ABI encoding:

```ts
import { parseSlippage, referral, tokenAmount } from '@osero/client';
import { parseUnits } from 'viem';

const amount = tokenAmount('USDC', parseUnits('10', 6));
const slippage = parseSlippage({ bps: '25' }); // explicit decimal basis-point string
const attribution = referral(3001n); // explicit referral domain value

if (amount.isErr() || slippage.isErr() || attribution.isErr()) {
  // Handle ValidationError
}
```

Do not cast arbitrary values to branded domain types. Constructors are the runtime boundary.

If `OseroClient` is configured with `referral`, an omitted request-level referral inherits it; pass `referral: false` to opt out for one request. Prefer request-level referrals when one client prepares routes with different capabilities. Unlike 0.8.0, a route whose ABI cannot carry attribution rejects a configured referral instead of silently ignoring it. For example, Ethereum mainnet USDC → USDS does not support referral attribution.

## Local actions become `quoteSwap` and `prepareSwap`

0.x exposed separate preview/action functions such as `previewMintUsds`, `mintUsds`, `previewMintSUsds`, `mintSUsds`, `previewRedeemUsds`, `redeemUsds`, `previewRedeemSUsds`, and `redeemSUsds`.

1.0 removes them. Use account-free `quoteSwap` for display and discovery, then `prepareSwap` for an account-bound execution plan:

```ts
import { OseroClient, tokenAmount } from '@osero/client';
import { prepareSwap, quoteSwap } from '@osero/client/actions';
import { parseUnits } from 'viem';

const amountIn = tokenAmount('USDC', parseUnits('10', 6));
if (amountIn.isErr()) throw amountIn.error;

const quoted = await quoteSwap(client, {
  chainId: 8453,
  mode: 'exact-in',
  amountIn: amountIn.value,
  assetOut: 'sUSDS',
});
if (quoted.isErr()) throw quoted.error;
console.log(quoted.value.expectedAmountOut);

const prepared = await prepareSwap(client, {
  chainId: 8453,
  account,
  mode: 'exact-in',
  amountIn: amountIn.value,
  assetOut: 'sUSDS',
  approvalPolicy: 'exact',
});

if (prepared.isErr()) {
  console.error(prepared.error.code, prepared.error.toJSON());
  return;
}

console.log(prepared.value.expectedAmountOut);
console.log(prepared.value.minimumAmountOut);
console.log(prepared.value.route);
console.log(prepared.value.plan);
```

`quoteSwap` performs only chain reads and never requires an account, checks allowances, or returns a plan. `prepareSwap` always performs its own coherent read pass and returns a fresh quote with its exact execution plan. Treat an earlier account-free quote as display data, not as plan-bound or guaranteed current.

On PSM3 chains, use this mapping when replacing 0.8.0 action and preview calls:

| 0.8.0 call                           | 1.0 `prepareSwap` exact-input request                              |
| ------------------------------------ | ------------------------------------------------------------------ |
| `previewMintUsds` / `mintUsds`       | `amountIn: tokenAmount('USDC', amount).value`, `assetOut: 'USDS'`  |
| `previewMintSUsds` / `mintSUsds`     | `amountIn: tokenAmount('USDC', amount).value`, `assetOut: 'sUSDS'` |
| `previewRedeemUsds` / `redeemUsds`   | `amountIn: tokenAmount('USDS', amount).value`, `assetOut: 'USDC'`  |
| `previewRedeemSUsds` / `redeemSUsds` | `amountIn: tokenAmount('sUSDS', amount).value`, `assetOut: 'USDC'` |

Rename `sender` to `account`; `receiver` remains optional and still defaults to that account. The v1 plan is bound to `account`, even when output goes to a different receiver. Rename request-level `slippageBps` to constructed `slippage`, and `referralCode` to constructed `referral`. The old preview result was a bare `bigint`; read `expectedAmountOut.raw` from a successful account-free or prepared exact-input quote when raw units are needed.

Ethereum mainnet has two important differences:

- USDC → USDS and USDC → sUSDS remain exact-input routes, but their deployed contracts cannot enforce the quoted minimum. Set `allowUnprotectedSlippage: true` only after the application explicitly accepts that limitation.
- 0.8.0 `redeemUsds` accepted a USDS budget but called the exact-output Lite PSM function internally. V1 exposes this truthfully: choose the desired USDC output and use `{ mode: 'exact-out', assetIn: 'USDS', amountOut: tokenAmount('USDC', desiredOutput).value }`. There is no mechanical mainnet exact-input replacement. Mainnet sUSDS → USDC remains exact-input.

### Exact output

1.0 supports exact-output preparation only where the deployed route can safely provide it:

```ts
const amountOut = tokenAmount('USDS', parseUnits('100', 18));
if (amountOut.isErr()) throw amountOut.error;

const prepared = await prepareSwap(client, {
  chainId: 8453,
  account,
  mode: 'exact-out',
  assetIn: 'USDC',
  amountOut: amountOut.value,
});

if (prepared.isOk()) {
  console.log(prepared.value.expectedAmountIn);
  console.log(prepared.value.maximumAmountIn);
}
```

The maximum input uses upward rounding. Unsupported pair/mode combinations return `ValidationError` rather than silently routing through a generic ABI.

### Slippage protection is truthful

Prepared quotes identify whether the minimum/maximum is enforced by calldata, by an allowance cap, or cannot be enforced by the deployed route. A route with no enforceable bound requires `allowUnprotectedSlippage: true`; merely supplying a slippage value is not consent.

## Approval policy

0.x plan builders routinely emitted approvals without checking current allowance. 1.0 reads allowance and applies an explicit policy:

- `exact` (default): approve the required amount only when needed;
- `max`: opt into `uint256.max` approval;
- `none`: never approve; insufficient allowance is an error.

Plan metadata records the observed allowance, block, required amount, and decision. Treat it as preparation-time evidence, not a race-free reservation.

## Execution plans

### Flat, versioned steps

0.x exposed nested `TransactionRequest`, `Erc20ApprovalRequired`, and `MultiStepExecution` variants and helpers such as `flattenExecutionPlan`.

1.0 exposes one shape:

```ts
for (const step of prepared.value.plan.steps) {
  console.log(step.id, step.operation, step.chainId, step.from, step.to);
}
```

Each plan has:

- schema version;
- deterministic plan ID/checksum;
- bound account and chain;
- ordered transaction steps with stable IDs;
- preparation metadata and executor requirements.

`flattenExecutionPlan`, `isTransactionRequest`, `isErc20ApprovalRequired`, and `isMultiStepExecution` are removed because the public plan is already flat.

If the application constructs custom plans, migrate the builders as well:

| 0.8.0 builder                                                             | 1.0 replacement                                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `makeTransactionRequest`                                                  | `createTransactionRequest`; supply a stable `id` and handle its `Result`                             |
| `makeApprovalTransaction`                                                 | `createApprovalTransaction`; supply a stable `id` and handle its `Result`                            |
| `makeApprovalRequiredPlan`, `makeSingleApprovalPlan`, `makeMultiStepPlan` | create ordered transaction steps, then call `createExecutionPlan({ steps })` and handle its `Result` |

Update exhaustive `OperationType` switches too. V1 adds `SWAP_EXACT_IN`, `SWAP_EXACT_OUT`, and `WITHDRAW_USDS_FROM_SUSDS`, and removes `MINT_SUSDS` and `REDEEM_SUSDS_FOR_USDC`. Operation tags describe transactions; use prepared route or hosted pair metadata for user-facing swap labels.

### Persistence and recovery

Use canonical serializers instead of raw `JSON.stringify` so bigint and checksum validation remain correct:

```ts
import {
  deserializeExecutionPlan,
  resumeExecutionPlan,
  serializeExecutionPlan,
} from '@osero/client';

const encoded = serializeExecutionPlan(plan);
if (encoded.isErr()) throw encoded.error;

const restored = deserializeExecutionPlan(encoded.value);
if (restored.isErr()) throw restored.error;

const resumed = resumeExecutionPlan(restored.value, persistedResumeState);
if (resumed.isErr()) throw resumed.error;
```

A confirmation failure carries the submitted hash and confirmed prefix. Persist that context before retrying. Adapters verify receipts for the prefix before skipping steps.

## Wallet adapters

All adapters now preflight the complete plan before transaction 1. Account mismatch, chain mismatch, invalid later steps, malformed options, unsupported capabilities, and invalid resume proofs cause zero broadcasts.

### viem

```ts
import { sendWith } from '@osero/client/viem';

const result = await sendWith(walletClient, prepared.value.plan, {
  confirmations: 2,
  confirmationTimeoutMs: 120_000,
  onProgress: persistProgress,
});
```

### ethers

```ts
import { sendWith } from '@osero/client/ethers';

const result = await sendWith(signer, prepared.value.plan, {
  confirmations: 2,
});
```

The signer must already be connected to the plan chain. 1.0 does not attempt network switching. Replacement receipts retain both submitted and effective hashes.

### Privy

```ts
import { sendWith } from '@osero/client/privy';

const result = await sendWith(privy, wallet, prepared.value.plan, {
  chainId: prepared.value.route.chainId,
  transport,
  confirmations: 2,
  idempotencyKeys: Object.fromEntries(
    prepared.value.plan.steps.map((step) => [step.id, `${prepared.value.plan.id}:${step.id}`]),
  ),
});
```

The adapter requires an explicit chain binding and a receipt source (transport or receipt client unless public RPC opt-in is intentional). Idempotency keys are validated for every step before execution. Privy responses without a standard EVM transaction hash return `UnsupportedCapabilityError`.

### Gas and result changes

The viem and ethers adapters freshly estimate gas and apply a bounded buffer. Privy delegates gas selection to the Privy Wallet API. A hosted/local gas estimate is advisory provenance, not an automatic hard limit.

0.x results centered one `txHash` and operation array. 1.0 returns ordered confirmed transactions:

```ts
if (result.isOk()) {
  for (const transaction of result.value.transactions) {
    console.log({
      submittedHash: transaction.submittedHash,
      effectiveHash: transaction.hash,
      operation: transaction.operation,
      receipt: transaction.confirmation,
    });
  }
}
```

## Error handling

Every public SDK error has literal `name` and `code` fields and JSON-safe contextual output. Narrow on `code`:

```ts
if (result.isErr()) {
  switch (result.error.code) {
    case 'ACCOUNT_MISMATCH':
    case 'CHAIN_MISMATCH':
      // Preflight failed; nothing was sent.
      break;
    case 'SIGNING_FAILED':
      break;
    case 'BROADCAST_FAILED':
      break;
    case 'CONFIRMATION_FAILED':
      persist(result.error.execution);
      break;
    case 'TRANSACTION_REVERTED':
      break;
    default:
      console.error(result.error.toJSON());
  }
}
```

Operational APIs remain non-throwing even when user callbacks or transport/provider methods throw. Static constructors can throw `ConfigurationError` for invalid configuration.

## Hosted API

The v1 hosted contract is a breaking replacement for the 0.8.0 Enso-shaped quote and bridge-status contract. There is no compatibility decoder or fallback. Migrate these boundaries together:

1. client configuration;
2. quote request construction;
3. quote response inspection;
4. approvals, expiry, and wallet execution;
5. cross-chain Transfer Status.

In 0.8.0, `getSwapQuote()` returned one `OseroApiSwapQuote` whose `executionPlan` was intended to be sent linearly. In 1.0 it returns an `OseroApiHostedSwapWorkflow`: either one approval that is safe now, or one fresh execution action that is safe now.

### Configure API keys and allowance reads

The 0.8.0 client required one static API key:

```ts
const api = OseroApiClient.create({ apiKey: process.env.OSERO_API_KEY! });
```

That remains valid in 1.0. A rotating or tenant-specific key may instead be supplied by `apiKeyProvider`; a request-level `options.apiKey` still overrides both:

```ts
import { OseroApiClient } from '@osero/client/api';

const api = OseroApiClient.create({
  apiKeyProvider: () => loadApiKeyForCurrentTenant(),
  publicClientProvider: async (chainId) => {
    const client = publicClients[chainId];
    if (client === undefined) throw new Error(`No public client for chain ${chainId}`);
    return client;
  },
});
```

API key precedence is request override, `apiKeyProvider`, then static `apiKey`. Empty keys or keys containing whitespace, controls, or non-ASCII characters fail locally. A printable key rejected by server policy is a 401 `ApiRequestError`.

A quote may contain Approval Steps. When at least one step has a positive required amount, the SDK needs `publicClientProvider` to read the source-chain allowance and expose only the first currently required approval. Quotes without a positive-amount Approval Step do not require this provider. The returned client must match the requested chain and implement `getBlockNumber` and `readContract`.

Hosted chain support is independent from the local-action `SUPPORTED_CHAIN_IDS` registry. Do not route hosted requests through `OseroClient.getPublicClient()` unless that local client actually supports every hosted source chain your application accepts.

### Construct the new quote request

The request is no longer a direction-specific `OseroApiToSusdsQuoteRequest | OseroApiFromSusdsQuoteRequest`. It is one open-pair request with constructed amount, slippage, and referral values.

```ts
// 0.8.0
const quote = await api.getSwapQuote({
  fromAddress: account,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: 1_000_000n,
  slippage: '0.5',
  referralCode: 3001,
});
```

```ts
// 1.0
import { parseSlippage, referral } from '@osero/client';
import { oseroApiAmount } from '@osero/client/api';
import { parseUnits } from 'viem';

const amount = oseroApiAmount(parseUnits('1', 6));
const slippage = parseSlippage({ bps: '50' }); // 50 bps = 0.5%
const attribution = referral(3001n);
if (amount.isErr() || slippage.isErr() || attribution.isErr()) {
  throw new Error('invalid quote input');
}

const workflow = await api.getSwapQuote({
  fromAddress: account,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: amount.value,
  slippage: slippage.value,
  referral: attribution.value,
});
```

Request field changes:

| 0.8.0                                                           | 1.0                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `OseroApiToSusdsQuoteRequest` / `OseroApiFromSusdsQuoteRequest` | `OseroApiSwapQuoteRequest`                                                |
| `amount`: `bigint` or `OseroApiIntegerString`                   | `amount: OseroApiInputAmount`; create with `oseroApiAmount(bigint).value` |
| `slippage: string` in percent                                   | `slippage: parseSlippage({ bps: bpsString }).value`                       |
| `referralCode: number`                                          | `referral: referral(BigInt(code)).value`                                  |
| only counter asset ↔ sUSDS pairs                                | any well-formed `OseroApiAssetRef`; the API decides support               |

Omitting `referral` means no attribution. There is no hosted `approvalPolicy`: remove it if the application adopted an intermediate v1 prerelease. Approval transactions and amounts come from the API and are safety-checked by the SDK.

### Asset refs are API-authoritative

`getSwapQuote` accepts any of these forms:

```ts
fromAssetId: 'base:usdc'; // known canonical ID
fromAssetId: 'future-chain:future-token'; // arbitrary non-empty API ID
fromAssetId: { chainId: 8453, address: tokenAddress }; // ERC-20 locator
```

The locator is encoded as `"<chainId>:<lowercase-address>"`. The hosted API—not a shipped SDK allowlist—decides whether an asset or pair is supported.

`OSERO_API_KNOWN_*` exports are advisory autocomplete/offline snapshots. Use `getSupportedAssets()` for the live sanctioned list and `matchOseroApiAsset(assets, ref)` for optional UI preflight.

| Removed 0.8.0 API                                              | 1.0 replacement                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `OSERO_API_COUNTER_ASSETS`, `OSERO_API_VAULT_ASSET`            | `OSERO_API_KNOWN_ASSETS` advisory snapshot                               |
| `OSERO_API_COUNTER_ASSET_IDS`, `OSERO_API_PUBLIC_ASSET_IDS`    | `OSERO_API_KNOWN_ASSET_IDS` advisory snapshot                            |
| `OSERO_API_CHAINS`, `OSERO_API_CHAIN_IDS`                      | `OSERO_API_KNOWN_CHAINS`, `OSERO_API_KNOWN_CHAIN_IDS`                    |
| `OSERO_API_SOURCE_CHAIN_IDS`, `OseroApiSourceChainId`          | open positive `OseroApiChainId` values decoded from the API              |
| `OSERO_API_BRIDGE_PROTOCOLS`                                   | `OSERO_API_KNOWN_BRIDGE_PROTOCOLS` advisory snapshot                     |
| `OseroApiPublicAssetId`, `OseroApiCounterAssetId`              | `OseroApiAssetRef`; use `OseroApiKnownAssetId` only for the known subset |
| `OseroApiToSusdsQuoteRequest`, `OseroApiFromSusdsQuoteRequest` | `OseroApiSwapQuoteRequest`                                               |

Previously local policy failures now come from the server as `ApiRequestError` with `code === 'API_REQUEST_FAILED'` and, when supplied, a stable `apiCode` such as `SWAP_ASSET_NOT_SUPPORTED`, `SWAP_PAIR_NOT_SUPPORTED`, `SLIPPAGE_INVALID`, or `SLIPPAGE_OUT_OF_RANGE`.

Responses accept unknown future assets, chains, protocols, and Quote Providers. Keep a default branch when displaying these open vocabularies. Fields required for transaction safety and normalized Transfer Status states remain strict.

### Replace old quote field access

The 0.8.0 response shape is not decoded by 1.0. Update all stored fixtures, mocks, destructuring, and UI selectors.

| 0.8.0                          | 1.0                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- |
| result was `OseroApiSwapQuote` | result is `OseroApiHostedSwapWorkflow`; normalized quote is `workflow.quote` |
| `pair.direction`               | removed                                                                      |
| `pair.from` / `pair.to`        | `pair.source` / `pair.destination`                                           |
| `quote.amountIn`               | `quote.inputAmount`                                                          |
| nullable `quote.amountOut`     | non-null `quote.expectedOutput`                                              |
| `quote.previewUnavailable`     | removed                                                                      |
| `quote.createdAt`              | `quote.quotedAt`                                                             |
| no quote expiry                | `quote.expiresAt`                                                            |
| top-level `approval`           | `executionPlan.approvalSteps[]`                                              |
| top-level `execution`          | `executionPlan.executionStep` and `routeSummary`                             |
| `bridge.required`              | `routeSummary.kind === 'cross-chain'` or `statusContext !== null`            |
| `bridge.protocol`              | `routeSummary.bridge`                                                        |
| `bridge.statusRequest`         | `statusContext`                                                              |
| no provider metadata           | `provider` and `providerDetails`                                             |

For example:

```ts
if (workflow.isErr()) throw workflow.error;

const { quote } = workflow.value;
console.log(quote.pair.source.label, '→', quote.pair.destination.label);
console.log(quote.quote.inputAmount.formatted);
console.log(quote.quote.expectedOutput.formatted);
console.log(quote.quote.minimumOutput);
console.log(quote.quote.referralAttribution.status);
console.log(quote.provider, quote.routeSummary.bridge);
```

All hosted execution transactions now use operation `SWAP_EXACT_IN`. Do not use operation tags to produce mint/redeem copy; derive labels from `quote.pair.source` and `quote.pair.destination`.

The API chooses the Quote Provider. Do not send an Enso, LI.FI, or 0x hint on the initial request. Use `quote.provider` for attribution and the exported `isOseroApiEnsoProviderDetails()`, `isOseroApiLifiProviderDetails()`, and `isOseroApiZeroXProviderDetails()` guards only for provider-specific diagnostics. Unknown providers and their opaque details remain valid and executable.

0x can win any pair in the public matrix, on the same chain or across chains, and reports one `'0x'` provider tag either way. Its Provider Details expose the 0x support id (`zid`), a curated route, gas and network-fee estimates, and a `fees` breakdown of the Osero Integrator Fee, the 0x fee, and any bridge-native fee. `quote.expectedOutput` is already net of all of them — displaying it minus Provider Details fees double-counts. A bridge-native fee is paid through the execution transaction's native `value`, not deducted from the source token. A 0x allowance requirement is an ordinary Approval Step: spend against the returned `spender` and never a hardcoded AllowanceHolder address.

### API and Wallet Execution Plans

This distinction is the most important hosted migration:

- `workflow.quote.executionPlan` is the **API Execution Plan**. It describes all conditional Approval Steps and the final quoted execution for diagnostics.
- `workflow.walletExecutionPlan` is the **Wallet Execution Plan**. It contains only the transaction currently safe to submit.

Never pass `workflow.quote.executionPlan` to `sendWith`, convert it into a local plan, or submit its steps sequentially. An approval changes allowance state and invalidates all remaining quote calldata.

`getSwapQuote` and `refreshSwapQuote` instead return a discriminated Hosted Swap Workflow. Its `walletExecutionPlan` contains only actions that are currently safe to submit:

```ts
const workflow = await api.getSwapQuote(request);
if (workflow.isErr()) throw workflow.error;

if (workflow.value.state === 'approval-required') {
  const approval = await sendWith(walletClient)(workflow.value.walletExecutionPlan);
  if (approval.isErr()) throw approval.error;

  const refreshed = await api.refreshSwapQuote(workflow.value.quote.refreshContext);
  if (refreshed.isErr()) throw refreshed.error;
  // Discard both old plans. Inspect refreshed.value.state and repeat.
} else {
  const execution = await sendWith(walletClient)(workflow.value.walletExecutionPlan);
  if (execution.isErr()) throw execution.error;
}
```

An `approval-required` Wallet Execution Plan contains exactly one approval. After it confirms, discard the old API and Wallet Execution Plans and call `refreshSwapQuote()` with the exact returned `refreshContext`. The refresh is provider-locked and does not repeat provider selection. Repeat until the state is `ready-to-execute`.

Use this manual boundary when the application must prompt, persist, pause, or resume. Persist `refreshContext` with the pending workflow; do not reconstruct it from display fields.

### Handle hosted quote expiry

Hosted Wallet Execution Plans are `ExecutionPlan` version 2 and bind `quoteExpiresAt` to the plan checksum and serialized form. Local plans remain version 1. Each adapter checks expiry immediately before wallet submission; viem and ethers do so after fresh gas estimation. At `Date.now() >= Date.parse(quoteExpiresAt)`, execution returns `QuoteExpiredError` with `code === 'QUOTE_EXPIRED'` and broadcasts nothing for that attempt.

In a manual lifecycle, refresh and re-evaluate the state:

```ts
const sent = await sendWith(walletClient)(workflow.value.walletExecutionPlan);

if (sent.isErr() && sent.error.code === 'QUOTE_EXPIRED') {
  const refreshed = await api.refreshSwapQuote(workflow.value.quote.refreshContext);
  if (refreshed.isErr()) throw refreshed.error;
  // Replace the complete workflow. It may require an approval again.
}
```

Do not retry an expired Wallet Execution Plan. Because expiry participates in the plan ID, canonical `serializeExecutionPlan()` / `deserializeExecutionPlan()` preserves and validates it.

### Prefer `executeSwap` for an automatic lifecycle

When the application does not need a prompt or persistence boundary between approvals, use the high-level wallet-neutral executor:

```ts
const execution = await api.executeSwap(request, sendWith(walletClient), {
  approvalTransactionLimit: 3,
  quoteRefreshLimit: 5,
  signal: abortController.signal,
  onProgress: (event) => persist(event),
});

if (execution.isErr()) throw execution.error;

const { approvalResults, executionResult, finalQuote } = execution.value;
console.log(approvalResults.length, executionResult.txHash, finalQuote.provider);
```

`executeSwap()`:

1. requests the initial workflow;
2. submits and confirms at most one approval at a time;
3. performs a provider-locked refresh after each approval;
4. refreshes when a ready quote expires before broadcast;
5. submits only a fresh execution-only plan;
6. returns every approval result, the final quote, and source-chain execution result.

The defaults are three approval transactions and five Quote Refreshes. Override them with positive integers only when the application has an explicit policy. Exhaustion returns `APPROVAL_LIMIT_EXCEEDED` or `QUOTE_REFRESH_LIMIT_EXCEEDED`, preserving confirmed `approvalResults` for recovery.

`onProgress` may be async. Its events are `quote-received`, `approval-required`, `approval-confirmed`, `quote-refresh`, `ready-to-execute`, and `execution-confirmed`. Callback failure, cancellation, wallet failure, HTTP failure, and limit exhaustion remain distinct typed results. Do not start another execution from a progress callback; events describe the serialized lifecycle already owned by `executeSwap()`.

### Transfer Status

The Hosted Swap Workflow ends at source-chain confirmation. Replace the old bridge-status fields with the normalized Transfer Status lifecycle.

For a single status read, the method names remain `getSwapStatus()` and `getSwapStatusForQuote()`, but their request and return types changed:

```ts
// 0.8.0
await api.getSwapStatus({
  txHash: sourceTransactionHash,
  sourceChainId: 8453,
  bridgeProtocol: 'stargate',
});

// 1.0: preserve the complete context returned with the final quote.
if (finalQuote.statusContext !== null) {
  await api.getSwapStatus({
    sourceTransactionHash,
    statusContext: finalQuote.statusContext,
  });
}
```

Prefer the quote-aware polling helper for completion:

```ts
if (finalQuote.statusContext !== null) {
  const transfer = await api.waitForSwapCompletion(finalQuote, executionResult.txHash, {
    pollingIntervalMs: 5_000,
    timeoutMs: 30 * 60_000,
    signal: abortController.signal,
    onStatus: (status) => persist(status),
  });
  if (transfer.isErr()) throw transfer.error;
}
```

Always use `finalQuote` from the successful execution result, not the initial or pre-approval quote. Its Status Context keeps the Quote Provider, source chain, destination chain, and bridge together and must be sent unchanged.

Status Context is now a provider-discriminated union rather than one shape. A 0x context additionally carries `providerQuoteId` (0x's `quoteId`), which the client serializes into every status poll; polling a 0x context that lost it fails locally as a `ValidationError` before any HTTP request. Persist the whole object, not a hand-picked subset of its fields, and narrow with `isOseroApiZeroXStatusContext()` when you need the id itself.

The response is no longer nested under `bridge`:

| 0.8.0                             | 1.0                                      |
| --------------------------------- | ---------------------------------------- |
| `status.bridge.state`             | `status.state`                           |
| `status.bridge.protocol`          | `status.bridge`                          |
| `status.bridge.sourceTxHash`      | `status.sourceTransactionHash`           |
| `status.bridge.destinationTxHash` | `status.destinationTransactionHash`      |
| `status.bridge.error`             | `status.error`                           |
| `status.bridge.providerStatus`    | provider-native `status.providerDetails` |

`waitForSwapCompletion()` defaults to a 5-second polling interval and a 30-minute timeout; pass explicit values when those defaults do not match product policy. It supports `AbortSignal`, awaits async `onStatus` callbacks, and invokes the callback only when the complete status observation changes. It keeps polling both `pending` and `unknown`.

Both `completed` and `failed` are successful terminal `Result` values. A failed bridge transfer is not an SDK transport error, so inspect `status.state` and `status.error`. Same-chain quotes have `statusContext === null` and do not need polling; quote-aware status methods reject them locally before an HTTP request.

Use `isOseroApiEnsoTransferStatusProviderDetails()`, `isOseroApiLifiTransferStatusProviderDetails()`, or `isOseroApiZeroXTransferStatusProviderDetails()` for known provider diagnostics, with an unknown-provider fallback. Cancellation, timeout, transport failure, callback failure, and malformed responses remain typed SDK errors.

### Failed transfers can be recoverable

Every Transfer Status now carries a nullable `recoveryContext`. Treating `failed` as terminal-and-lost is a migration bug: inspect the context and drive the UI from its normalized `state`.

| `recoveryContext.state` | Client behavior                                                       |
| ----------------------- | --------------------------------------------------------------------- |
| `pending`               | Show automatic recovery in progress and keep polling with backoff.    |
| `completed`             | Show recovered funds from `chainId`, `tokenAddress`, `settledAmount`. |
| `action-required`       | Present the `deadline` and Recovery Action prominently.               |
| `not-required`          | Explain that funds did not leave or are already available.            |
| `unavailable`           | Stop automated recovery and direct the user to support.               |

`reason` normalizes to `expired`, `cancelled`, `out-of-gas`, `provider-failure`, or `unknown`; provider-native strings stay in `providerDetails` for diagnostics only. Pass `waitForRecovery: true` to `waitForSwapCompletion()` to keep polling while recovery is `pending` instead of returning the first failed observation.

A Recovery Action is intentionally sender-free — 0x recovery transactions may be submitted by any caller — so the SDK never injects the original wallet. Name the submitter and let `prepareRecoveryExecutionPlan()` build a wallet-agnostic plan:

```ts
if (isOseroApiActionableRecovery(transfer.value.recoveryContext)) {
  const plan = prepareRecoveryExecutionPlan(transfer.value, submitter);
  if (plan.isErr()) throw plan.error;
  const recovered = await sendWith(walletClient)(plan.value);
  if (recovered.isErr()) throw recovered.error;

  // Recovery status is tracked against the original source transaction.
  const settled = await api.waitForSwapCompletion(finalQuote, executionResult.txHash, {
    waitForRecovery: true,
  });
  if (settled.isErr()) throw settled.error;
}
```

Only a `failed` transfer whose recovery is `action-required` authorizes a submission; `prepareRecoveryExecutionPlan()` rejects every other state as a `ValidationError` rather than building a plan from calldata the API did not authorize. Use `isOseroApiActionableRecovery()` to narrow to that one submittable combination instead of testing `state` alone.

It carries the recipient, calldata, value, and gas limit through unchanged and leaves nonce and fee pricing to the wallet. A non-null `deadline` becomes the plan's quote expiry, so adapters reject a recovery whose window has closed. Osero never signs or submits a Recovery Action. Keep polling the original transfer after submission while recovery is still pending.

### Hosted removed-symbol reference

Use this table to clear remaining 0.8.0 imports after migrating behavior:

| Removed 0.8.0 symbol                                     | 1.0 replacement                                                |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `OseroApiSwapQuote`                                      | `OseroApiHostedSwapWorkflow`                                   |
| `swapQuoteToExecutionPlan`                               | no replacement; use `workflow.walletExecutionPlan`             |
| `OseroApiSwapQuoteInfo`                                  | `OseroApiSwapQuoteEconomics`                                   |
| `OseroApiSwapApproval`                                   | `OseroApiApprovalStep`                                         |
| `OseroApiSwapExecution`                                  | `OseroApiExecutionPlan` / `OseroApiExecutionStep`              |
| `OseroApiSwapBridge`                                     | `OseroApiRouteSummary` plus `OseroApiStatusContext`            |
| `OseroApiSwapDirection`                                  | removed; inspect `pair.source` and `pair.destination`          |
| `OseroApiSwapStatusRequest`                              | `OseroApiTransferStatusRequest`                                |
| `OseroApiSwapStatusResponse`, `OseroApiSwapStatusBridge` | `OseroApiTransferStatus`                                       |
| `OseroApiBridgeState`                                    | `OseroApiTransferState`                                        |
| `OseroApiBridgeProviderStatus`                           | `OseroApiTransferStatusProviderDetails`                        |
| `OseroApiSwapTransaction`                                | `OseroApiPreparedTransaction`                                  |
| `OseroApiSwapRouteHop`                                   | provider-specific details or normalized `OseroApiRouteSummary` |

## Reads, simulation, and APY

- `getTokenBalance` accepts a canonical symbol or validated ERC-20 address and reports contextual `RpcError` failures.
- `getTokenBalances` exposes `multicall: 'prefer' | 'require' | 'never'`; fallback occurs only when aggregate execution itself fails.
- `simulateExecutionPlan` reports pinned-block provenance, balances, allowances, fee data, and per-step estimates. Multi-step simulation is explicitly `independent-steps`, not sequential stateful simulation.
- `ssrToApy` returns `Result<number, ValidationError>` and uses stable log-domain compounding for values near RAY.

## Public import changes

Use only documented package subpaths:

```ts
import { OseroClient, tokenAmount } from '@osero/client';
import { prepareSwap, simulateExecutionPlan } from '@osero/client/actions';
import { OseroApiClient } from '@osero/client/api';
import { erc20Abi, psm3Abi } from '@osero/client/contracts';
import { sendWith } from '@osero/client/viem';
```

Deep imports under `@osero/client/src/*` or `@osero/client/dist/lib/*` are not public. The package export map enforces this boundary.

## Final checklist

- [ ] Every production chain has an explicit read transport.
- [ ] Every primitive amount/slippage/referral crosses a constructor.
- [ ] Every old preview + action pair is one `prepareSwap` call.
- [ ] Plan inspection reads `plan.steps` directly.
- [ ] Approvals use an explicit policy; `max` has user consent.
- [ ] Unprotected routes require explicit acknowledgement.
- [ ] Executors pass explicit confirmation/recovery options.
- [ ] Error branches narrow on literal `error.code`.
- [ ] Hosted requests use constructed amount, slippage, and referral values.
- [ ] Hosted API clients provide source-chain public clients for positive-amount Approval Steps.
- [ ] Only `workflow.walletExecutionPlan` is submitted; API Execution Plans remain diagnostic.
- [ ] Every confirmed hosted approval is followed by provider-locked Quote Refresh.
- [ ] Expired hosted plans are replaced, never retried.
- [ ] Cross-chain polling uses the final quote's complete Status Context, including `providerQuoteId` for 0x.
- [ ] Both `completed` and `failed` Transfer Status values are handled as terminal observations.
- [ ] A failed transfer's `recoveryContext` is inspected, and every recovery state has UI behavior.
- [ ] Recovery Actions are submitted through `prepareRecoveryExecutionPlan()` with an explicit submitter, and only from an `action-required` recovery.
- [ ] Status polling resumes after a Recovery Action is submitted.
- [ ] Quote display does not subtract Provider Details fees from `quote.expectedOutput` again.
- [ ] Persisted plans and resume state use canonical serializers.
- [ ] UI copy does not present independent simulation as guaranteed execution.
