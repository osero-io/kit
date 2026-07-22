# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

pnpm + Nx TypeScript monorepo. The only publishable package is `@osero/client` in `packages/client`. Runnable broadcast/dry-run/API examples live in `examples/` (private package `@osero/examples`). GitBook-staged docs live in `docs/osero-sdk`, including the 0.x → 1.0 upgrade guide. Design notes for the underlying Sky/Spark contracts are in `PSM_GUIDE.md` and additional contributor conventions in `AGENTS.md`.

## Commands

- `pnpm install` — install workspace deps
- `pnpm nx build @osero/client` — compile the SDK (TS project references)
- `pnpm nx typecheck @osero/client` — declaration-only typecheck
- `pnpm nx test @osero/client` — run the Vitest suite (coverage → `packages/client/test-output/vitest/coverage`)
- Run a single test: `pnpm nx test @osero/client -- -t "<test name>"` or point vitest at a file: `pnpm nx test @osero/client -- packages/client/src/lib/actions/mintUsds.test.ts`
- `pnpm lint` / `pnpm lint:fix` — oxlint across workspace
- `pnpm format:check` / `pnpm format` — oxfmt
- `pnpm --filter @osero/examples dry-run:inspect-plan` — safe local plan-building example (no broadcast)
- `OSERO_API_KEY=osero_... pnpm --filter @osero/examples api:quote-swap` — safe hosted API quote example (no broadcast)

Broadcasting examples (`pnpm --filter @osero/examples viem:mint-usds`, etc.) send real transactions — they require `examples/.env` with a disposable `PRIVATE_KEY`.

## Releases

Changesets drives independent package versioning. When touching anything under `packages/*`, add `pnpm changeset` in the same PR. Merging to `main` opens/updates a release PR; merging that PR publishes via the `ci:publish` script.

## Architecture

The SDK's central abstraction is the **`ExecutionPlan`** (`packages/client/src/lib/types.ts`): a wallet-agnostic, inspectable description of the transactions needed to fulfil a local action or hosted API quote. This is what makes the SDK viem/ethers/Privy-neutral — action/API clients never touch a wallet, adapters never touch PSM or routing logic.

Three plan variants, discriminated by `__typename`:

- `TransactionRequest` — one fully-encoded tx ready to sign.
- `Erc20ApprovalRequired` — a main tx gated behind ordered ERC-20 approvals. Approvals confirm before `originalTransaction` broadcasts.
- `MultiStepExecution` — ordered phases where each step must confirm before the next starts. Used for mainnet sUSDS mints (approve → mint USDS → approve → deposit into sUSDS).

### Flow

1. `OseroClient.create({ transports, defaultSlippageBps })` — stateless; lazily builds viem public clients per chain in `getPublicClient(chainId)` (memoised in a `Map`). `_setPublicClientForTesting` is how tests inject fakes.
2. Actions in `src/lib/actions/` (`mintUsds`, `mintSUsds`, `redeemUsds`, `redeemSUsds`, plus `preview*` helpers) take `(client, request)` and return `ResultAsync<ExecutionPlan, ActionError>` — they branch on `chain.isMainnet` because mainnet uses Sky's `UsdsPsmWrapper` + Lite PSM while L2s use Spark's PSM3.
3. `OseroApiClient` in `src/lib/api.ts` calls the hosted API, passes asset refs through (the hosted API validates assets, pairs, and policy), and attaches an adapter-compatible `ExecutionPlan` to every quote. API quote execution transactions use operation `SWAP`; local actions keep specific mint/redeem operation tags.

### Plan construction

Never hand-build plan objects. Use the helpers in `src/lib/plan.ts` (`makeTransactionRequest`, `makeApprovalTransaction`, `makeSingleApprovalPlan`, `makeApprovalRequiredPlan`, `makeMultiStepPlan`) so the `__typename` tags and `operation` provenance stay consistent. Hosted API quote conversion belongs in `swapQuoteToExecutionPlan`.

### Errors & results

Never throw from an action path. Errors are typed classes in `src/lib/errors.ts` (`ValidationError`, `UnsupportedChainError`, `InsufficientBalanceError`, `TransactionError`, `SigningError`, `CancelError`, `UnexpectedError`) and returned via `neverthrow`. Re-exports of `Result`/`ResultAsync` come from `src/lib/result.ts` — import from there, not directly from `neverthrow`, so the dependency stays swappable.

### Chain/token/API registries

`src/lib/chains.ts` (`SUPPORTED_CHAIN_IDS`, `CHAINS`, `isSupportedChainId`), `src/lib/tokens.ts`, and `src/lib/addresses.ts` are the single source of truth for local action builders — any new local PSM chain requires updating all three plus the `PSM_ADDRESSES` entry (and a `litePsm` entry if mainnet-style). `isMainnet` is semantic (only chain ID 1) because it switches the action flow, not a geographic flag.

Hosted API vocabulary is different: the client ships **no gate**. The `OSERO_API_KNOWN_*` exports in `src/lib/api.ts` are advisory snapshots that only power editor autocomplete and offline UI hints — refresh them when the hosted API's vocabulary changes, but never validate a request or response against them. Decoders must stay structural (wire grammar and execution safety only); do not add membership checks or registry cross-checks. Adding hosted assets is an API-repo change (the SDK optionally refreshes the `KNOWN_*` rows for autocomplete). The local action registries above stay strict — they gate local plan building.

## Code style

- Strict TypeScript, ESM, **`.js` extensions on local imports** (these files are `.ts` but resolved post-build).
- Formatting enforced by `.oxfmtrc.json` (2-space, single quotes, semis, trailing commas, 100-col, sorted imports). Lint via oxlint (`.oxlintrc.json`).
- `PascalCase` types/classes, `camelCase` values. Test helpers live in `_testing.ts` files which are excluded from the published package.
- Tests colocated as `*.test.ts`. Action tests belong next to the action and should cover both validation failures and the resulting `ExecutionPlan` shape (not just the final tx hash).

## Package exports

`@osero/client` ships six subpath exports: `.` (types, client, registries), `./actions`, `./api`, `./viem`, `./ethers`, `./privy`. The `package.json` `exports` map has an `osero-sdk` condition pointing at raw `.ts` source for in-repo consumers (examples), and `import`/`default` for the built `./dist/*.js` for published consumers. Keep those in sync when adding a new entrypoint.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `osero-io/kit`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
