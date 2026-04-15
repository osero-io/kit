# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm/Nx TypeScript workspace. The SDK lives in `packages/client`, with public entrypoints in `src/index.ts`, `src/viem.ts`, and `src/ethers.ts`. Core logic is under `packages/client/src/lib`, action builders are in `src/lib/actions`, and contract ABIs are in `src/lib/abis`. Tests are colocated with implementation as `*.test.ts`. Runnable examples live in `examples/src`, split by adapter (`viem`, `ethers`) plus shared helpers in `examples/src/shared`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies.
- `pnpm nx build @osero/client`: compile the SDK with TypeScript project references.
- `pnpm nx typecheck @osero/client`: run declaration-only type checking for the client.
- `pnpm nx test @osero/client`: run the Vitest suite for the client package.
- `pnpm lint` / `pnpm lint:fix`: run oxlint across workspace sources, optionally fixing issues.
- `pnpm format:check` / `pnpm format`: check or apply oxfmt formatting.
- `pnpm --filter @osero/examples dry-run:inspect-plan`: run the safest example; it builds a plan without broadcasting.

## Coding Style & Naming Conventions

Use strict TypeScript with ESM imports and explicit `.js` extensions for local runtime imports, matching existing files. Formatting is controlled by `.oxfmtrc.json`: 2-space indentation, single quotes, semicolons, trailing commas, LF endings, sorted imports, and a 100-column print width. Prefer typed errors and `neverthrow` results over throwing in action paths. Use `PascalCase` for classes/types, `camelCase` for functions and values, and keep test helpers in `_testing.ts`.

## Testing Guidelines

Vitest is configured in `packages/client/vitest.config.mts` with Node environment and globals enabled. Add focused tests next to the code under test using `*.test.ts` or `*.spec.ts`; action tests belong beside the action in `src/lib/actions`. For changes touching transaction planning, cover validation failures and the resulting `ExecutionPlan` shape. Coverage uses V8 and writes to `packages/client/test-output/vitest/coverage`.

## Commit & Pull Request Guidelines

This checkout has no existing commit history, so there is no repository-specific commit convention to preserve. Use concise, imperative commit subjects such as `Add Base redeem plan tests`. Pull requests should describe behavior changes, list the validation commands run, link related issues, and include screenshots or terminal output only when they clarify user-visible examples or failures.

## Security & Configuration Tips

Examples can broadcast real transactions. Keep secrets in `examples/.env`, never commit private keys, and use disposable wallets with small balances. Prefer explicit RPC URLs for production-like testing instead of relying on public defaults.
