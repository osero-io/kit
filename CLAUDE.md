# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

pnpm + Nx TypeScript monorepo. The only publishable package is `@osero/client` in `packages/client`. Runnable broadcast/dry-run examples live in `examples/` (private package `@osero/examples`). Design notes for the underlying Sky/Spark contracts are in `PSM_GUIDE.md` and additional contributor conventions in `AGENTS.md`.

## Commands

- `pnpm install` — install workspace deps
- `pnpm nx build @osero/client` — compile the SDK (TS project references)
- `pnpm nx typecheck @osero/client` — declaration-only typecheck
- `pnpm nx test @osero/client` — run the Vitest suite (coverage → `packages/client/test-output/vitest/coverage`)
- Run a single test: `pnpm nx test @osero/client -- -t "<test name>"` or point vitest at a file: `pnpm nx test @osero/client -- packages/client/src/lib/actions/mintUsds.test.ts`
- `pnpm lint` / `pnpm lint:fix` — oxlint across workspace
- `pnpm format:check` / `pnpm format` — oxfmt
- `pnpm --filter @osero/examples dry-run:inspect-plan` — safe plan-building example (no broadcast)

Broadcasting examples (`pnpm --filter @osero/examples viem:mint-usds`, etc.) send real transactions — they require `examples/.env` with a disposable `PRIVATE_KEY`.

## Releases

Changesets drives independent package versioning. When touching anything under `packages/*`, add `pnpm changeset` in the same PR. Merging to `main` opens/updates a release PR; merging that PR publishes via the `ci:publish` script.

## Architecture

The SDK's central abstraction is the **`ExecutionPlan`** (`packages/client/src/lib/types.ts`): a wallet-agnostic, inspectable description of the transactions needed to fulfil an action. This is what makes the SDK viem/ethers-neutral — actions never touch a wallet, adapters never touch PSM logic.

Three plan variants, discriminated by `__typename`:

- `TransactionRequest` — one fully-encoded tx ready to sign.
- `Erc20ApprovalRequired` — a main tx gated behind ordered ERC-20 approvals. Approvals confirm before `originalTransaction` broadcasts.
- `MultiStepExecution` — ordered phases where each step must confirm before the next starts. Used for mainnet sUSDS mints (approve → mint USDS → approve → deposit into sUSDS).

### Flow

1. `OseroClient.create({ transports, defaultSlippageBps })` — stateless; lazily builds viem public clients per chain in `getPublicClient(chainId)` (memoised in a `Map`). `_setPublicClientForTesting` is how tests inject fakes.
2. Actions in `src/lib/actions/` (`mintUsds`, `mintSUsds`, `redeemUsds`, `redeemSUsds`, plus `preview*` helpers) take `(client, request)` and return `ResultAsync<ExecutionPlan, ActionError>` — they branch on `chain.isMainnet` because mainnet uses Sky's `UsdsPsmWrapper` + Lite PSM while L2s use Spark's PSM3.
3. Adapter `sendWith(wallet)` in `src/viem.ts` or `src/ethers.ts` returns an `ExecutionPlanHandler` that the caller chains with `.andThen()`. Both adapters collapse to a single `SingleTxExecutor` and reuse `runExecutionPlan` from `adapters.ts` — `flattenExecutionPlan` defines the canonical broadcast order.

### Plan construction

Never hand-build plan objects. Use the helpers in `src/lib/plan.ts` (`makeTransactionRequest`, `makeApprovalTransaction`, `makeSingleApprovalPlan`, `makeApprovalRequiredPlan`, `makeMultiStepPlan`) so the `__typename` tags and `operation` provenance stay consistent.

### Errors & results

Never throw from an action path. Errors are typed classes in `src/lib/errors.ts` (`ValidationError`, `UnsupportedChainError`, `InsufficientBalanceError`, `TransactionError`, `SigningError`, `CancelError`, `UnexpectedError`) and returned via `neverthrow`. Re-exports of `Result`/`ResultAsync` come from `src/lib/result.ts` — import from there, not directly from `neverthrow`, so the dependency stays swappable.

### Chain/token registry

`src/lib/chains.ts` (`SUPPORTED_CHAIN_IDS`, `CHAINS`, `isSupportedChainId`), `src/lib/tokens.ts`, and `src/lib/addresses.ts` are the single source of truth — any new chain requires updating all three plus the `PSM_ADDRESSES` entry (and a `litePsm` entry if mainnet-style). `isMainnet` is semantic (only chain ID 1) because it switches the action flow, not a geographic flag.

## Code style

- Strict TypeScript, ESM, **`.js` extensions on local imports** (these files are `.ts` but resolved post-build).
- Formatting enforced by `.oxfmtrc.json` (2-space, single quotes, semis, trailing commas, 100-col, sorted imports). Lint via oxlint (`.oxlintrc.json`).
- `PascalCase` types/classes, `camelCase` values. Test helpers live in `_testing.ts` files which are excluded from the published package.
- Tests colocated as `*.test.ts`. Action tests belong next to the action and should cover both validation failures and the resulting `ExecutionPlan` shape (not just the final tx hash).

## Package exports

`@osero/client` ships four subpath exports: `.` (types, client, registries), `./actions`, `./viem`, `./ethers`. The `package.json` `exports` map has an `osero-sdk` condition pointing at raw `.ts` source for in-repo consumers (examples), and `import`/`default` for the built `./dist/*.js` for published consumers. Keep those in sync when adding a new entrypoint.
