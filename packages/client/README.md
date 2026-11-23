# @osero/client

Production TypeScript SDK for preparing, inspecting, simulating, and executing USDC, USDS, and sUSDS swaps through the deployed Sky/Spark liquidity routes supported by Osero.

The v1 API separates five responsibilities:

1. `OseroClient` owns explicit read transports and safe policy defaults.
2. `quoteSwap` returns account-free swap economics from a coherent block snapshot.
3. `prepareSwap` reads a fresh quote and binds it to an immutable, account-specific execution plan.
4. An executor adapter (`/viem`, `/eip5792`, `/ethers`, or `/privy`) preflights and executes that plan.
5. The hosted API client (`/api`) decodes untrusted responses, verifies transaction integrity, and prepares allowance-aware plans.

Every operational API returns `Result` or `ResultAsync`. Invalid runtime input, RPC failures, wallet mismatch, transaction failure, and completion timeout are values—not thrown exceptions. Constructors may throw `ConfigurationError` for invalid static configuration.

## Installation

```bash
pnpm add @osero/client viem
```

Add only the wallet adapter peer you use:

```bash
pnpm add ethers
# or
pnpm add @privy-io/node
```

Requirements:

- ESM
- viem `>=2.28.0 <3`
- ethers v6 for `@osero/client/ethers`
- `@privy-io/node` v0.19 for `@osero/client/privy`

Supported runtimes:

- **Node.js 20 or newer** for every entrypoint.
- **Modern browsers** that provide ES modules, `BigInt`, and a global `fetch`, for `@osero/client`, `/actions`, `/api`, `/contracts`, `/viem`, `/eip5792`, and `/ethers`. CI bundles each of these entrypoints for the browser with its dependencies and fails if any of them needs a Node.js built-in module (`pnpm browser:check`).
- `@osero/client/privy` wraps the server-side `@privy-io/node` SDK and is supported on Node.js only.

The peer ranges are tested at their floors: the packed-consumer check installs viem 2.28.0, ethers 6.14.0, and `@privy-io/node` 0.19.0 and typechecks every entrypoint against them.

## Public entrypoints

| Import path               | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `@osero/client`           | Client, domain values, plans, errors, chain/token discovery, balances, APY |
| `@osero/client/actions`   | `quoteSwap`, `prepareSwap`, and `simulateExecutionPlan`                    |
| `@osero/client/api`       | Hosted API client and hosted wire/domain types                             |
| `@osero/client/contracts` | Supported contract ABIs and protocol addresses                             |
| `@osero/client/viem`      | viem executor                                                              |
| `@osero/client/eip5792`   | EIP-5792 atomic batch executor with sequential fallback                    |
| `@osero/client/ethers`    | ethers v6 executor                                                         |
| `@osero/client/privy`     | Privy server-wallet executor                                               |

Unexported files under `src/lib` and `dist/lib` are implementation details. Package export-map enforcement prevents importing them as public subpaths.

Every operation returns a neverthrow `Result` or `ResultAsync`, and the root entrypoint exports those two as types only. That is the whole contract: the methods on a returned result (`isOk()`, `isErr()`, `map`, `andThen`, `match`, and awaiting a `ResultAsync`) are stable, but neverthrow's helper functions such as `ok`, `err`, and `ResultAsync.fromPromise` are not re-exported and are not part of this package's API. Install `neverthrow` yourself if you want to construct results.

## Configure reads explicitly

Public fallback RPCs are disabled by default. Supply a viem transport for every chain your process uses:

```ts
import { OseroClient } from '@osero/client';
import { http } from 'viem';

const client = OseroClient.create({
  transports: {
    8453: http(process.env.BASE_RPC_URL),
    1: http(process.env.ETHEREUM_RPC_URL),
  },
});
```

`client.getPublicClient(chainId)` returns a typed `Result`. Set `allowPublicRpc: true` only when rate-limited public endpoints are an intentional policy.

Safe defaults:

- slippage: 5 basis points, represented by branded `Slippage`
- referral attribution: disabled
- approval policy: exact amount
- public RPC fallback: disabled
- executor confirmations: one, configured per executor call

## Quote before wallet connection

`quoteSwap` needs a read transport, not an account. It returns economics, route and slippage-protection details, protocol fee inputs, and the quote block without constructing calldata, reading allowances, or returning an execution plan.

```ts
import { OseroClient, tokenAmount } from '@osero/client';
import { quoteSwap } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

const client = OseroClient.create({
  transports: { 8453: http(process.env.BASE_RPC_URL) },
});
const amountIn = tokenAmount('USDC', parseUnits('100', 6));
if (amountIn.isErr()) throw amountIn.error;

const quoted = await quoteSwap(client, {
  chainId: 8453,
  mode: 'exact-in',
  amountIn: amountIn.value,
  assetOut: 'sUSDS',
});

if (quoted.isOk()) {
  console.log(quoted.value.expectedAmountOut);
  console.log(quoted.value.minimumAmountOut);
}
```

Call `prepareSwap` after an account is available. Preparation deliberately reads a fresh quote so its allowance decisions, calldata, bounds, and plan share one current block snapshot; it does not upgrade a potentially stale account-free quote.

## Prepare an exact-input swap

Amounts carry their token symbol. Slippage and referrals are also constructed values, which prevents ambiguous raw numbers from crossing public boundaries.

```ts
import { OseroClient, parseSlippage, tokenAmount } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

const client = OseroClient.create({
  transports: { 8453: http(process.env.BASE_RPC_URL) },
});
const amountIn = tokenAmount('USDC', parseUnits('100', 6));
const slippage = parseSlippage({ bps: '25' }); // 25 bps = 0.25%

if (amountIn.isErr() || slippage.isErr()) {
  throw new Error('static application input is invalid');
}

const prepared = await prepareSwap(client, {
  chainId: 8453,
  account: '0x1111111111111111111111111111111111111111',
  mode: 'exact-in',
  amountIn: amountIn.value,
  assetOut: 'sUSDS',
  slippage: slippage.value,
  approvalPolicy: 'exact',
});

if (prepared.isErr()) {
  console.error(prepared.error.code, prepared.error.toJSON());
} else {
  console.log(prepared.value.expectedAmountOut);
  console.log(prepared.value.minimumAmountOut);
  console.log(prepared.value.quotedAt.blockNumber);
  console.log(prepared.value.route);
  console.log(prepared.value.plan.steps);
}
```

The returned quote ties together:

- input and output token amounts
- expected output and enforced minimum output
- slippage representation and enforcement mechanism
- protocol fee inputs
- route and source chain
- quote block
- allowance snapshot and approval decision
- the exact execution plan
- advisory gas estimates with provenance when available

Preparation performs one coherent read pass. It does not preview and then silently re-quote while constructing the plan.

## Prepare an exact-output swap

```ts
import { tokenAmount } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { parseUnits } from 'viem';

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
  console.log(prepared.value.maximumAmountIn); // rounded upward for safety
}
```

The chain capability matrix determines which pair/mode combinations are deployed. Unsupported combinations return `ValidationError`; the SDK does not guess protocol liquidity from a generic ABI. List what a chain supports with [`listSwapRoutes`](#supported-chains).

### Optional local gas estimates

By default a local plan carries no gas estimate and `prepareSwap` makes no estimation call. Pass `gasEstimates: 'independent-steps'` to attach an advisory estimate, taken at the quote block, to the steps that can be estimated on current chain state:

```ts
const prepared = await prepareSwap(client, {
  chainId: 8453,
  account,
  mode: 'exact-in',
  amountIn: amountIn.value,
  assetOut: 'sUSDS',
  gasEstimates: 'independent-steps',
});

if (prepared.isOk()) {
  console.log(prepared.value.plan.steps[0]?.estimatedGas); // { gas, source: 'local-simulation', observedAtBlock }
}
```

Only the first step is estimated. Every later step of a sequential plan depends on an earlier one: a swap that follows an approval cannot be estimated until the approval has executed. A failed estimate omits the field and never fails `prepareSwap`. Estimates are advisory metadata: they are not part of the plan ID, and no adapter uses them as a gas limit.

## Approval policy

`prepareSwap` accepts an `approvalPolicy`:

- `exact` (default): add an approval only when current allowance is insufficient; approve the required amount
- `max`: explicit opt-in to `uint256.max` approval
- `none`: never add an approval; insufficient allowance returns `InsufficientAllowanceError`

Allowance observations, block number, required amount, policy, and selected approval amount are recorded in plan metadata. They are evidence from preparation time, not a guarantee that execution cannot race or revert.

Hosted quotes take no approval policy. An Approval Step is authored by the API as an exact approval of the returned spender for the returned amount. The SDK verifies that its calldata is exactly `approve(spender, requiredAmount)` and includes it in the Wallet Execution Plan only when the current allowance is insufficient.

## Execute with viem

```ts
import { sendWith } from '@osero/client/viem';

if (prepared.isErr()) throw prepared.error;

const result = await sendWith(walletClient, prepared.value.plan, {
  confirmations: 2,
  confirmationTimeoutMs: 120_000,
  onProgress(progress) {
    console.log(progress.type);
  },
});

if (result.isErr()) {
  console.error(result.error.code, result.error.execution);
} else {
  for (const transaction of result.value.transactions) {
    console.log(transaction.operation, transaction.submittedHash, transaction.hash);
  }
}
```

The curried form is equivalent:

```ts
const execute = sendWith(walletClient, { confirmations: 2 });
const result = await execute(prepared.value.plan);
```

Before transaction 1, every adapter validates the complete plan, connected account, current chain, deterministic options, executor capabilities, and any supplied resume proof. A malformed later step causes zero broadcasts.

The viem and ethers executors perform a fresh gas estimate and apply a bounded buffer. Hosted/local `estimatedGas` remains advisory and never becomes an automatic hard gas limit.

Gas buffers, confirmation and timeout defaults, replacement handling, and the error each stage returns differ slightly between adapters. They are specified in the [adapter behaviour contract](../../docs/osero-sdk/adapters.md). Two defaults to know: the ethers adapter waits for a receipt without a timeout unless you pass `confirmationTimeoutMs`, and a transaction that was cancelled or replaced by a different transaction fails the step in every adapter.

## Execute with ethers

```ts
import { sendWith } from '@osero/client/ethers';

const result = await sendWith(signer, prepared.value.plan, {
  confirmations: 2,
  confirmationTimeoutMs: 120_000,
});
```

The signer must already be attached to the plan chain. The adapter does not switch networks. Repriced replacement transactions preserve both the submitted hash and effective replacement hash in `ConfirmedTransaction`; a cancelled or otherwise replaced transaction returns `ConfirmationError` at stage `replacement`.

## Execute with Privy

```ts
import { sendWith } from '@osero/client/privy';
import { http } from 'viem';

const idempotencyKeys = Object.fromEntries(
  prepared.value.plan.steps.map((step) => [step.id, `${prepared.value.plan.id}:${step.id}`]),
);

const result = await sendWith(privy, wallet, prepared.value.plan, {
  chainId: 8453,
  transport: http(process.env.BASE_RPC_URL),
  idempotencyKeys,
  confirmations: 2,
});
```

Privy options explicitly bind the invocation to one chain. Idempotency keys are keyed by stable plan step ID, validated before any Wallet API call, and should be persisted across retries. Sponsored/user-operation responses without a standard transaction hash return `UnsupportedCapabilityError`; the adapter never fabricates a hash.

## Recovery and progress

A confirmation failure includes:

- the failed plan and step identity
- execution stage
- submitted transaction hash when one exists
- the ordered confirmed prefix

Every bundled adapter attaches the confirmed prefix, with its receipts, to the error it returns. Turn a failure into resume state, persist it, and resume later:

```ts
import {
  deserializeExecutionPlan,
  deserializeExecutionResumeState,
  executionResumeStateFromError,
  serializeExecutionPlan,
  serializeExecutionResumeState,
} from '@osero/client';

const result = await sendWith(walletClient, plan);
if (result.isErr()) {
  const resume = executionResumeStateFromError(plan, result.error);
  if (resume.isOk()) {
    const savedPlan = serializeExecutionPlan(plan);
    const savedResume = serializeExecutionResumeState(resume.value);
    // Store both strings. They are bigint-safe canonical JSON.
  } else {
    // Nothing is safe to resume automatically yet. For an unresolved step,
    // resume.error.details names the stage and the hash or batch id to check.
  }
}

// Later, possibly in another process:
const restoredPlan = deserializeExecutionPlan(savedPlanJson);
const restoredResume = deserializeExecutionResumeState(savedResumeJson);
if (restoredPlan.isOk() && restoredResume.isOk()) {
  await sendWith(walletClient, restoredPlan.value, { resume: restoredResume.value });
}
```

Resuming sends every step after the confirmed prefix, starting with the step that failed. `executionResumeStateFromError` therefore refuses to return state that could send a step twice:

- **The failed step provably did not take effect**: it was never sent (preflight, a failed gas estimate, an explicit wallet rejection), or it was mined and reverted. Resume state is returned.
- **The failed step may already have been submitted**: a receipt wait timed out, a broadcast failed ambiguously, the transaction was replaced, a resume proof could not be verified, an EIP-5792 batch status never arrived, or a Privy request was aborted. With the ethers adapter this also covers a reverted transaction, which ethers reports as a confirmation failure. A `ValidationError` is returned, and its `details` carry the `stage` and any `hash` or `batchId`. Check that transaction or batch first. If it did not execute, pass `{ unresolvedStep: 'assume-not-executed' }` to get the confirmed prefix. If it did execute, do not resume from the prefix: that would execute the step again.
- **The error cannot be trusted as evidence**: it carries no execution context, belongs to another plan, or lists a completed step without its confirmation, as an error from a custom executor might. A `ValidationError` is returned.

`deserializeExecutionResumeState` validates the shape of the state; whether it matches a plan is checked when it is used. Adapters re-fetch receipts for a supplied confirmed prefix before skipping it. Resume state must match the plan ID, step order, operation, and hashes exactly. `resumeExecutionPlan(plan, state)` performs the same match without a wallet and returns the pending steps.

A quote that expires partway through a plan returns `QuoteExpiredError` whose `execution.completed` lists the steps already confirmed. `JSON.stringify(error.execution)` is safe for logging: bigint receipt fields are written as decimal strings.

## Honest simulation

```ts
import { simulateExecutionPlan } from '@osero/client/actions';

const simulation = await simulateExecutionPlan(client, prepared.value.plan, account);
```

Simulation reports the pinned block, native balance, relevant token balances/allowances, fee data, per-step estimate, and RPC provenance. Multi-step plans are labeled `independent-steps`: later estimates do not pretend earlier state transitions have occurred.

- `feeData.basis` says what `feeData.gasPrice` is. With `'max-fee-per-gas'` it is the EIP-1559 fee cap (also exposed as `feeData.maxFeePerGas`), so each `estimatedNativeFee` is an upper bound rather than the expected cost. With `'gas-price'` it is the legacy gas price.
- A failed step carries `result.revert` when the node returned a revert reason or raw revert data. Both fields are best effort: custom error data stays raw in `revert.data` without a decoded `reason`.
- Pass the prepared quote to see its bounds next to the simulation: `simulateExecutionPlan(client, prepared.value.plan, account, { quote: prepared.value })` adds a `quote` field with the expected amount and the minimum output or maximum input. The quote must belong to the plan being simulated. These are the quote's values; independent step simulation does not measure the swap output.

## Hosted API

The hosted client requests a provider-neutral quote. The API selects the Quote Provider; callers do not request Enso, LI.FI, 0x, or another provider directly. `quote.provider` identifies that selection, while Provider Details retain provider-specific attribution and diagnostics. Narrow known Provider Details with `isOseroApiEnsoProviderDetails`, `isOseroApiLifiProviderDetails`, or `isOseroApiZeroXProviderDetails`; preserve unknown providers and their opaque details.

0x is one Quote Provider spanning two upstream APIs — same-chain pairs are filled through the 0x Swap API, cross-chain pairs through the 0x Cross-Chain API — so it reports a single `'0x'` tag either way. `isOseroApiZeroXProviderDetails` narrows to the 0x support id (`zid`), the curated route, gas and network-fee estimates, and `fees`. Those fees are reporting only: `quote.expectedOutput` is already net of the Osero Integrator Fee, the 0x fee, and any bridge-native fee, so never subtract them again when displaying a quote. A `bridgeNativeFee` is paid through the execution transaction's native `value` rather than deducted from the source token. An allowance requirement arrives as an ordinary Approval Step — always spend against the returned `spender`, never a hardcoded AllowanceHolder address.

The client requires an API key and a public-client provider when an Approval Step may need an allowance read.

```ts
import { parseSlippage } from '@osero/client';
import { oseroApiAmount, OseroApiClient } from '@osero/client/api';
import { createPublicClient, http, parseUnits } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});
const api = OseroApiClient.create({
  apiKey: process.env.OSERO_API_KEY,
  publicClientProvider: (chainId) => {
    if (chainId !== 8453) throw new Error(`No client for ${chainId}`);
    return publicClient;
  },
});
const amount = oseroApiAmount(parseUnits('1', 6));
const slippage = parseSlippage({ bps: '50' });
if (amount.isErr() || slippage.isErr()) throw new Error('invalid input');

const quote = await api.getSwapQuote({
  fromAddress: account,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: amount.value,
  slippage: slippage.value,
});
```

Hosted decoding accepts future asset, protocol, and Quote Provider vocabulary, but executable fields are strict. A normalized Transfer Status state this release does not know is decoded as `unknown`, and `waitForSwapCompletion` keeps polling on it. The client verifies sender and amount against the request, validates chain relationships, decodes ERC-20 approval calldata, and checks token/spender/amount semantics before making allowance reads or exposing a Wallet Execution Plan.

Every normalized quote includes an API Execution Plan for inspection and diagnostics. Do not pass `workflow.quote.executionPlan` to a wallet adapter: its later actions become stale after any Approval Step. The discriminated Hosted Swap Workflow exposes only the currently safe Wallet Execution Plan:

```ts
const workflow = await api.getSwapQuote(request);
if (workflow.isErr()) throw workflow.error;

if (workflow.value.state === 'approval-required') {
  const approval = await sendWith(walletClient)(workflow.value.walletExecutionPlan);
  if (approval.isErr()) throw approval.error;

  // Confirmation invalidates every remaining action in the API Execution Plan.
  const refreshed = await api.refreshSwapQuote(workflow.value.quote.refreshContext);
  if (refreshed.isErr()) throw refreshed.error;
  // Inspect refreshed.value.state and repeat, or persist/pause here.
} else {
  const executed = await sendWith(walletClient)(workflow.value.walletExecutionPlan);
  if (executed.isErr()) throw executed.error;
}
```

This manual path is appropriate for frontends that need explicit prompts, persistence, pausing, or resume control. Quote Refresh is provider-locked: it returns a replacement from the selected Quote Provider rather than selecting a provider again. A Wallet Execution Plan is bound to `quote.expiresAt`; adapters reject it at or after expiry. Refresh an expired quote before submission.

Use `executeSwap(request, handler)` for bounded high-level execution. It submits at most one approval-only Wallet Execution Plan at a time, performs Quote Refresh after confirmation or expiry, and then submits the fresh execution-only plan. The defaults allow three approval transactions and five total Quote Refreshes; `approvalTransactionLimit` and `quoteRefreshLimit` accept deliberate positive-integer overrides.

Every allowance check reads at the chain head, which the SDK requests from your public client with `cacheTime: 0`, so a response that viem has cached cannot hide an approval that has just confirmed. Inside `executeSwap`, the check that follows a confirmed approval also never reads below that approval's receipt block. If the RPC still reports an older head, the SDK asks again for up to about one second and then reads at the receipt block. An RPC that cannot serve that block returns `RpcError`; the approval is not requested a second time.

```ts
const execution = await api.executeSwap(request, sendWith(walletClient), {
  signal: abortController.signal,
  onProgress: (event) => console.log(event.type),
});
if (execution.isErr()) throw execution.error;

console.log(execution.value.approvalResults);
console.log(execution.value.executionResult.txHash);
```

High-level execution ends when the source-chain execution is confirmed. For a cross-chain quote, destination delivery is a separate Transfer Status lifecycle. Start it with the final quote, not an earlier invalidated quote:

```ts
const completion = await api.waitForSwapCompletion(
  execution.value.finalQuote,
  execution.value.executionResult.txHash,
  {
    signal: abortController.signal,
    pollingIntervalMs: 5_000,
    timeoutMs: 30 * 60_000,
    onStatus: (status) => console.log(status.state, status.providerDetails),
  },
);
```

The helper sends the source transaction hash with the quote's complete Status Context: Quote Provider, source chain, destination chain, bridge, and — for 0x only — the Provider Quote ID. It polls normalized `pending` and `unknown` states and stops on `completed` or `failed`. A terminal `failed` state is a successful Transfer Status observation whose payload preserves the nullable error and Provider Details. Caller cancellation, HTTP failure, malformed response, callback failure, and timeout remain distinct typed errors. Same-chain quotes have no Status Context and reject Transfer Status polling before an HTTP request.

To keep waiting after a restart, persist `{ sourceTransactionHash, statusContext }` when the source transaction is submitted and pass it to `waitForTransferStatus`, which takes the same options and behaves the same way without needing the quote:

```ts
const statusRequest = {
  sourceTransactionHash: execution.value.executionResult.txHash,
  statusContext: finalQuote.statusContext, // non-null for a cross-chain quote
};
// Persist statusRequest as JSON. After a restart:
const completion = await api.waitForTransferStatus(statusRequest, { timeoutMs: 30 * 60_000 });
```

Status Context is a provider-discriminated union. Persist it whole alongside the quote and submit it unchanged: a 0x context additionally carries `providerQuoteId` (0x's `quoteId`), which the client serializes into every status poll and refuses to poll without, because bundled transactions cannot be disambiguated otherwise. `isOseroApiZeroXStatusContext` narrows to it.

### Recovery

A failed cross-chain transfer is not automatically terminal. Inspect `status.recoveryContext` — nullable on every Transfer Status — instead of treating `failed` as the end of the story:

| `recoveryContext.state` | What to show                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `pending`               | Automatic recovery in progress; keep polling with backoff.         |
| `completed`             | Recovered funds, using `chainId`, `tokenAddress`, `settledAmount`. |
| `action-required`       | The `deadline` and the Recovery Action, prominently.               |
| `not-required`          | Funds did not leave, or are already available.                     |
| `unavailable`           | Stop automated recovery; direct the user to support.               |

Pass `waitForRecovery: true` to `waitForSwapCompletion` to keep polling a failed transfer while its recovery is still `pending`, so the returned status reflects the settled outcome. `reason` normalizes to `expired`, `cancelled`, `out-of-gas`, `provider-failure`, or `unknown`; provider-native strings stay in Provider Details for diagnostics only.

A Recovery Action is deliberately sender-free — any caller may submit it — so name the submitting wallet yourself rather than assuming the original one:

```ts
import { isOseroApiActionableRecovery, prepareRecoveryExecutionPlan } from '@osero/client/api';

if (isOseroApiActionableRecovery(completion.value.recoveryContext)) {
  const plan = prepareRecoveryExecutionPlan(completion.value, submitter);
  if (plan.isErr()) throw plan.error;
  const recovered = await sendWith(walletClient)(plan.value);
  if (recovered.isErr()) throw recovered.error;

  // Submission does not settle recovery; keep polling the original transfer.
  const settled = await api.waitForSwapCompletion(finalQuote, sourceTxHash, {
    waitForRecovery: true,
  });
}
```

Only a `failed` transfer whose recovery is `action-required` authorizes a submission. Every other state is the API saying no wallet action is wanted, so `prepareRecoveryExecutionPlan` rejects a stale or malformed response that still carries calldata rather than turning it into a signable plan. `isOseroApiActionableRecovery` narrows to the one combination that is submittable, which is also what makes an unsubmittable one unrepresentable on the executable path.

The recipient, calldata, value, and gas limit are carried through unchanged; nonce and fee pricing stay the wallet's job. A non-null `deadline` becomes the plan's quote expiry, so adapters reject a recovery whose window has already closed. Osero never signs or submits a Recovery Action. Recovery status is tracked against the original source transaction, so keep polling that transfer after submitting.

The v1 hosted response is an intentional breaking replacement. The client does not decode or promise compatibility with the removed legacy Enso-shaped quote or bridge-status response.

## Balances and APY

```ts
import { getSUsdsApy, getTokenBalance, getTokenBalances } from '@osero/client';

const balances = await getTokenBalances(client, {
  chainId: 8453,
  account,
  multicall: 'prefer', // 'require' | 'never'
});
const usdc = await getTokenBalance(client, {
  chainId: 8453,
  account,
  token: 'USDC', // or any validated ERC-20 address
});
const apy = await getSUsdsApy(client, { chainId: 8453 });
```

`multicall: 'prefer'` falls back to isolated reads only when the aggregate call itself cannot execute. `getTokenBalances` is all-or-nothing: if any one of the three token reads fails, the whole call returns that `RpcError` and no partial balances. Per-contract failures retain token and operation context. `ssrToApy` uses stable log-domain compounding and returns a validation `Result` for invalid or numerically unrepresentable rates.

## Errors

All public errors extend `OseroError` and expose stable literal `name` and `code` discriminants plus JSON-safe `toJSON()` output.

```ts
if (result.isErr()) {
  switch (result.error.code) {
    case 'ACCOUNT_MISMATCH':
    case 'CHAIN_MISMATCH':
      // Fix wallet/plan binding. No transaction was broadcast.
      break;
    case 'SIMULATION_FAILED':
      // Fresh gas estimation failed.
      break;
    case 'CONFIRMATION_FAILED':
      // Persist result.error.execution before retrying.
      break;
    case 'TRANSACTION_REVERTED':
      // The receipt is final and reverted.
      break;
    default:
      console.error(result.error.toJSON());
  }
}
```

## Supported chains

| Chain        |    ID | Protocol                |
| ------------ | ----: | ----------------------- |
| Ethereum     |     1 | Sky Lite PSM + ERC-4626 |
| OP Mainnet   |    10 | Spark PSM3              |
| Unichain     |   130 | Spark PSM3              |
| Base         |  8453 | Spark PSM3              |
| Arbitrum One | 42161 | Spark PSM3              |

Use `listChains()`, `getChain()`, `listTokens()`, and `getToken()` rather than copying addresses. Raw ABIs and intentionally supported addresses are available through `@osero/client/contracts`.

`listSwapRoutes(chainId)` lists the local routes on a chain. It is a synchronous lookup derived from the same capability matrix `quoteSwap` and `prepareSwap` use, so a listed pair and mode is one they accept:

```ts
import { listSwapRoutes } from '@osero/client';

for (const route of listSwapRoutes(1)) {
  for (const mode of route.modes) {
    console.log(
      route.assetIn,
      route.assetOut,
      mode.mode, // 'exact-in' | 'exact-out'
      mode.slippageProtection.enforcedBy, // 'calldata' | 'allowance' | 'none'
      mode.referral, // 'none' | 'uint16' | 'uint256'
    );
  }
}
```

A mode whose `slippageProtection.enforcedBy` is `'none'` cannot enforce its quoted bound on chain, and `prepareSwap` requires `allowUnprotectedSlippage: true` for it. A mode enforced by `'allowance'` is capped by an allowance of exactly the maximum input: with `approvalPolicy: 'exact'` the plan sets the allowance to that amount even when a larger one exists, `'none'` fails unless the allowance already equals it, and `'max'` is rejected. A mode whose `referral` is `'none'` rejects a referral code. The listing describes what is deployed, not current liquidity, and returns an empty list for a chain without local routes. Hosted API pairs are listed by `OseroApiClient.getSupportedAssets()` instead.

## Telemetry

The SDK reports a small, fixed set of its own failures to Osero's Sentry project: SDK bugs (`UnexpectedError`), hosted API contract drift (`ApiResponseError`), server-side API failures, and failed on-chain executions. Caller mistakes, user cancellations, wallet signing failures, network and RPC outages, quote expiry, and API key or rate-limit responses are never reported. Events never contain API keys, headers, wallet addresses, amounts, or user identity.

Telemetry is on by default. Turn it off before using the SDK:

```ts
import { configureTelemetry } from '@osero/client';

configureTelemetry({ enabled: false });
```

In Node.js, `OSERO_TELEMETRY=0` or `DO_NOT_TRACK=1` has the same effect, and telemetry is off automatically while `NODE_ENV=test`. The SDK never calls `Sentry.init` and never touches a host application's own Sentry setup; `@sentry/core` is loaded only when the first event qualifies. Hosted API requests to `*.osero.org` carry a `sentry-trace` header so API-side events can be correlated. See [docs/osero-sdk/telemetry.md](../../docs/osero-sdk/telemetry.md) for the full policy.

## Security notes

- Inspect every plan before signing.
- Keep RPC URLs explicit in production.
- `max` approvals are persistent authority; use them only after explicit user consent.
- Quotes and allowance observations can become stale.
- Independent simulation is not a guarantee of sequential multi-step success.
- Examples can broadcast real transactions. Use disposable wallets and small balances.
- Never commit API keys, private keys, Privy secrets, or authorization keys.

## License

MIT

## Building & testing

From the repository root:

```bash
pnpm turbo run build --filter=@osero/client
pnpm turbo run typecheck --filter=@osero/client
pnpm turbo run test --filter=@osero/client
pnpm --filter @osero/client test:coverage
pnpm release:verify
```
