# Upgrade from 0.x to 1.0

`@osero/client` 1.0 is a deliberate breaking release. It replaces pair-specific local action builders, ambiguous primitive inputs, nested plans, broad errors, and permissive execution defaults with one preparation model that is safe to persist and execute in production.

The hosted API also moves from an sUSDS-shaped allowlist to API-authoritative asset refs. Read this guide even if you only use local actions or wallet adapters.

## Migration sequence

1. Configure explicit RPC transports.
2. Replace primitive amounts/slippage/referrals with domain constructors.
3. Replace preview + action calls with one `prepareSwap` call.
4. Update plan inspection from nested variants to `plan.steps`.
5. Update adapters to pass explicit options and consume rich transaction results.
6. Switch error handling to stable `error.code` discriminants.
7. If applicable, update hosted API configuration and asset refs.

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

| 0.x                                           | 1.0                                          |
| --------------------------------------------- | -------------------------------------------- |
| `defaultSlippageBps: 25`                      | `defaultSlippage: parseSlippage('25').value` |
| `defaultReferralCode: 3001n`                  | `referral: referral(3001).value`             |
| omitted referral meant fee attribution        | omitted `referral` means no attribution      |
| implicit public RPC                           | `allowPublicRpc: true` opt-in                |
| executor confirmation hidden in client config | executor `confirmations` option              |

Constructors reject malformed runtime data before it reaches ABI encoding:

```ts
import { parseSlippage, referral, tokenAmount } from '@osero/client';
import { parseUnits } from 'viem';

const amount = tokenAmount('USDC', parseUnits('10', 6));
const slippage = parseSlippage('25'); // decimal basis-point string
const attribution = referral(3001); // uint16 API-compatible referral

if (amount.isErr() || slippage.isErr() || attribution.isErr()) {
  // Handle ValidationError
}
```

Do not cast arbitrary values to branded domain types. Constructors are the runtime boundary.

## Local actions become `prepareSwap`

0.x exposed separate preview/action functions such as `previewMintUsds`, `mintUsds`, `previewMintSUsds`, `mintSUsds`, `previewRedeemUsds`, `redeemUsds`, `previewRedeemSUsds`, and `redeemSUsds`.

1.0 removes them. Use `prepareSwap` for every supported pair and mode:

```ts
import { OseroClient, tokenAmount } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { parseUnits } from 'viem';

const amountIn = tokenAmount('USDC', parseUnits('10', 6));
if (amountIn.isErr()) throw amountIn.error;

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

Preparation performs one coherent read pass and returns the quote and its exact execution plan together. Do not recreate the 0.x preview-then-build pattern: that can quote twice against different state.

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
  chainId: prepared.value.plan.chainId,
  transport,
  confirmations: 2,
  idempotencyKeys: Object.fromEntries(
    prepared.value.plan.steps.map((step) => [step.id, `${prepared.value.plan.id}:${step.id}`]),
  ),
});
```

The adapter requires an explicit chain binding and a receipt source (transport or receipt client unless public RPC opt-in is intentional). Idempotency keys are validated for every step before execution. Privy responses without a standard EVM transaction hash return `UnsupportedCapabilityError`.

### Gas and result changes

Every adapter freshly estimates gas and applies a bounded buffer. A hosted/local gas estimate is advisory provenance, not an automatic hard limit.

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

### Configuration requires an allowance read provider

Executable hosted quotes can contain an approval. 1.0 verifies that approval and then decides whether it is needed from live allowance:

```ts
import { OseroApiClient } from '@osero/client/api';

const api = OseroApiClient.create({
  apiKey: process.env.OSERO_API_KEY,
  publicClientProvider: (chainId) => publicClients[chainId],
});
```

`publicClientProvider` must supply a client for the source chain before requesting an executable quote. API key precedence is per-request override, provider, then static key.

### Hosted amounts and policies are constructed values

```ts
import { parseSlippage } from '@osero/client';
import { oseroApiAmount } from '@osero/client/api';
import { parseUnits } from 'viem';

const amount = oseroApiAmount(parseUnits('1', 6));
const slippage = parseSlippage('50');
if (amount.isErr() || slippage.isErr()) throw new Error('invalid quote input');

const quote = await api.getSwapQuote({
  fromAddress: account,
  fromAssetId: 'base:usdc',
  toAssetId: 'ethereum:susds',
  amount: amount.value,
  slippage: slippage.value,
  approvalPolicy: 'exact',
});
```

The client verifies response sender, raw amount, source chain, transaction chain, native value, approval target, and decoded `approve(spender, amount)` semantics before returning an execution plan.

### Asset refs are API-authoritative

`getSwapQuote` accepts a canonical ID, an arbitrary well-formed ID, or a `{ chainId, address }` locator. The hosted API—not a shipped SDK allowlist—decides support.

`OSERO_API_KNOWN_*` exports are advisory autocomplete/offline snapshots. Use `getSupportedAssets()` for the live sanctioned list and `matchOseroApiAsset(assets, ref)` for optional UI preflight.

| Removed 0.x API                                                         | 1.0 replacement                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| `OSERO_API_COUNTER_ASSETS`, `OSERO_API_SWAP_ASSETS`, `OSERO_API_ASSETS` | `OSERO_API_KNOWN_ASSETS` advisory snapshot          |
| `OSERO_API_INPUT_*`, `OSERO_API_OUTPUT_*`                               | `OseroApiAssetRef` plus live `getSupportedAssets()` |
| `OSERO_API_SOURCE_CHAIN_IDS`                                            | positive `OseroApiChainId` decoded from the API     |
| `OseroApiToSusdsQuoteRequest`, `OseroApiFromSusdsQuoteRequest`          | `OseroApiSwapQuoteRequest`                          |
| direction-derived hosted mint/redeem operation                          | `SWAP_EXACT_IN`; label from `quote.pair`            |

Responses decode unknown future asset, chain, protocol, direction, kind, and status vocabulary. Fields required for safe execution remain strict.

### Completion polling

`waitForSwapCompletion` now requires a finite timeout policy, supports `AbortSignal`, and awaits async status callbacks. A provider bridge failure is returned as a terminal status payload, while caller cancellation, timeout, transport failure, callback failure, and malformed responses remain distinct errors.

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
- [ ] Hosted API clients provide source-chain public clients.
- [ ] Persisted plans and resume state use canonical serializers.
- [ ] UI copy does not present independent simulation as guaranteed execution.
