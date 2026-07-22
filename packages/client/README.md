# @osero/client

Production TypeScript SDK for preparing, inspecting, simulating, and executing USDC, USDS, and sUSDS swaps through the deployed Sky/Spark liquidity routes supported by Osero.

The v1 API separates four responsibilities:

1. `OseroClient` owns explicit read transports and safe policy defaults.
2. `prepareSwap` reads a quote once and returns a rich quote bound to an immutable execution plan.
3. An executor adapter (`/viem`, `/ethers`, or `/privy`) preflights and executes that plan.
4. The hosted API client (`/api`) decodes untrusted responses, verifies transaction integrity, and prepares allowance-aware plans.

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

- Node.js 20 or newer
- ESM
- viem `>=2.21.22 <3`
- ethers v6 for `@osero/client/ethers`
- `@privy-io/node` v0.19 for `@osero/client/privy`

## Public entrypoints

| Import path               | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `@osero/client`           | Client, domain values, plans, errors, chain/token discovery, balances, APY |
| `@osero/client/actions`   | `prepareSwap` and `simulateExecutionPlan`                                  |
| `@osero/client/api`       | Hosted API client and hosted wire/domain types                             |
| `@osero/client/contracts` | Supported contract ABIs and protocol addresses                             |
| `@osero/client/viem`      | viem executor                                                              |
| `@osero/client/ethers`    | ethers v6 executor                                                         |
| `@osero/client/privy`     | Privy server-wallet executor                                               |

Unexported files under `src/lib` and `dist/lib` are implementation details. Package export-map enforcement prevents importing them as public subpaths.

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
const slippage = parseSlippage('25'); // 25 bps = 0.25%

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

The chain capability matrix determines which pair/mode combinations are deployed. Unsupported combinations return `ValidationError`; the SDK does not guess protocol liquidity from a generic ABI.

## Approval policy

`prepareSwap` and hosted quote preparation accept:

- `exact` (default): add an approval only when current allowance is insufficient; approve the required amount
- `max`: explicit opt-in to `uint256.max` approval
- `none`: never add an approval; insufficient allowance returns `InsufficientAllowanceError`

Allowance observations, block number, required amount, policy, and selected approval amount are recorded in plan metadata. They are evidence from preparation time, not a guarantee that execution cannot race or revert.

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

## Execute with ethers

```ts
import { sendWith } from '@osero/client/ethers';

const result = await sendWith(signer, prepared.value.plan, {
  confirmations: 2,
  confirmationTimeoutMs: 120_000,
});
```

The signer must already be attached to the plan chain. The adapter does not switch networks. Repriced replacement transactions preserve both the submitted hash and effective replacement hash in `ConfirmedTransaction`.

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

Persist plans and resume state with canonical serializers:

```ts
import {
  deserializeExecutionPlan,
  resumeExecutionPlan,
  serializeExecutionPlan,
} from '@osero/client';

const serialized = serializeExecutionPlan(prepared.value.plan);
if (serialized.isErr()) throw serialized.error;

const restored = deserializeExecutionPlan(serialized.value);
if (restored.isErr()) throw restored.error;

const resumed = resumeExecutionPlan(restored.value, savedResumeState);
if (resumed.isErr()) throw resumed.error;
```

Adapters re-fetch receipts for a supplied confirmed prefix before skipping it. Resume state must match the plan ID, step order, operation, and hashes exactly.

## Honest simulation

```ts
import { simulateExecutionPlan } from '@osero/client/actions';

const simulation = await simulateExecutionPlan(client, prepared.value.plan, account);
```

Simulation reports the pinned block, native balance, relevant token balances/allowances, fee data, per-step estimate, and RPC provenance. Multi-step plans are labeled `independent-steps`: later estimates do not pretend earlier state transitions have occurred.

## Hosted API

The hosted client requests a provider-neutral quote. The API selects the Quote Provider; callers do not request Enso, LI.FI, or another provider directly. `quote.provider` identifies that selection, while Provider Details retain provider-specific attribution and diagnostics. Narrow known Provider Details with `isOseroApiEnsoProviderDetails` or `isOseroApiLifiProviderDetails`; preserve unknown providers and their opaque details.

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
const slippage = parseSlippage('50');
if (amount.isErr() || slippage.isErr()) throw new Error('invalid input');

const quote = await api.getSwapQuote({
  fromAddress: account,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: amount.value,
  slippage: slippage.value,
});
```

Hosted decoding accepts future asset, protocol, and Quote Provider vocabulary, but executable fields and normalized Transfer Status states are strict. The client verifies sender and amount against the request, validates chain relationships, decodes ERC-20 approval calldata, and checks token/spender/amount semantics before making allowance reads or exposing a Wallet Execution Plan.

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

The helper sends the source transaction hash with the quote's complete Status Context: Quote Provider, source chain, destination chain, and bridge. It polls normalized `pending` and `unknown` states and stops on `completed` or `failed`. A terminal `failed` state is a successful Transfer Status observation whose payload preserves the nullable error and Provider Details. Caller cancellation, HTTP failure, malformed response, callback failure, and timeout remain distinct typed errors. Same-chain quotes have no Status Context and reject Transfer Status polling before an HTTP request.

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

`multicall: 'prefer'` falls back to isolated reads only when the aggregate call itself cannot execute. Per-contract failures retain token and operation context. `ssrToApy` uses stable log-domain compounding and returns a validation `Result` for invalid or numerically unrepresentable rates.

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

Use `listChains()` and `CHAIN_CAPABILITIES`-backed discovery APIs rather than copying addresses. Raw ABIs and intentionally supported addresses are available through `@osero/client/contracts`.

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
