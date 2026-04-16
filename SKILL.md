---
name: osero-sdk
description: "Reference for the Osero SDK (`@osero/client`), a TypeScript client for USDS/sUSDS mint and redeem transactions across Ethereum mainnet and L2s via viem or ethers v6. This skill should be used whenever code imports `@osero/client`, `@osero/client/actions`, `@osero/client/viem`, or `@osero/client/ethers`, or when the user asks about the SDK's public API, `ExecutionPlan` model, supported chains/tokens/PSM addresses, error taxonomy, or wallet adapters. Triggers: 'mint USDS on Base', 'redeem sUSDS', 'inspect a plan without signing', 'use the SDK with ethers v6'."
---

# Osero SDK (`@osero/client`)

A TypeScript SDK for routing USDC through Sky's USDS / sUSDS peg-stability
infrastructure. One API surface, wallet-agnostic plans, two first-class
adapters (viem and ethers v6), five supported chains. Every action returns
a `ResultAsync` from `neverthrow` — nothing in the action or plan layer
throws.

> **Single-file by design.** This skill is a complete API reference for
> a small, stable SDK; splitting it across `references/*.md` would force
> readers to chase pointers for every adjacent question. Keep it in one
> file unless the surface area roughly doubles.

---

## When to Use

Load this skill when any of the following is true:

- Writing, reviewing, refactoring, or generating TypeScript that imports
  `@osero/client`, `@osero/client/actions`, `@osero/client/viem`, or
  `@osero/client/ethers`.
- Building or inspecting an `ExecutionPlan` — including dry-runs, gas
  estimation, or UI previews — even when no transaction will be broadcast.
- Wiring up a viem `WalletClient` or ethers v6 `Signer` to call
  `sendWith(...)`.
- Answering questions about supported chains, tokens, PSM addresses,
  referral-code semantics, slippage handling, or the `neverthrow` error
  taxonomy used by every action.
- Reading or editing files under `packages/client/src` and needing the
  public-API contract.

## When NOT to Use

Skip this skill (and defer to the listed source instead) when:

- The question is about Sky / Spark contract internals beyond what the
  SDK exposes — read `PSM_GUIDE.md` at the repo root for `tin`, `tout`,
  `sellGem`, `buyGem`, the Lite PSM, or the Spark wrapper.
- The question is about repository tooling (Nx targets, Vitest config,
  oxlint/oxfmt, Changesets release flow) — read `CLAUDE.md` and
  `AGENTS.md` at the repo root.
- The work is unrelated Web3 or generic TypeScript code that does not
  touch `@osero/client`. This skill's triggers and pitfalls assume the
  SDK is in the call graph.
- Modifying SDK internals (action implementations, adapter code, ABI
  bytes). Use the source files under `packages/client/src` directly —
  this skill describes the public surface, not the internals.

---

## Mental model

```
caller                            SDK                                  wallet
------                            ---                                  ------
action(client, request)   ──►  ExecutionPlan (wallet-agnostic)
                                     │
                                     │  .andThen(sendWith(walletOrSigner))
                                     ▼
                                  adapter walks tx list  ──►  sendTransaction(...) per step
                                     │                         wait for each receipt
                                     ▼
                              TransactionResult { txHash, operations[] }
```

1. Actions are **pure plan builders**. They may read on-chain state (fees,
   swap previews) through the `OseroClient`'s viem public clients, but
   they never sign or broadcast.
2. An **`ExecutionPlan`** is a tagged union of pre-encoded transactions.
   The same plan can be executed by any wallet library — viem, ethers,
   a custom batching relayer, or an account-abstraction bundler.
3. **Adapters** (`sendWith`) are the _only_ layer that touches signing.
   They broadcast each transaction in the plan in order and wait for each
   receipt before moving on.
4. Errors are typed classes from `src/lib/errors.ts`, flowing through
   `neverthrow`'s `Result` / `ResultAsync`. Use `.isOk()` / `.isErr()` at
   the top level, never `try/catch` on SDK call sites.

---

## Installation

`viem` is a **required** peer dependency even for ethers users — the SDK
uses it internally to encode calldata and build public clients.
`ethers` is optional; install it only if the caller uses the ethers
adapter.

```bash
pnpm add @osero/client viem
# Optional — only when @osero/client/ethers is in use:
pnpm add ethers
```

Peer-dep ranges (`packages/client/package.json`):

- `viem ^2.21.0` (required)
- `ethers ^6.14.0` (optional)

---

## Package exports

`@osero/client` ships exactly **four subpath exports**. Do not invent
other import paths.

| Subpath                 | What it exports                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@osero/client`         | `OseroClient`, chain/token/address registries, balance helpers, plan helpers, error classes, math helpers, ABIs, all core types, and the `neverthrow` re-exports             |
| `@osero/client/actions` | Action builders (`mintUsds`, `mintSUsds`, `redeemUsds`, `redeemSUsds`), preview helpers (`previewMint*`, `previewRedeem*`), and chain action helpers (`chain`, `listChains`) |
| `@osero/client/viem`    | `sendWith(walletClient[, options])` viem adapter + its option type + `ConnectedWalletClient`                                                                                 |
| `@osero/client/ethers`  | `sendWith(signer[, options])` ethers adapter + its option type                                                                                                               |

### Everything re-exported from `@osero/client`

```
// ABIs
erc20Abi, erc4626Abi, litePsmAbi, psm3Abi, usdsPsmWrapperAbi

// Adapters (plan introspection / type guards)
flattenExecutionPlan
isErc20ApprovalRequired
isMultiStepExecution
isTransactionRequest

// Addresses
PSM_ADDRESSES, PsmAddresses

// Balance helpers
getSUsdsBalance, getTokenBalance, getTokenBalances,
getUsdcBalance, getUsdsBalance,
GetBalancesRequest, GetTokenBalanceError,
GetTokenBalanceRequest, TokenBalances

// Chains
CHAINS, ChainMetadata, getChain, isSupportedChainId, listChains,
OseroChainId, SUPPORTED_CHAIN_IDS

// Client config
ClientConfig, ResolvedClientConfig

// Errors
CancelError, InsufficientBalanceError, OseroError, SigningError,
TransactionError, UnexpectedError, UnsupportedChainError,
ValidationError

// Math helpers
applySlippage, BPS, USDC_TO_USDS_SCALE, WAD,
usdcFromUsdsViaBuyGem, usdsFromUsdcViaSellGem,
usdsNeededForUsdcViaBuyGem

// Client class
OseroClient, OseroPublicClient

// Plan construction helpers
makeApprovalRequiredPlan, makeApprovalTransaction,
makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest

// neverthrow re-exports
err, errAsync, fromAsyncThrowable, fromPromise, fromThrowable,
ok, okAsync, Result, ResultAsync

// Tokens
getToken, listTokens, Token, TokenSymbol

// Core types
ActionError, Erc20Approval, Erc20ApprovalRequired, ExecutionPlan,
ExecutionPlanHandler, ExecutionStep, MultiStepExecution,
OperationType, SendWithError, TransactionRequest, TransactionResult
```

> Note on the `neverthrow` re-exports: always import `Result`, `ResultAsync`,
> `ok`, `err`, `okAsync`, `errAsync`, `fromPromise`, `fromAsyncThrowable`,
> and `fromThrowable` **from `@osero/client`**, not from `neverthrow`
> directly, so the dependency stays swappable across SDK versions.

---

## Supported chains

Five chains, one tuple, one semantic flag:

| Chain ID | Name         | `isMainnet` | Route                                             |
| -------: | ------------ | :---------: | ------------------------------------------------- |
|        1 | Ethereum     |   `true`    | Spark `UsdsPsmWrapper` (+ ERC-4626 sUSDS deposit) |
|       10 | OP Mainnet   |   `false`   | Spark `PSM3`                                      |
|      130 | Unichain     |   `false`   | Spark `PSM3`                                      |
|     8453 | Base         |   `false`   | Spark `PSM3`                                      |
|    42161 | Arbitrum One |   `false`   | Spark `PSM3`                                      |

```ts
import {
  CHAINS,
  SUPPORTED_CHAIN_IDS,
  getChain,
  isSupportedChainId,
  listChains,
  type ChainMetadata,
  type OseroChainId,
} from '@osero/client';

SUPPORTED_CHAIN_IDS; // readonly [1, 10, 130, 8453, 42161]
isSupportedChainId(8453); // type guard → chainId is OseroChainId
getChain(8453); // ChainMetadata | null (null if unsupported)
listChains(); // readonly ChainMetadata[]
CHAINS[1].viemChain; // viem `Chain` object for mainnet
```

`ChainMetadata` shape:

```ts
type ChainMetadata = {
  readonly chainId: OseroChainId;
  readonly name: string; // e.g. "Ethereum"
  readonly shortName: string; // e.g. "eth"
  readonly viemChain: ViemChain; // viem/chains entry
  readonly isMainnet: boolean; // true iff chainId === 1
  readonly explorerUrl: string; // e.g. "https://etherscan.io"
};
```

`isMainnet` is a **semantic** flag, not a geographic one — it is `true`
only for Ethereum L1 (chain ID 1) because that is the branch point where
actions switch from `PSM3` to `UsdsPsmWrapper` + `LitePSM` + ERC-4626.

---

## Tokens

Three canonical symbols per chain — `USDC`, `USDS`, `sUSDS` — exposed
through a typed registry:

```ts
import { getToken, listTokens, type Token, type TokenSymbol } from '@osero/client';

type TokenSymbol = 'USDC' | 'USDS' | 'sUSDS';

type Token = {
  readonly chainId: OseroChainId;
  readonly address: `0x${string}`;
  readonly symbol: TokenSymbol;
  readonly decimals: number; // 6 for USDC, 18 for USDS/sUSDS
  readonly name: string;
};

getToken(8453, 'USDC'); // always populated for supported chains
listTokens(1); // [USDC, USDS, sUSDS] in stable order
```

Token addresses live in `packages/client/src/lib/tokens.ts`. Do not
hard-code them — use `getToken(chainId, symbol)`.

Decimal conventions:

- USDC: **6 decimals** → `parseUnits(amount, 6)`
- USDS: **18 decimals** → `parseUnits(amount, 18)`
- sUSDS: **18 decimals** → `parseUnits(amount, 18)`

---

## PSM addresses

```ts
import { PSM_ADDRESSES, type PsmAddresses } from '@osero/client';

type PsmAddresses = {
  readonly psm: `0x${string}`; // L2: PSM3; mainnet: UsdsPsmWrapper
  readonly litePsm?: `0x${string}`; // mainnet only: underlying Sky Lite PSM
};

PSM_ADDRESSES[1].psm; // Spark UsdsPsmWrapper
PSM_ADDRESSES[1].litePsm; // Sky MCD_LITE_PSM_USDC_A (read-only audit)
PSM_ADDRESSES[8453].psm; // Spark PSM3 on Base
```

The SDK routes funds through `psm` only. `litePsm` is surfaced for
callers who want to verify `tin()` / `tout()` independently.

> **`tin` / `tout` glossary.** `tin` is the Sky Lite PSM's governance-set
> fee (in WAD, fraction of `1e18`) charged on **`sellGem`** — converting
> USDC into USDS. `tout` is the symmetric fee charged on **`buyGem`** —
> converting USDS back into USDC. Both have been `0` since launch; the
> SDK reads them on every call so that a future governance change is
> picked up automatically.

---

## `OseroClient`

The SDK's stateless read-side entry point. It caches one viem
`PublicClient` per chain, created lazily on first access.

```ts
import { OseroClient, type OseroPublicClient } from '@osero/client';
import { http } from 'viem';

const client = OseroClient.create({
  transports: {
    1: http('https://eth.llamarpc.com'),
    10: http('https://mainnet.optimism.io'),
    130: http('https://mainnet.unichain.org'),
    8453: http('https://mainnet.base.org'),
    42161: http('https://arb1.arbitrum.io/rpc'),
  },
  defaultSlippageBps: 10, // override default of 5 bps (0.05%)
  confirmations: 1, // stored on client.config; not auto-read by adapters
});

client.getPublicClient(8453); // OseroPublicClient (memoised)
client.config.defaultSlippageBps;
```

### `ClientConfig`

```ts
type ClientConfig = {
  readonly transports?: Partial<Record<OseroChainId, Transport>>;
  readonly defaultSlippageBps?: number; // default 5
  readonly confirmations?: number; // default 1; read by callers, not adapters
};
```

All fields are optional. `OseroClient.create()` with no arguments returns
a usable client backed by viem's public HTTP transports (rate-limited;
override `transports` for production).

`ResolvedClientConfig` is the same shape with every field required; it is
what `client.config` exposes at runtime.

> **`confirmations` is not threaded through automatically.** The viem and
> ethers adapters each read `confirmations` from their own
> `SendWithOptions` argument and default to `1` if it is missing. Setting
> `confirmations` on `OseroClient.create({...})` only stores the value on
> `client.config` so callers can forward it themselves, e.g.
> `sendWith(wallet, { confirmations: client.config.confirmations })`.

### Public methods

| Method                                                     | Purpose                                                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OseroClient.create(config?)`                              | Factory — the only way to construct a client.                                                                                                                                                         |
| `client.config`                                            | `ResolvedClientConfig` (all fields populated with defaults).                                                                                                                                          |
| `client.getPublicClient(chainId)`                          | Memoised viem `PublicClient` for a chain. Throws `UnsupportedChainError` if the chain is unknown. Contrast with `getChain(chainId)`, which returns `null` for unsupported chains instead of throwing. |
| `client._setPublicClientForTesting(chainId, publicClient)` | **Test-only.** Inject a fake viem client. Marked `@internal`.                                                                                                                                         |

`OseroPublicClient` is the exported alias for `Client<Transport, Chain,
undefined, PublicRpcSchema, PublicActions>` — a generic viem public client
that supports every read method.

---

## Actions

Every action has the same shape:

```ts
action(client: OseroClient, request: Request): ResultAsync<Plan, Error>
```

The request object is token-specific but shares these fields:

```ts
type CommonRequest = {
  readonly chainId: number; // must be in SUPPORTED_CHAIN_IDS
  readonly amount: bigint; // raw, in the input token's native decimals
  readonly sender: `0x${string}`; // pays the input token; `from` on every tx
  readonly receiver?: `0x${string}`; // default = sender
  readonly slippageBps?: number; // default = client.config.defaultSlippageBps (5)
  readonly referralCode?: bigint; // default = 0n
};
```

Validation rules:

- `amount` **must be strictly greater than 0** — otherwise the action
  returns `ValidationError` on the `amount` field.
- `chainId` not in `SUPPORTED_CHAIN_IDS` → `UnsupportedChainError`.
- On mainnet `mintSUsds`, `referralCode` must fit in a `uint16`
  (`0n ≤ code ≤ 65_535n`) because the sUSDS `deposit(…, uint16)` overload
  is used. Out-of-range → `ValidationError`.
- On L2s, `slippageBps` must be an integer in `[0, 10_000]` (enforced by
  `applySlippage`).

### Action × plan-shape matrix

| Action        | Direction    | Input decimals | L2 plan                 | Mainnet plan                           |
| ------------- | ------------ | -------------: | ----------------------- | -------------------------------------- |
| `mintUsds`    | USDC → USDS  |              6 | `Erc20ApprovalRequired` | `Erc20ApprovalRequired`                |
| `mintSUsds`   | USDC → sUSDS |              6 | `Erc20ApprovalRequired` | `MultiStepExecution` (4 tx / 2 phases) |
| `redeemUsds`  | USDS → USDC  |             18 | `Erc20ApprovalRequired` | `Erc20ApprovalRequired`                |
| `redeemSUsds` | sUSDS → USDC |             18 | `Erc20ApprovalRequired` | `MultiStepExecution` (3 tx / 2 phases) |

Each action has a matching **preview helper** that returns the quoted
output as a raw `bigint` without building a plan. Previews only need
`chainId` and `amount`:

| Preview              | Quotes       | Input decimals | Output decimals |
| -------------------- | ------------ | -------------: | --------------: |
| `previewMintUsds`    | USDC → USDS  |              6 |              18 |
| `previewMintSUsds`   | USDC → sUSDS |              6 |              18 |
| `previewRedeemUsds`  | USDS → USDC  |             18 |               6 |
| `previewRedeemSUsds` | sUSDS → USDC |             18 |               6 |

### `mintUsds` — USDC → USDS

```ts
import { mintUsds, previewMintUsds } from '@osero/client/actions';
import type { Erc20ApprovalRequired } from '@osero/client';

type MintUsdsRequest = CommonRequest;
type MintUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

previewMintUsds(client, { chainId, amount });
// ResultAsync<bigint, MintUsdsError>

mintUsds(client, request);
// ResultAsync<Erc20ApprovalRequired, MintUsdsError>
```

- **L2 flow** (Base / Arbitrum / OP / Unichain):
  1. `USDC.approve(PSM3, amount)`
  2. `PSM3.swapExactIn(USDC, USDS, amount, minOut, receiver, referralCode)`
  - Quote comes from `PSM3.previewSwapExactIn`. `minOut` applies
    `slippageBps` to that quote.
- **Mainnet flow** (chain ID 1):
  1. `USDC.approve(UsdsPsmWrapper, amount)`
  2. `UsdsPsmWrapper.sellGem(receiver, amount)`
  - Quote is computed off-chain from `LitePSM.tin()` (governance-set
    fee-in). `slippageBps` and `referralCode` are **ignored** on mainnet.

### `mintSUsds` — USDC → sUSDS

```ts
import { mintSUsds, previewMintSUsds } from '@osero/client/actions';
import type { Erc20ApprovalRequired, MultiStepExecution } from '@osero/client';

type MintSUsdsRequest = CommonRequest;
type MintSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

previewMintSUsds(client, { chainId, amount });
// ResultAsync<bigint, MintSUsdsError>

mintSUsds(client, request);
// ResultAsync<Erc20ApprovalRequired | MultiStepExecution, MintSUsdsError>
```

- **L2 flow**: identical shape to `mintUsds`, but the PSM3 output asset
  is `sUSDS` instead of `USDS`. Single approval + single swap.
- **Mainnet flow** is a **`MultiStepExecution`** with **4 transactions**
  in 2 phases:
  1. Phase 1:
     1. `USDC.approve(UsdsPsmWrapper, amount)`
     2. `UsdsPsmWrapper.sellGem(sender, amount)` — first arg is `sender`,
        not `receiver`, because the intermediate USDS must land in the
        wallet that will approve and deposit it in phase 2. Contrast
        with `mintUsds` mainnet, which calls `sellGem(receiver, amount)`
        because there is no second phase.
  2. Phase 2:
     1. `USDS.approve(sUSDS, usdsOut)`
     2. `sUSDS.deposit(usdsOut, receiver[, referralCode])` — `receiver`
        ends up with the ERC-4626 shares.
  - **`deposit` overload selection**: only `referralCode === undefined`
    triggers the 2-arg `deposit(uint256, address)` overload. Passing
    `0n` explicitly (or any other `bigint`) routes to the 3-arg
    `deposit(uint256, address, uint16)` overload — _not_ the same as
    omitting the field.
  - `usdsOut` is read off-chain from `LitePSM.tin()` and scaled from USDC's
    6 decimals to USDS's 18. Slippage is not applied on mainnet — both
    legs are deterministic.
  - `referralCode` range on mainnet: `0n ≤ code ≤ 65_535n`.

### `redeemUsds` — USDS → USDC

```ts
import { redeemUsds, previewRedeemUsds } from '@osero/client/actions';
import type { Erc20ApprovalRequired } from '@osero/client';

type RedeemUsdsRequest = CommonRequest;
type RedeemUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

previewRedeemUsds(client, { chainId, amount });
// ResultAsync<bigint, RedeemUsdsError>

redeemUsds(client, request);
// ResultAsync<Erc20ApprovalRequired, RedeemUsdsError>
```

- **L2 flow**:
  1. `USDS.approve(PSM3, amount)`
  2. `PSM3.swapExactIn(USDS, USDC, amount, minOut, receiver, referralCode)`
- **Mainnet flow** uses `UsdsPsmWrapper.buyGem`, which is **exact-out**
  on `gemAmt` (USDC output, 6-dec), _not_ exact-in on USDS. The SDK
  does the inversion for the caller:
  1. `USDS.approve(UsdsPsmWrapper, amount)`
  2. `UsdsPsmWrapper.buyGem(receiver, gemAmt)`
  - `gemAmt` is computed from the caller's USDS budget (`amount`) and the
    current `LitePSM.tout()`, then **reduced by `slippageBps`** so a
    small `tout` increase between plan and execution can't cause a
    revert. Any unused USDS stays in `sender`'s balance.

### `redeemSUsds` — sUSDS → USDC

```ts
import { redeemSUsds, previewRedeemSUsds } from '@osero/client/actions';
import type { Erc20ApprovalRequired, MultiStepExecution } from '@osero/client';

type RedeemSUsdsRequest = CommonRequest;
type RedeemSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

previewRedeemSUsds(client, { chainId, amount });
// ResultAsync<bigint, RedeemSUsdsError>

redeemSUsds(client, request);
// ResultAsync<Erc20ApprovalRequired | MultiStepExecution, RedeemSUsdsError>
```

- **L2 flow**:
  1. `sUSDS.approve(PSM3, amount)`
  2. `PSM3.swapExactIn(sUSDS, USDC, amount, minOut, receiver, referralCode)`
- **Mainnet flow** is a **`MultiStepExecution`** with **3 transactions**:
  1. `sUSDS.redeem(amount, sender, sender)` — no approval needed because
     `sender` owns the shares; sender also receives the USDS.
  2. `USDS.approve(UsdsPsmWrapper, usdsOut)`
  3. `UsdsPsmWrapper.buyGem(receiver, gemAmt)` where `gemAmt` is
     `usdsOut` converted via `tout` and floored by `slippageBps`.
  - `usdsOut` comes from `sUSDS.previewRedeem(amount)` at plan time.
    The Sky Savings Rate (SSR) accrues upwards, so the live value at
    execution is always ≥ the quoted value — the approval never
    underflows.

### `chain` / `listChains` (action helpers)

`ResultAsync`-shaped wrappers over the registry, exported from
`@osero/client/actions` for API symmetry. Prefer the synchronous
`getChain` / `listChains` from `@osero/client` when chaining isn't needed.

```ts
import { chain, listChains } from '@osero/client/actions';

await listChains(client); // ResultAsync<readonly ChainMetadata[], UnexpectedError>
await chain(client, { chainId: 8453 }); // ResultAsync<ChainMetadata | null, UnexpectedError>
```

---

## The `ExecutionPlan` model

Every action returns a discriminated union tagged by `__typename`:

```ts
type ExecutionPlan = TransactionRequest | Erc20ApprovalRequired | MultiStepExecution;
```

### `TransactionRequest`

A fully-encoded, ready-to-sign EVM transaction. Adapters call
`sendTransaction` with exactly these fields.

```ts
type TransactionRequest = {
  readonly __typename: 'TransactionRequest';
  readonly chainId: number;
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly value: bigint; // always 0n today
  readonly operation: OperationType; // semantic tag (see below)
};
```

### `Erc20ApprovalRequired`

One or more ordered ERC-20 approvals gating a single main transaction.
Every L2 action and every mainnet swap action (excluding the sUSDS
multi-step flows) returns this shape.

```ts
type Erc20Approval = {
  readonly token: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly amount: bigint;
  readonly byTransaction: TransactionRequest; // tx that performs the approval
};

type Erc20ApprovalRequired = {
  readonly __typename: 'Erc20ApprovalRequired';
  readonly approvals: readonly Erc20Approval[];
  readonly originalTransaction: TransactionRequest; // the main tx
};
```

Execution order: every `approvals[i].byTransaction` is broadcast and
confirmed in order, then `originalTransaction`.

### `MultiStepExecution`

An ordered list of `ExecutionStep`s where each step must fully confirm
before the next starts. Mainnet `mintSUsds` (USDC → USDS → sUSDS) and
mainnet `redeemSUsds` (sUSDS → USDS → USDC) use this shape.

```ts
type ExecutionStep = TransactionRequest | Erc20ApprovalRequired;

type MultiStepExecution = {
  readonly __typename: 'MultiStepExecution';
  readonly steps: readonly ExecutionStep[];
};
```

`MultiStepExecution` is never nested inside another `MultiStepExecution`.

### `OperationType`

Stable provenance tag on every `TransactionRequest`. Lets callers classify
a step without decoding calldata. The union is exactly **7 string literals**:

```ts
type OperationType =
  | 'APPROVE_ERC20'
  | 'MINT_USDS'
  | 'MINT_SUSDS'
  | 'DEPOSIT_USDS_FOR_SUSDS'
  | 'REDEEM_USDS_FOR_USDC'
  | 'REDEEM_SUSDS_FOR_USDC'
  | 'REDEEM_SUSDS_FOR_USDS';
```

After a successful `sendWith`, `TransactionResult.operations` contains
the sequence of `OperationType`s in execution order. For a mainnet
`mintSUsds` that reads as:

```
['APPROVE_ERC20', 'MINT_USDS', 'APPROVE_ERC20', 'DEPOSIT_USDS_FOR_SUSDS']
```

### Plan introspection helpers

```ts
import {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  isTransactionRequest,
} from '@osero/client';
```

- `flattenExecutionPlan(plan)` → `readonly TransactionRequest[]`. Walks
  the plan and returns every tx that will actually be broadcast, in
  execution order. Useful for dry-runs, gas estimation, and UI previews.
- `isTransactionRequest(p)`, `isErc20ApprovalRequired(p)`,
  `isMultiStepExecution(p)` — exhaustive narrowing type guards.

### Plan construction helpers

These are marked `@internal` because actions already use them, but they
are exported for callers that want to build custom plans (e.g. batching
across actions, writing a custom adapter).

```ts
import {
  makeTransactionRequest, // wrap pre-encoded calldata
  makeApprovalTransaction, // build an ERC-20 approve tx
  makeSingleApprovalPlan, // one approval + one main tx
  makeApprovalRequiredPlan, // many approvals + one main tx
  makeMultiStepPlan, // ordered ExecutionStep[]
} from '@osero/client';
```

Signatures:

```ts
makeTransactionRequest(args: {
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;             // default 0n
  operation: OperationType;
}): TransactionRequest;

makeApprovalTransaction(args: {
  chainId: number;
  from: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
}): TransactionRequest;         // operation: 'APPROVE_ERC20'

makeSingleApprovalPlan(args: {
  chainId: number;
  from: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
  mainTransaction: TransactionRequest;
}): Erc20ApprovalRequired;

makeApprovalRequiredPlan(
  originalTransaction: TransactionRequest,
  approvals: readonly Erc20Approval[],
): Erc20ApprovalRequired;

makeMultiStepPlan(steps: readonly ExecutionStep[]): MultiStepExecution;
```

Always use these over hand-built plan objects — they keep the
`__typename` tags, default `value`, and `operation` provenance
consistent.

---

## Executing plans: wallet adapters

An adapter turns a plan into real transactions. Both adapters expose the
same curried/direct signature and ultimately funnel through the shared
`runExecutionPlan` loop in `src/lib/adapters.ts`.

```ts
type ExecutionPlanHandler<T extends ExecutionPlan = ExecutionPlan> = (
  plan: T,
) => ResultAsync<TransactionResult, SendWithError>;

type TransactionResult = {
  readonly txHash: `0x${string}`; // hash of the FINAL tx in the plan
  readonly operations: readonly OperationType[]; // full executed sequence
};

type SendWithError = CancelError | SigningError | TransactionError | UnexpectedError;
```

### viem adapter (`@osero/client/viem`)

```ts
import { sendWith, type SendWithOptions, type ConnectedWalletClient } from '@osero/client/viem';

type SendWithOptions = {
  readonly confirmations?: number; // default 1
};

// Curried form: sendWith(walletClient) → ExecutionPlanHandler
// Direct form:  sendWith(walletClient, plan) → ResultAsync<TransactionResult, …>
// Both accept an optional SendWithOptions.
```

Behaviour & requirements:

- Requires a viem `WalletClient<Transport, Chain, Account>` — both
  `account` **and** `chain` must be set. `ConnectedWalletClient` is the
  exported **type alias** that expresses this constraint at the type
  level; it is not a runtime check. The actual guard lives inside
  `sendWith`, which throws synchronously (not a `Result` error — a
  plain `Error`) if either field is missing on the value passed in.
- Per-tx flow: `estimateGas` (with a **15% buffer** added on top, matching
  the Aave SDK default) → `sendTransaction` → `waitForTransactionReceipt`
  (`confirmations` from options, default 1). Each step resolves before
  the next one starts.
- A reverted receipt (`receipt.status === 'reverted'`) becomes a
  `TransactionError` with `txHash` set to the reverting tx and `link`
  set to the chain's block-explorer URL for that tx (when the chain
  metadata includes one).
- `UserRejectedRequestError` (or a walked `TransactionExecutionError`
  wrapping one) → `CancelError`. Any other viem error → `SigningError`.
- The viem adapter does not hot-switch chains for you, but viem itself
  can handle chain switching upstream of the wallet client.

Curried usage (the canonical form):

```ts
import { OseroClient } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const rpc = 'https://mainnet.base.org';
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const client = OseroClient.create({ transports: { 8453: http(rpc) } });
const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });

const result = await mintUsds(client, {
  chainId: 8453,
  amount: parseUnits('100', 6),
  sender: account.address,
}).andThen(sendWith(wallet, { confirmations: 2 }));

if (result.isErr()) {
  console.error(result.error.name, result.error.message);
} else {
  console.log(result.value.txHash); // final tx hash
  console.log(result.value.operations.join(' → ')); // provenance trail
}
```

Direct usage (inspect before signing):

```ts
const planResult = await mintUsds(client, request);
if (planResult.isErr()) return planResult;

// ...show plan to the user...

const result = await sendWith(wallet, planResult.value);
```

### ethers adapter (`@osero/client/ethers`)

```ts
import { sendWith, type SendWithOptions } from '@osero/client/ethers';

type SendWithOptions = {
  readonly confirmations?: number; // default 1
};
```

Behaviour & requirements:

- Requires an **ethers v6** `Signer` with a `provider` attached. A
  detached signer produces `UnexpectedError`.
- **The signer must already be connected to the target chain.** Unlike
  the viem adapter, the ethers adapter does not switch chains. It
  reads `signer.provider.getNetwork()` and, if `chainId` disagrees with
  the plan's `chainId`, short-circuits every step with `UnexpectedError`
  (no transactions are sent).
- Per-tx flow: `signer.sendTransaction({ to, data, value, from })` →
  `response.wait(confirmations)` → map the receipt to either
  `txHash` or a `TransactionError` (`receipt.status === 0`).
- `ethers.isError(err, 'ACTION_REJECTED')` → `CancelError`. Other
  ethers errors → `SigningError`. Null receipts → `UnexpectedError`.

```ts
import { OseroClient } from '@osero/client';
import { mintUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { http } from 'viem';

const rpc = 'https://arb1.arbitrum.io/rpc';
const provider = new JsonRpcProvider(rpc, 42161);
const signer = new Wallet(process.env.PRIVATE_KEY!, provider);

// OseroClient still uses viem transports under the hood:
const client = OseroClient.create({ transports: { 42161: http(rpc) } });
const sender = (await signer.getAddress()) as `0x${string}`;

const result = await mintUsds(client, {
  chainId: 42161,
  amount: parseUnits('100', 6),
  sender,
}).andThen(sendWith(signer));
```

### Execution semantics (both adapters)

- Transactions are broadcast **strictly in order**. The adapter waits for
  each receipt (with `confirmations` satisfied) before starting the
  next tx. This is what makes approvals land before the swap they gate,
  and what makes phase 1 of a `MultiStepExecution` settle before phase 2
  begins.
- `TransactionResult.txHash` is only the **final** tx hash. Intermediate
  tx hashes are not currently surfaced — if the caller needs them they
  must read events or use a block explorer.

---

## Balance helpers

All four helpers return a raw `bigint` (in the token's native decimals)
wrapped in `ResultAsync`. They reuse `OseroClient`'s transport wiring
and the canonical token registry, so prefer them over hand-rolled
ERC-20 `balanceOf` calls.

```ts
import {
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
  getSUsdsBalance,
  type GetBalancesRequest,
  type GetTokenBalanceError,
  type GetTokenBalanceRequest,
  type TokenBalances,
} from '@osero/client';

type GetTokenBalanceRequest = {
  readonly chainId: number;
  readonly account: `0x${string}`;
  readonly token: TokenSymbol; // 'USDC' | 'USDS' | 'sUSDS'
};

type GetBalancesRequest = {
  readonly chainId: number;
  readonly account: `0x${string}`;
};

type TokenBalances = {
  readonly USDC: bigint;
  readonly USDS: bigint;
  readonly sUSDS: bigint;
};

type GetTokenBalanceError = UnsupportedChainError | UnexpectedError;
```

| Helper             | Returns                                            |
| ------------------ | -------------------------------------------------- |
| `getTokenBalance`  | `ResultAsync<bigint, GetTokenBalanceError>`        |
| `getTokenBalances` | `ResultAsync<TokenBalances, GetTokenBalanceError>` |
| `getUsdcBalance`   | `ResultAsync<bigint, GetTokenBalanceError>`        |
| `getUsdsBalance`   | `ResultAsync<bigint, GetTokenBalanceError>`        |
| `getSUsdsBalance`  | `ResultAsync<bigint, GetTokenBalanceError>`        |

```ts
const result = await getTokenBalances(client, {
  chainId: 8453,
  account: wallet.account.address,
});
if (result.isOk()) {
  const { USDC, USDS, sUSDS } = result.value;
}
```

---

## Error taxonomy

Every SDK error extends the abstract base class `OseroError`, which itself
extends `Error`. You can narrow with `instanceof OseroError`, but
`switch (result.error.name)` is the idiomatic form because the `name`
field is assigned in every constructor and is part of the public contract.

```ts
import {
  OseroError, // abstract base
  ValidationError,
  UnsupportedChainError,
  InsufficientBalanceError,
  CancelError,
  SigningError,
  TransactionError,
  UnexpectedError,
} from '@osero/client';
```

### Field reference

| Class                      | `name`                       | Extra fields                          | When it appears                                                                                   |
| -------------------------- | ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ValidationError<Context>` | `'ValidationError'`          | `context: Context` (e.g. `{ field }`) | Bad input (amount ≤ 0, bad referralCode, etc.)                                                    |
| `UnsupportedChainError`    | `'UnsupportedChainError'`    | `chainId: number`                     | `chainId` not in `SUPPORTED_CHAIN_IDS`                                                            |
| `InsufficientBalanceError` | `'InsufficientBalanceError'` | `token`, `required`, `available`      | **Unused today.** Reserved for a future balance-preflight pass; current actions never produce it. |
| `CancelError`              | `'CancelError'`              | —                                     | User rejected the wallet prompt                                                                   |
| `SigningError`             | `'SigningError'`             | —                                     | Wallet failed to sign for a non-cancel reason                                                     |
| `TransactionError`         | `'TransactionError'`         | `txHash: Hex`, `link?: string`        | Tx was broadcast but reverted                                                                     |
| `UnexpectedError`          | `'UnexpectedError'`          | — (always wraps `cause`)              | RPC failure, ethers chain mismatch, unclassified runtime error                                    |

### Union types

```ts
// Returned by actions before handoff to sendWith:
type ActionError =
  | ValidationError
  | UnsupportedChainError
  | InsufficientBalanceError
  | UnexpectedError;

// Returned by sendWith:
type SendWithError = CancelError | SigningError | TransactionError | UnexpectedError;
```

Each action also exports a per-action alias:

```ts
type MintUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;
type MintSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;
type RedeemUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;
type RedeemSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;
```

### Handling

```ts
const result = await mintUsds(client, request).andThen(sendWith(wallet));

if (result.isErr()) {
  switch (result.error.name) {
    case 'ValidationError':
      /* amount <= 0, bad referralCode, etc. */ break;
    case 'UnsupportedChainError':
      /* result.error.chainId */ break;
    case 'CancelError':
      /* user rejected */ break;
    case 'TransactionError': {
      // .txHash is the reverting tx; .link may be populated on viem
      console.error(result.error.txHash, result.error.link);
      break;
    }
    case 'SigningError':
    case 'UnexpectedError':
      /* inspect .cause */ break;
  }
  return;
}

const { txHash, operations } = result.value;
```

### Factory helpers

The internal `.from(cause)` factories on `CancelError`, `SigningError`,
`TransactionError`, and `UnexpectedError` are used by the adapters to
normalise wallet errors. You can call them in custom adapters; you
generally do not need them in application code.

---

## Math helpers

Used internally by the mainnet actions to compute `usdsOut` / `gemAmt`
from the Lite PSM fees. Exposed so callers can audit or rebuild the
math.

```ts
import {
  BPS, // 10_000n  (100% in basis points)
  WAD, // 1_000_000_000_000_000_000n  (1e18)
  USDC_TO_USDS_SCALE, // 1_000_000_000_000n  (1e12)
  applySlippage,
  usdsFromUsdcViaSellGem,
  usdsNeededForUsdcViaBuyGem,
  usdcFromUsdsViaBuyGem,
} from '@osero/client';
```

Signatures & semantics:

```ts
applySlippage(quote: bigint, slippageBps: number): bigint
// Floors `quote` by `slippageBps`. Throws RangeError for non-integer or
// out-of-[0, 10_000] inputs.
//   applySlippage(1_000_000n, 5) === 999_500n   // 5 bps = 0.05%

usdsFromUsdcViaSellGem(gemAmt: bigint, tin: bigint): bigint
// USDS output from Sky sellGem given USDC input `gemAmt` (6-dec) and
// current `tin` (18-dec fraction of WAD).  usdsOutWad = gemAmt * 1e12 * (WAD - tin) / WAD

usdsNeededForUsdcViaBuyGem(gemAmt: bigint, tout: bigint): bigint
// USDS required to buy `gemAmt` (6-dec) via Sky buyGem given `tout`.
//   usdsInWad = gemAmt * 1e12 + gemAmt * 1e12 * tout / WAD

usdcFromUsdsViaBuyGem(usdsInWad: bigint, tout: bigint): bigint
// Inverse of the above: given USDS budget (18-dec) and current `tout`,
// compute the maximum USDC output (6-dec). Floors for safety.
```

See the `tin` / `tout` glossary in the [PSM addresses](#psm-addresses)
section for the fee semantics; both helpers are exact at runtime
regardless of the current values.

---

## `Result` / `ResultAsync` re-exports

```ts
import {
  Result,
  ResultAsync,
  ok,
  err,
  okAsync,
  errAsync,
  fromPromise,
  fromThrowable,
  fromAsyncThrowable,
} from '@osero/client';
```

These are thin re-exports of [`neverthrow`](https://github.com/supermacro/neverthrow)
— same semantics, same methods (`.andThen`, `.map`, `.mapErr`, `.combine`,
`.isOk`, `.isErr`, etc.). Always import them from `@osero/client` so the
dependency remains swappable.

Typical chain:

```ts
const result = await mintSUsds(client, request)
  .andThen(sendWith(wallet)) // Result stays Err if the plan step failed
  .mapErr((err) => {
    // optional: normalise errors upstream
    if (err.name === 'CancelError') return new Error('user cancelled');
    return err;
  });
```

Combining preview + balance reads:

```ts
import { ResultAsync } from '@osero/client';

const combined = await ResultAsync.combine([
  previewMintSUsds(client, { chainId: 8453, amount: parseUnits('100', 6) }),
  getUsdcBalance(client, { chainId: 8453, account }),
]);

if (combined.isOk()) {
  const [expectedShares, usdcBalance] = combined.value;
}
```

---

## Public ABIs

The SDK bundles five minimal ABIs covering every function it calls.
Re-use them in read-only UIs or custom adapters.

```ts
import {
  erc20Abi, // approve, allowance, balanceOf, decimals
  erc4626Abi, // asset, deposit (2 + 3 arg), redeem, previewDeposit, previewRedeem, etc.
  litePsmAbi, // tin, tout, pocket  — mainnet audit reads
  psm3Abi, // swapExactIn, swapExactOut, previewSwapExactIn, previewSwapExactOut
  usdsPsmWrapperAbi, // sellGem, buyGem, and their quote helpers
} from '@osero/client';
```

- `erc20Abi` is a **minimal** subset; it is not the full OpenZeppelin
  ERC-20. It only covers what the SDK actually uses.
- `erc4626Abi` includes both the 2-arg and 3-arg (`… , uint16 referral`)
  overloads of `deposit`; viem's `encodeFunctionData` disambiguates by
  arity.
- `psm3Abi` and `usdsPsmWrapperAbi` are the Spark contracts' public
  interfaces; the underlying Sky `LitePSM` exposes more than `litePsmAbi`
  — the SDK only reads `tin`, `tout`, and (informatively) `pocket`.

---

## Dry-run / plan inspection

Inspect a plan before signing to validate generated SDK code without
risking funds. No wallet, no private key — only `eth_call`s against the
public RPC.

```ts
import {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  isTransactionRequest,
  OseroClient,
} from '@osero/client';
import { mintSUsds } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

const client = OseroClient.create({ transports: { 1: http('https://eth.llamarpc.com') } });
const SENDER = '0x1111111111111111111111111111111111111111' as const;

const planResult = await mintSUsds(client, {
  chainId: 1,
  amount: parseUnits('100', 6),
  sender: SENDER,
});

if (planResult.isOk()) {
  const plan = planResult.value;

  if (isTransactionRequest(plan)) {
    console.log('single tx:', plan.operation);
  } else if (isErc20ApprovalRequired(plan)) {
    console.log('approvals:', plan.approvals.length);
    console.log('main op:', plan.originalTransaction.operation);
  } else if (isMultiStepExecution(plan)) {
    console.log('phases:', plan.steps.length);
  }

  for (const tx of flattenExecutionPlan(plan)) {
    console.log(tx.operation, tx.to, tx.data.slice(0, 10));
  }
}
```

The canonical repo walk-through is
[`examples/src/dry-run/inspect-plan.ts`](examples/src/dry-run/inspect-plan.ts)
— it builds a plan for every action against both an L2 and mainnet,
without broadcasting anything.

---

## Examples in this repo

Run from the repo root:

```bash
pnpm install
cp examples/.env.example examples/.env   # fill in PRIVATE_KEY + optional RPC URLs

# Safe — no funds, no tx:
pnpm --filter @osero/examples dry-run:inspect-plan

# Broadcast — real txs, real gas:
pnpm --filter @osero/examples viem:mint-usds
pnpm --filter @osero/examples viem:mint-susds-mainnet
pnpm --filter @osero/examples viem:redeem-susds
pnpm --filter @osero/examples viem:roundtrip
pnpm --filter @osero/examples ethers:mint-usds
pnpm --filter @osero/examples ethers:roundtrip
```

Pointers for common tasks (read these for canonical usage patterns):

| Goal                                                     | Example file                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Inspect every plan shape without signing                 | [`examples/src/dry-run/inspect-plan.ts`](examples/src/dry-run/inspect-plan.ts)               |
| Curried viem `sendWith` — USDC → USDS on Base            | [`examples/src/viem/mint-usds.ts`](examples/src/viem/mint-usds.ts)                           |
| Mainnet `MultiStepExecution` — USDC → sUSDS on L1        | [`examples/src/viem/mint-susds-mainnet.ts`](examples/src/viem/mint-susds-mainnet.ts)         |
| Eager `sendWith` — build plan, inspect, then send        | [`examples/src/viem/redeem-susds.ts`](examples/src/viem/redeem-susds.ts)                     |
| Full round-trip using preview + balance helpers (viem)   | [`examples/src/viem/roundtrip-usdc-susds.ts`](examples/src/viem/roundtrip-usdc-susds.ts)     |
| Same round-trip through ethers v6                        | [`examples/src/ethers/roundtrip-usdc-susds.ts`](examples/src/ethers/roundtrip-usdc-susds.ts) |
| ethers v6 mint — the minimal adapter switch vs. viem     | [`examples/src/ethers/mint-usds.ts`](examples/src/ethers/mint-usds.ts)                       |
| Pretty-printing plans (`describePlan`, `describeResult`) | [`examples/src/shared/format.ts`](examples/src/shared/format.ts)                             |
| Env loading / RPC URL lookup                             | [`examples/src/shared/env.ts`](examples/src/shared/env.ts)                                   |

---

## Common pitfalls

1. **Do not import actions from the root.** Actions live at
   `@osero/client/actions`. The root (`@osero/client`) does not re-export
   them.
2. **`amount` is always raw.** Use viem's / ethers' `parseUnits` — never
   pass floats or human-readable strings.
3. **Decimals differ by direction.** Mint actions take USDC (6 dec).
   Redeem actions take USDS (18 dec) or sUSDS (18 dec).
4. **Every action returns `ResultAsync`.** Always `await` and branch on
   `.isOk()` / `.isErr()` — never `try/catch`.
5. **Pipe with `.andThen(sendWith(wallet))`.** The curried form flows
   the plan into the adapter while preserving the error union. The
   direct form (`sendWith(wallet, plan)`) is the right call when the
   plan needs to be inspected (or shown to the user) before signing.
6. **Viem wallet needs `account` + `chain` up-front.** `sendWith` from
   `@osero/client/viem` throws synchronously (plain `Error`) otherwise.
7. **Ethers signer must already be on the target chain.** The ethers
   adapter does not hot-switch; a mismatch short-circuits with
   `UnexpectedError` before any tx is sent.
8. **`OseroClient` still needs viem transports even for ethers users.**
   The client reads on-chain state (PSM3 previews, Lite PSM fees, sUSDS
   `previewRedeem`) through viem public clients.
9. **Do not assume `TransactionResult.txHash` covers every step.** It is
   only the hash of the **final** tx. Use `operations` for the full
   provenance trail, or listen for events if intermediate hashes are
   required.
10. **Do not hard-code addresses.** Use `getToken(chainId, symbol)` and
    `PSM_ADDRESSES[chainId]`.
11. **Do not bind a wallet to `OseroClient`.** The client is stateless
    from the caller's perspective; signing is an adapter concern.
12. **Mainnet mints/redeems of sUSDS are multi-step.** The plan has
    multiple tx hashes (2–4 depending on direction). Budget for the
    extra block time in UI flows.
13. **Mainnet `redeemUsds` uses `buyGem` (exact-out).** The SDK derives
    `gemAmt` from the caller's USDS budget; a tiny bit of USDS stays in
    `sender`'s balance. Do not assume the full `amount` is pulled.
14. **`referralCode` on mainnet `mintSUsds` is a `uint16`.** Pass `0n`
    (default) if unused, otherwise keep within `[0n, 65_535n]`.

---

## Type index

Quick lookup of every public type name re-exported from `@osero/client`:

```
// Client
OseroClient                    class
OseroPublicClient              type alias for viem PublicClient
ClientConfig                   type     (user-facing)
ResolvedClientConfig           type     (after defaults applied)

// Chain registry
ChainMetadata                  type
OseroChainId                   type     1 | 10 | 130 | 8453 | 42161
SUPPORTED_CHAIN_IDS            const    tuple

// Tokens
Token                          type
TokenSymbol                    type     'USDC' | 'USDS' | 'sUSDS'

// Addresses
PsmAddresses                   type

// Actions — requests
MintUsdsRequest                type
PreviewMintUsdsRequest         type
MintSUsdsRequest               type
PreviewMintSUsdsRequest        type
RedeemUsdsRequest              type
PreviewRedeemUsdsRequest       type
RedeemSUsdsRequest             type
PreviewRedeemSUsdsRequest      type

// Actions — errors
MintUsdsError                  type
MintSUsdsError                 type
RedeemUsdsError                type
RedeemSUsdsError               type

// Plans
OperationType                  type     union of 7 string literals
TransactionRequest             type
Erc20Approval                  type
Erc20ApprovalRequired          type
ExecutionStep                  type     TransactionRequest | Erc20ApprovalRequired
MultiStepExecution             type
ExecutionPlan                  type     discriminated union
ExecutionPlanHandler<T>        type     plan-executor function
TransactionResult              type     { txHash, operations }

// Error unions
ActionError                    type     plan-building errors
SendWithError                  type     execution errors

// Balances
GetTokenBalanceRequest         type
GetBalancesRequest             type
TokenBalances                  type     { USDC, USDS, sUSDS }
GetTokenBalanceError           type

// viem adapter
ConnectedWalletClient          type     WalletClient<Transport, Chain, Account>
SendWithOptions                type     (viem) { confirmations? }

// ethers adapter
SendWithOptions                type     (ethers) { confirmations? }
```

---

## Source references

For canonical usage in this repo, start here:

- `packages/client/README.md` — short tour with both viem and ethers
  quick-starts.
- `packages/client/src/index.ts` — authoritative list of every re-export.
- `packages/client/src/lib/types.ts` — every `ExecutionPlan` / result
  type.
- `packages/client/src/lib/actions/*.ts` — each action's full validation
  and branching logic.
- `packages/client/src/lib/chains.ts`, `tokens.ts`, `addresses.ts` — the
  single source of truth for chain IDs, tokens, and PSM addresses.
- `packages/client/src/viem.ts` / `ethers.ts` — adapter internals,
  gas buffering, error mapping.
- `PSM_GUIDE.md` (repo root) — background on `tin`, `tout`, `sellGem`,
  `buyGem`, and how the Spark wrapper fronts the Sky Lite PSM.
