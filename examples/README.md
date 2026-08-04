# @osero/client examples

Runnable v1 examples for local swap preparation, hosted quotes, and viem/ethers/Privy execution.

Examples use explicit transports and the plan-first API:

1. construct `TokenAmount`, `Slippage`, and optional `Referral` values;
2. optionally call `quoteSwap` before a wallet is connected;
3. call `prepareSwap` once an account is available;
4. inspect the rich quote and flat `ExecutionPlan.steps`;
5. pass the plan to one executor adapter.

## Setup

```bash
pnpm install
cp examples/.env.example examples/.env
```

Configure the RPC URL for every chain you use. Public fallback endpoints are not an appropriate production policy.

Wallet examples require a disposable private key or Privy server wallet. They can broadcast real transactions and incur gas. Use small balances.

## Read-only examples

```bash
pnpm --filter @osero/examples dry-run:inspect-plan
pnpm --filter @osero/examples dry-run:susds-apy
OSERO_API_KEY=osero_... pnpm --filter @osero/examples api:quote-swap
```

### `dry-run:inspect-plan`

Quotes, prepares, and prints:

- an account-free Base USDC → USDS exact-input quote;
- Base USDC → USDS exact input;
- Base USDS → sUSDS direct vault route;
- Base USDC → USDS exact output with an upward-rounded maximum input;
- mainnet USDC → sUSDS multi-step execution.

It does not create a wallet or broadcast.

### `dry-run:susds-apy`

Reads the configured SSR source on all supported chains and converts the RAY per-second value with stable log-domain compounding.

### `api:quote-swap`

Loads live hosted assets, requests a quote, verifies the hosted transaction/approval response, performs the allowance read through `publicClientProvider`, and prints the current Wallet Execution Plan without sending it. It demonstrates the manual Hosted Swap Workflow boundary: submit only an approval-only Wallet Execution Plan, wait for confirmation, discard the API Execution Plan, and perform Quote Refresh before preparing another wallet action.

## viem

```bash
pnpm --filter @osero/examples viem:mint-usds
pnpm --filter @osero/examples viem:mint-susds-mainnet
pnpm --filter @osero/examples viem:redeem-susds
pnpm --filter @osero/examples viem:roundtrip
```

- `viem:mint-usds`: Base USDC → USDS.
- `viem:mint-susds-mainnet`: mainnet USDC → sUSDS with explicit acknowledgement that the deployed route cannot enforce its quoted minimum in calldata.
- `viem:redeem-susds`: prepare, inspect, and execute Base sUSDS → USDC.
- `viem:roundtrip`: Base USDC → sUSDS → USDC, using the observed share balance for leg two.

## ethers

```bash
pnpm --filter @osero/examples ethers:mint-usds
pnpm --filter @osero/examples ethers:roundtrip
```

The signer must already be attached to the plan chain. The adapter never hot-switches networks.

## Privy

```bash
pnpm --filter @osero/examples privy:mint-usds
```

Required environment:

- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `PRIVY_WALLET_ID`
- `PRIVY_WALLET_ADDRESS`
- optional `PRIVY_AUTHORIZATION_PRIVATE_KEY`

The example passes explicit `chainId` and receipt transport. Idempotency keys are keyed by stable execution step ID and derived from the deterministic plan ID; persist equivalent keys in a real retry workflow.

## Hosted execution

```bash
pnpm --filter @osero/examples api:execute-quote-viem
```

This uses the bounded high-level executor for a Base → Ethereum Hosted Swap Workflow. It submits one approval-only Wallet Execution Plan at a time, performs Quote Refresh, and finishes when the source-chain execution is confirmed. It then starts the separate normalized Transfer Status lifecycle with the source hash and final quote's Status Context. It broadcasts real transactions.

Neither hosted example submits `quote.executionPlan`, the API Execution Plan, to a wallet adapter. The deterministic HTTP contract uses a fake wallet handler to exercise the same high-level workflow without broadcasting.

## Error handling

Every operational call resolves to a typed result:

```ts
const prepared = await prepareSwap(client, request);
if (prepared.isErr()) {
  console.error(prepared.error.code, prepared.error.toJSON());
  return;
}

const executed = await sendWith(wallet, prepared.value.plan);
if (executed.isErr()) {
  console.error(executed.error.code, executed.error.execution);
}
```

`error.code` is a stable literal discriminant. Confirmation failures include submitted hashes and the ordered confirmed prefix so a process can persist recovery state before retrying.
