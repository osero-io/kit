# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

pnpm + Turborepo TypeScript monorepo, compiled with TypeScript 7. The only publishable package is `@osero/client` in `packages/client`. Runnable broadcast/dry-run/API examples live in `examples/` (private package `@osero/examples`). GitBook-staged docs live in `docs/osero-sdk`, including the 0.x → 1.0 upgrade guide. Design notes for the underlying Sky/Spark contracts are in `PSM_GUIDE.md` and additional contributor conventions in `AGENTS.md`.

## Commands

- `pnpm install` — install workspace deps
- `pnpm build` — `turbo run build`: compile the SDK with `tsc --build` (TS project references) into `packages/client/dist`
- `pnpm typecheck` — `turbo run typecheck`: declaration-only typecheck of the client (including its tests) and the examples
- `pnpm test` — `turbo run test`: run the Vitest suite. Coverage: `pnpm turbo run test -- --coverage` (written to `packages/client/test-output/vitest/coverage`)
- `pnpm check` — format, lint, build, and typecheck (`turbo run format:check lint build typecheck`), then every package's test suite once with its coverage thresholds (`pnpm -r run test --coverage`, outside turbo so it always runs and sees your environment)
- Scope any task to one package with a turbo filter: `pnpm turbo run build --filter=@osero/client`
- Run a single test: `pnpm --filter @osero/client test -t "<test name>"` or point vitest at a file: `pnpm --filter @osero/client test src/lib/actions/prepareSwap.test.ts`
- `pnpm browser:check` — bundle the browser-supported entrypoints of the built SDK with esbuild and fail on any Node built-in import (run after `pnpm build`; CI runs it)
- `pnpm lint` / `pnpm lint:fix` — oxlint across workspace
- `pnpm format:check` / `pnpm format` — oxfmt
- `pnpm --filter @osero/examples dry-run:inspect-plan` — safe local plan-building example (no broadcast)
- `OSERO_API_KEY=osero_... pnpm --filter @osero/examples api:quote-swap` — safe hosted API quote example (no broadcast)

Task graph and caching live in `turbo.json`. `build` caches `dist/`; `typecheck` depends on `build` because both run `tsc --build` against the same project references and write the same `tsbuildinfo`; `test` depends on `^build`. Lint and format are root-level tasks (`//#lint`, `//#format:check`, …) because oxlint/oxfmt cover the whole workspace in one pass.

Broadcasting examples (`pnpm --filter @osero/examples viem:mint-usds`, etc.) send real transactions — they require `examples/.env` with a disposable `PRIVATE_KEY`.

## Releases

Changesets drives independent package versioning. When touching anything under `packages/*`, add `pnpm changeset` in the same PR. Merging to `main` opens/updates a release PR; merging that PR publishes via the `ci:publish` script.

## Architecture

The SDK's central abstraction is the **`ExecutionPlan`** (`packages/client/src/lib/types.ts`): a wallet-agnostic, inspectable description of the transactions needed to fulfil a local action or hosted API quote. This is what makes the SDK viem/ethers/Privy-neutral — action/API clients never touch a wallet, adapters never touch PSM or routing logic.

A plan is one flat, versioned object: `{ __typename: 'ExecutionPlan', version, id, steps, requirements, metadata }`.

- `steps` is an ordered list of `TransactionRequest`s. Each step has a stable `id`, an `operation` tag, and fully encoded calldata. An ERC-20 approval is an ordinary step (`operation: 'APPROVE_ERC20'`) that carries `authorization` metadata, not a wrapper around another transaction. Each step must confirm before the next is sent.
- `requirements` states what an executor must support (`execution: 'sequential' | 'atomic-batch'`, authorization kind, sponsorship, chain transitions). Adapters reject a plan they cannot satisfy before broadcasting.
- `version` is `1` for plans without a quote expiry and `2` for plans that carry `quoteExpiresAt` (hosted quotes and recovery deadlines). `id` is a hash of the executable contents; see `computeExecutionPlanId` in `src/lib/validation.ts`. Plan identity and the serialization format are frozen: `tests/fixtures/execution-plans.v1_0_1.json` pins them.

### Flow

1. `OseroClient.create({ transports, publicClients, allowPublicRpc, defaultSlippage, referral })` — stateless; lazily builds viem public clients per chain in `getPublicClient(chainId)` (memoised in a `Map`). There is no implicit public RPC: a chain needs a transport, an injected public client, or `allowPublicRpc: true`. Tests inject fakes through `publicClients` (see `createMockClient` in `src/lib/_testing.ts`).
2. Local actions in `src/lib/actions/` are `quoteSwap` and `prepareSwap` (plus `simulateExecutionPlan` from `src/lib/simulation.ts`). They take `(client, request)` with `assetIn`, `assetOut`, and an `exact-in` or `exact-out` mode, and return `ResultAsync` of a quote or of a prepared quote that includes the `ExecutionPlan`. Which pairs and modes exist on each chain comes from the capability matrix in `src/lib/capabilities.ts`; the route builder branches on the chain's `protocol` (`'ethereum-lite-psm'` on mainnet, which uses Sky's `UsdsPsmWrapper` + Lite PSM and the sUSDS ERC-4626 vault, or `'psm3'` on L2s, which use Spark's PSM3).
3. `OseroApiClient` in `src/lib/api.ts` calls the hosted API, passes asset refs through (the hosted API validates assets, pairs, and policy), and returns a discriminated Hosted Swap Workflow. The quote retains its diagnostic API Execution Plan, while `walletExecutionPlan` contains only the currently safe actions. Hosted execution transactions use operation `SWAP_EXACT_IN`; local actions keep specific mint/redeem operation tags.
4. Wallet adapters (`src/viem.ts`, `src/ethers.ts`, `src/privy.ts`, `src/eip5792.ts`) export `sendWith`. They share `runExecutionPlan` and the capability preflight in `src/lib/adapters.ts`. Their defaults and per-stage error mappings are specified in `docs/osero-sdk/adapters.md`; keep that page in sync when changing adapter behaviour.

### Plan construction

Never hand-build plan objects. Use the constructors in `src/lib/plan.ts` so schema tags, checksums, expiry, and operation provenance stay consistent. Hosted API preparation belongs in `src/lib/api.ts`; never pass an API Execution Plan directly to a wallet adapter.

### Errors & results

Never throw from an action path. Errors are typed classes in `src/lib/errors.ts` that extend `OseroError` and carry a literal `code` (for example `ValidationError`, `ConfigurationError`, `UnsupportedChainError`, `AccountMismatchError`, `ChainMismatchError`, `UnsupportedCapabilityError`, `InsufficientAllowanceError`, `QuoteExpiredError`, `SimulationError`, `SigningError`, `BroadcastError`, `ConfirmationError`, `TransactionError`, `CancelError`, `RpcError`, the `Api*Error` classes, `TimeoutError`, `UnexpectedError`) and returned via `neverthrow`. Execution errors carry an `execution` context with the stage, the hash when one exists, and the confirmed prefix. The exported error unions and `OseroErrorCode` are frozen public API: reuse an existing class rather than adding a member. `UnexpectedError` is for genuine defects only. Re-exports of `Result`/`ResultAsync` come from `src/lib/result.ts` — import from there, not directly from `neverthrow`, so the dependency stays swappable.

### Telemetry

`src/lib/telemetry.ts` reports a curated subset of returned errors to Osero's Sentry project (opt-out, on by default). Rules: errors are observed only where they leave a public entry point via `observeResult(result, { operation, ... })` — never inside internal loops or retries; the report/ignore policy lives in `classifyForTelemetry` and is documented in `docs/osero-sdk/telemetry.md`; the Sentry client is a private `@sentry/core` instance loaded lazily, never `Sentry.init`; API keys, headers, addresses, and amounts must never be attached. Hosted API requests to `*.osero.org` carry a `sentry-trace` header from `startTelemetryTrace()`. Telemetry is off under `NODE_ENV=test`, so tests that exercise it call `_configureTelemetryForTesting`. `src/lib/version.ts` must match `package.json`; `pnpm version-packages` syncs it and `version.test.ts` enforces it.

### Chain/token/API registries

`src/lib/capabilities.ts` (`SUPPORTED_CHAIN_IDS`, `CHAIN_CAPABILITIES`) is the single source of truth for local action builders: chain metadata, token addresses, protocol addresses, the SSR source, and the supported route matrix all live in one `ChainCapability` entry per chain. `src/lib/chains.ts`, `src/lib/tokens.ts`, and `src/lib/addresses.ts` (`PSM_ADDRESSES`) are derived views of it, so a new local PSM chain is added in `capabilities.ts` only (with a `litePsm` address if it is mainnet-style). The route flow switches on `protocol` (`'ethereum-lite-psm'` or `'psm3'`), which is semantic rather than geographic. `CHAIN_CAPABILITIES` itself is internal and not exported from any entrypoint; `listSwapRoutes(chainId)` in `src/lib/routes.ts` is its narrow public view.

Hosted API vocabulary is different: the client ships **no gate**. The `OSERO_API_KNOWN_*` exports in `src/lib/api.ts` are advisory snapshots that only power editor autocomplete and offline UI hints — refresh them when the hosted API's vocabulary changes, but never validate a request or response against them. Decoders must stay structural (wire grammar and execution safety only); do not add membership checks or registry cross-checks. Adding hosted assets is an API-repo change (the SDK optionally refreshes the `KNOWN_*` rows for autocomplete). The local action registries above stay strict — they gate local plan building.

## Code style

- Strict TypeScript (v7, native compiler), ESM, **`.js` extensions on local imports** (these files are `.ts` but resolved post-build).
- Formatting enforced by `.oxfmtrc.json` (2-space, single quotes, semis, trailing commas, 100-col, sorted imports). Lint via oxlint (`.oxlintrc.json`).
- `PascalCase` types/classes, `camelCase` values. Test helpers live in `_testing.ts` files which are excluded from the published package.
- Tests colocated as `*.test.ts`. Action tests belong next to the action and should cover both validation failures and the resulting `ExecutionPlan` shape (not just the final tx hash).

## Package exports

`@osero/client` ships eight subpath exports: `.` (types, client, registries, plans, errors), `./actions`, `./api`, `./contracts`, `./viem`, `./eip5792`, `./ethers`, `./privy`. Everything exported from them is frozen public API: additions must be optional and additive, and `pnpm api:report:check` gates the emitted declarations. The `package.json` `exports` map has an `osero-sdk` condition pointing at raw `.ts` source for in-repo consumers (examples), and `import`/`default` for the built `./dist/*.js` for published consumers. Keep those in sync when adding a new entrypoint.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `osero-io/kit`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
