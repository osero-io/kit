# SDK v1 release findings

## Purpose

This document combines two independent audits of `@osero/client`, validates the supplied audit
against the current source, removes overlaps, and turns the surviving findings into implementation
instructions. It is a release-planning document, not a completed-change log.

The pending major changeset and `upgrading-0-to-1.md` already cover the hosted API's move to
API-authoritative, forward-compatible asset vocabulary. Keep that behavior. The highest-risk work
still available before the v1 compatibility boundary is in transaction safety, execution recovery,
error semantics, and the exported API surface.

## Validation baseline

Validated on 2026-07-13 against the current workspace.

Commands and probes used:

- `pnpm nx run-many -t format:check lint build typecheck test --skipNxCache`
- `pnpm nx test @osero/client --coverage --skipNxCache`
- `pnpm pack --dry-run --json` from `packages/client`
- direct runtime probes for invalid slippage, invalid addresses, unknown balance symbols, ignored
  referral values, and a disconnected viem wallet
- LSP reference checks for `ClientConfig.confirmations`, `InsufficientBalanceError`,
  `ResolvedClientConfig`, and `_setPublicClientForTesting`
- built-entrypoint import checks for `.`, `/actions`, `/api`, `/viem`, `/ethers`, and `/privy`

Current baseline:

- all Nx build, typecheck, lint, format, and test targets passed;
- 17 client test files and 268 tests passed;
- reported V8 coverage was 90.79% statements, 86.13% branches, 91.70% functions, and 91.12%
  lines;
- the coverage total is incomplete because unimported production files are omitted; notably,
  `ethers.ts` had no test file and did not appear in the report;
- no source implementation was changed as part of the audit.

## Implementation rules

Every agent implementing an item in this document must follow these rules:

1. Re-read the named source and tests before editing. These findings describe the current snapshot;
   they are not substitutes for source inspection.
2. Preserve the hosted API's forward-compatible vocabulary. Do not reintroduce local allowlists for
   assets, chains, bridge protocols, directions, kinds, or provider states.
3. Treat transaction safety separately from vocabulary flexibility. Unknown labels may pass through;
   signer, amount, approval, chain, and calldata invariants still require strict checks.
4. Do not silently add network calls, unlimited approvals, retries, chain switching, or transaction
   batching. Each changes observable behavior and needs an explicit API decision.
5. Do not copy stale generated files from `dist`. Implement from current source, current ABIs, and
   verified protocol behavior.
6. Keep exact API wire semantics. In particular, do not accept `bigint` in a JSON body without an
   explicit serializer, and do not reduce decimal slippage precision without confirming the hosted
   API contract.
7. Every behavioral change requires tests for success, validation failure, and the real error path.
8. Run the packed-tarball checks, not only source-level tests, before declaring release work done.

## Priority summary

| ID  | Priority                      | Finding                                                              |
| --- | ----------------------------- | -------------------------------------------------------------------- |
| F01 | Blocker                       | Enforce the promised non-throwing operational Result contract        |
| F02 | Blocker                       | Bind plans to the executing account and preflight the whole plan     |
| F03 | Blocker                       | Harden hosted quote transaction and approval integrity               |
| F04 | Blocker / breaking            | Preserve per-step hashes, receipts, progress, and recovery state     |
| F05 | Blocker / breaking            | Make errors discriminated, contextual, and truthful                  |
| F06 | Breaking window               | Shrink and clarify the public API surface                            |
| F07 | Breaking window               | Remove dead configuration and make client policies explicit          |
| F08 | High-value feature            | Make approvals allowance-aware with an explicit policy               |
| F09 | High-value feature            | Complete local routes and add exact-output preparation               |
| F10 | High-value feature / breaking | Return one rich prepared quote and preserve gas metadata             |
| F11 | Breaking window               | Unify amount, slippage, referral, and chain vocabulary safely        |
| F12 | Product decision / breaking   | Make referral attribution explicit and route-correct                 |
| F13 | High-value feature            | Add cancellable cross-chain completion polling                       |
| F14 | High-value feature            | Add honest simulation and fee estimation                             |
| F15 | Architectural feature         | Model executor capabilities for batches, permits, and smart accounts |
| F16 | Correctness                   | Define adapter gas, confirmation, and error behavior explicitly      |
| F17 | Maintainability / breaking    | Consolidate chain capabilities and qualify dependency-floor changes  |
| F18 | Correctness / performance     | Harden balance reads and optionally use multicall                    |
| F19 | Correctness                   | Improve APY numerical precision                                      |
| F20 | Release blocker               | Fix license, clean-build, tarball, and publication gating            |
| F21 | Release blocker               | Add adapter, fork, package-consumer, and full-source coverage gates  |

## Detailed findings

## F01 — Enforce the non-throwing operational Result contract

### Current behavior

Public action and read methods advertise `Result`/`ResultAsync`, but expected input failures can
escape as synchronous exceptions or rejected promises.

Validated cases:

- None of the four action entrypoints validates `slippageBps` before calling `applySlippage`.
  `applySlippage` throws `RangeError`; calls made inside neverthrow `.map()`/`.andThen()` callbacks
  are not caught automatically. A direct probe with `slippageBps: -1` threw instead of returning
  `Err(ValidationError)`.
- ABI encoding can throw viem `InvalidAddressError` for an invalid receiver.
- An invalid sender paired with a valid explicit receiver can produce an `Ok` plan containing an
  invalid `TransactionRequest.from`, because `from` is only TypeScript-typed and is not always ABI
  encoded.
- `getTokenBalance` treats every non-`0x` runtime string as `TokenSymbol`. Passing `DAI` reaches
  `getToken(chainId, token as TokenSymbol).address` and throws `TypeError`.
- `mintUsds`, `redeemUsds`, and `redeemSUsds` validate referral codes before taking branches where
  the option is documented as ignored. A negative mainnet referral therefore returns an error for
  a supposedly ignored field.
- The viem `sendWith` factory throws a plain `Error` when account or chain is missing, unlike the
  Result-based setup failures in the other adapters.

Relevant source:

- `packages/client/src/lib/math.ts` — `applySlippage`
- `packages/client/src/lib/actions/{mintUsds,mintSUsds,redeemUsds,redeemSUsds}.ts`
- `packages/client/src/lib/balances.ts` — `resolveTokenAddress`
- `packages/client/src/viem.ts` — `hasConnectedAccount` and `sendWith`

### Required change

Establish and document one boundary:

- synchronous construction/configuration may reject invalid configuration with a documented typed
  error;
- after successful construction, every public operation returning `Result` or `ResultAsync` must
  keep all expected failures in that result.

Add shared runtime validation for:

- sender, receiver, account, token, spender, and transaction target addresses;
- positive and uint-bounded amounts;
- integer slippage in the supported range;
- referral representation and route-specific bounds;
- positive integer confirmation counts;
- supported local chain IDs and runtime token symbols;
- hex calldata and non-negative transaction values where plans can enter from external callers.

Run deterministic validation before any RPC call. Avoid broad `try/catch` around whole actions when a
specific validator can prevent the throw and return a precise field error.

For fields that do not apply to a route, choose one behavior and make types, docs, and runtime agree:

- omit them from a route-specific request type;
- reject them explicitly as unsupported;
- or truly ignore them without validating them.

### Required tests

- every action with negative, fractional, `NaN`, and over-maximum slippage;
- invalid sender and receiver with both default and explicit receiver paths;
- unknown runtime token symbol and malformed token address;
- invalid balance account;
- mainnet requests carrying fields documented as ignored;
- disconnected viem wallet returns the chosen typed failure without throwing;
- assert no RPC, gas estimate, signature, or broadcast occurs after validation failure.

### Do not

- rely on `Address` or `TokenSymbol` TypeScript annotations as runtime validation;
- turn all errors into `UnexpectedError`;
- change `applySlippage` alone and leave other synchronous ABI-encoding failures exposed.

## F02 — Bind plans to the executing account and preflight the entire plan

### Current behavior

`TransactionRequest` contains `from`, but the viem adapter uses `walletClient.account` for gas
estimation and sending without comparing it to `request.from`. A plan prepared for account A can be
executed by wallet B. If the plan's calldata sends output to A, B can supply the input tokens while A
receives the output.

Privy explicitly validates wallet address versus `request.from`. Ethers supplies `from` to
`signer.sendTransaction`, but relies on ethers to reject a mismatch and reports it as a generic
signing failure.

Adapters validate requirements one transaction at a time. A malformed multi-step plan could
broadcast early transactions before a deterministic account or chain problem is discovered on a
later step.

Relevant source:

- `packages/client/src/lib/types.ts` — `TransactionRequest`
- `packages/client/src/viem.ts` — `ensureChain`, `sendSingleTransaction`
- `packages/client/src/ethers.ts` — `ensureChain`, `sendSingleTransaction`
- `packages/client/src/privy.ts` — `ensureWalletMatchesRequest`

### Required change

Before broadcasting transaction 1, flatten and preflight every transaction:

- validate all transaction fields;
- compare every `from` with the connected account using address-aware equality;
- establish the executor's current chain and compare every step;
- reject mixed-account plans;
- reject mixed-chain plans unless the plan and executor explicitly model a supported chain
  transition;
- validate all deterministic executor options, including confirmations and Privy idempotency-key
  count/content.

Introduce specific account/chain/configuration errors. Do not classify a caller-supplied mismatched
wallet as an unexpected internal error or a signing failure.

### Required tests

For viem, ethers, and Privy:

- account match and mismatch;
- checksum/case-equivalent addresses;
- chain match and mismatch;
- malformed second or later step causes zero broadcasts;
- mixed-account and mixed-chain custom plans cause zero broadcasts;
- direct and curried `sendWith` forms have identical preflight behavior.

### Do not

- silently replace `TransactionRequest.from` with the wallet account;
- automatically switch chains without an explicit executor capability and caller opt-in;
- validate only the first transaction.

## F03 — Harden hosted quote transaction and approval integrity

### Current behavior

The hosted API decoder intentionally accepts unknown vocabulary, which is correct. Its transaction
safety checks are too weak, however.

`assertSwapQuoteInvariants` checks that:

- the approval transaction targets the advertised token;
- native value is zero;
- approval and execution share a sender;
- source-chain metadata is internally consistent.

It does not verify that approval calldata is ERC-20 `approve(spender, amount)`. Arbitrary token
calldata, including an ERC-20 transfer selector, can satisfy the current invariants and be placed in
`executionPlan`. `getSwapQuote` also does not bind the decoded execution sender or amount back to the
request's `fromAddress` and amount.

Relevant source:

- `packages/client/src/lib/api.ts` — `decodeSwapQuoteResponse`,
  `assertSwapQuoteInvariants`, `swapQuoteToExecutionPlan`

### Required change

Treat API transaction data as untrusted executable input:

1. Prefer rebuilding the approval transaction locally from validated token, spender, and amount.
2. If nonstandard authorization must be supported, add a discriminated authorization kind and a
   validator for each supported kind. Do not accept opaque token calldata under an `approval` label.
3. Bind the decoded quote to the request at minimum:
   - transaction sender equals requested `fromAddress`;
   - `amountIn.raw` equals the normalized requested amount;
   - approval token/source chain and execution source chain agree;
   - approval metadata and locally decoded/generated calldata agree.
4. Confirm the hosted API's canonicalization rules before enforcing input/output asset equality.
   Address locators may legitimately return canonical asset IDs. Do not guess those rules.
5. Preserve forward-compatible display vocabulary and bridge/provider states.

### Required tests

Fixtures that otherwise decode structurally but contain:

- ERC-20 `transfer` instead of `approve`;
- correct approve selector with wrong spender;
- correct spender with wrong amount;
- execution sender different from request sender;
- quote input amount different from request amount;
- wrong approval token target;
- nonzero native value;
- known-safe quote with an unknown asset, chain, route label, or bridge protocol.

### Do not

- reintroduce a static asset or route allowlist;
- trust display metadata without checking executable data;
- assume an arbitrary execution target can be allowlisted without an explicit hosted API contract.

## F04 — Preserve per-step hashes, receipts, progress, and recovery state

### Current behavior

`TransactionResult` returns only the final hash and a separate operation array. A mainnet sUSDS mint
can broadcast four transactions, but callers cannot retrieve the first three hashes from the result.

If a later transaction fails, the error does not include completed transactions. If broadcast
succeeds but receipt polling fails, viem, ethers, and Privy lose the submitted hash when converting
the wait failure to `UnexpectedError`. Ethers transaction replacement is also not represented.

Relevant source:

- `packages/client/src/lib/types.ts` — `TransactionResult`
- `packages/client/src/lib/adapters.ts` — `runExecutionPlan`
- `packages/client/src/{viem,ethers,privy}.ts` — receipt waits

### Required change

Use the breaking window to define a versioned, recovery-capable execution contract. At minimum:

- return every submitted transaction with step ID, operation, hash, and receipt/confirmation result;
- retain a final-hash convenience field only if useful;
- include completed steps and the current hash in execution failures;
- separate signing, broadcast, confirmation, replacement, and revert stages;
- expose progress through a callback or async event stream;
- give steps stable IDs so Privy idempotency and resumption do not depend only on array positions;
- provide canonical plan serialization/deserialization if plans are expected to cross queues or
  process boundaries;
- support resuming after confirmed steps without replaying them.

A flat plan is easier to execute and recover than the current recursive union. A suitable direction
is one top-level plan with ordered steps, where an approval is a labeled step rather than a nested
`Erc20ApprovalRequired` wrapper. Final shape is a public API decision and must be settled before
implementation begins.

### Required tests

- success returns all hashes in exact execution order;
- failure on step N includes all completed steps and no later steps;
- receipt timeout preserves the broadcast hash;
- cancellation on a later wallet prompt preserves earlier confirmed transactions;
- ethers replacement records the effective hash and receipt;
- serialization round-trip preserves bigint and hex values exactly;
- resume skips only steps proven complete.

### Do not

- automatically retry a transaction after an ambiguous broadcast or receipt timeout;
- infer completion solely from a previous local callback;
- discard the existing final hash without a migration path in the v1 guide.

## F05 — Make errors discriminated, contextual, and truthful

### Current behavior

Each error constructor assigns `this.name`, but the inherited property remains typed as `string`.
LSP confirms `Error.name: string`, so switching on `error.name` does not narrow the union.

`ValidationError` documents a `field` property that does not exist. Field data is nested in a generic
`context`, and all current production field errors use `{ field }`.

`UnexpectedError` currently groups unrelated failures such as wrong chain, detached signer, RPC
reads, malformed API responses, receipt waits, missing fetch, and unsupported Privy receipt chains.
The viem gas-estimation path maps RPC/simulation failure to `SigningError` even though no signing has
occurred.

`InsufficientBalanceError` and aggregate `ActionError` are exported and documented, but no
production path constructs `InsufficientBalanceError`; references are limited to exports, types, and
tests.

Relevant source:

- `packages/client/src/lib/errors.ts`
- `packages/client/src/lib/types.ts` — `ActionError`, `SendWithError`
- `packages/client/src/viem.ts` — `estimateGas`

### Required change

Give every public error a literal discriminant. A literal `name` is the minimum change; a stable
literal `code` or `kind` is better for cross-realm and serialized handling. Add contextual fields
needed for recovery, for example:

- validation field and optional details;
- account and expected account;
- actual and expected chain;
- chain, contract, function, and RPC operation;
- plan ID, step ID/index, operation, hash, and completed transactions;
- API URL, method, status, correlation ID, headers, and retry metadata;
- explicit aborted/cancelled state.

Reserve `UnexpectedError` for genuinely unclassified defects. Classify gas estimation as simulation
or RPC failure, not signing failure.

Decide `InsufficientBalanceError` explicitly:

- implement deliberate balance preflight and produce it; or
- remove it and `ActionError` until a real producer exists.

Do not add unconditional balance reads solely to justify the existing exported class; that would add
latency and race-prone behavior without an approved product decision.

### Required tests

- compile-time narrowing on the chosen discriminant;
- `ValidationError.field` and richer context behavior;
- cancellation versus signing failure versus simulation/RPC failure;
- API abort versus network failure versus malformed response;
- error serialization if codes are intended for server boundaries;
- every exported error has at least one real producer, or is explicitly documented as a constructor
  for custom executors.

## F06 — Shrink and clarify the public API surface

### Current behavior

The root entrypoint exports low-level helpers marked `@internal`, including plan constructors and
plan type guards. It also exports resolved configuration, referral internals, broad neverthrow
helpers, contract registries, math helpers, and the hosted API that already has an `/api` subpath.

`OseroClient._setPublicClientForTesting` is emitted in the public class declaration. Root
`listChains()` and `getChain()` are duplicated by asynchronous `/actions` wrappers whose client
parameter is unused; the action `chain()` returns `Ok(null)` for an unknown chain, adding a third
error convention.

Relevant source:

- `packages/client/src/index.ts`
- `packages/client/src/lib/plan.ts`
- `packages/client/src/lib/adapters.ts`
- `packages/client/src/lib/OseroClient.ts`
- `packages/client/src/lib/actions/chains.ts`
- emitted declarations under `packages/client/dist`

### Required change

Define the intended v1 entrypoints before deleting anything. A defensible split is:

- root: client creation, stable domain types/errors, chain/token discovery, and deliberate read
  helpers;
- `/actions`: public action/preparation APIs;
- `/api`: hosted API only;
- `/viem`, `/ethers`, `/privy`: executor-specific APIs;
- optional `/contracts`: raw ABIs and addresses if direct contract use is intentionally supported.

Then:

- unexport internal plan constructors/guards or intentionally make them public and remove the
  contradictory `@internal` tags;
- remove the asynchronous chain action wrappers unless they gain real remote behavior;
- hide resolved configuration types unless consumers need them;
- replace `_setPublicClientForTesting` with an intentional client/public-client factory injection
  seam, or keep the hook entirely outside emitted production declarations;
- decide whether neverthrow is a deliberate v1 dependency contract; do not accidentally freeze its
  entire helper surface;
- add an API-report or declaration snapshot to catch accidental exports.

Do not enable `stripInternal` blindly while public entrypoints still export `@internal` declarations;
that can produce broken or incomplete public declarations.

### Required tests

- typecheck every documented import path from a packed consumer project;
- assert removed symbols cannot be imported from public subpaths;
- verify custom executor construction remains possible if it is a supported use case;
- test the replacement public-client injection path without a testing-only public method.

## F07 — Remove dead configuration and make client policies explicit

### Current behavior

`ClientConfig.confirmations` is resolved and documented as the adapter confirmation default, but no
adapter reads it. Adapters independently use `options?.confirmations ?? 1`. LSP references to the
resolved field occur only in configuration and tests.

`defaultSlippageBps` is not validated during client construction. `OseroClient.create()` silently
falls back to public viem transports even though the README warns that those transports are
unreliable in production.

`OseroApiClientConfig.apiKey` is mandatory even though every request supports an API-key override,
which is awkward for multi-tenant servers. The custom fetch response type also omits response
headers needed for retry and request metadata.

Relevant source:

- `packages/client/src/lib/config.ts`
- `packages/client/src/lib/OseroClient.ts`
- `packages/client/src/{viem,ethers,privy}.ts` — `SendWithOptions`
- `packages/client/src/lib/api.ts` — API client configuration and fetch abstraction

### Required change

- Remove `ClientConfig.confirmations` and keep execution options on executors, unless a separate
  approved redesign binds every executor to `OseroClient`.
- Validate client defaults at construction.
- Decide whether public RPC fallback is a supported production policy. Prefer an explicit
  `allowPublicRpc` opt-in or a typed missing-transport error if production safety is the goal.
- Allow an API client with no default key when a request key or key provider will always supply one.
- Consider a synchronous/async key provider for multi-tenant systems.
- Make custom fetch injection compatible with the standard fetch contract where practical and retain
  response headers in HTTP errors.
- Define and test the supported Node/browser runtime matrix.

### Do not

- silently start using `OseroClient.confirmations` in only one adapter;
- require the wallet transport and read transport to be the same;
- add automatic API retries without method-specific idempotency rules.

## F08 — Make approvals allowance-aware with an explicit policy

### Current behavior

All local and hosted execution plans unconditionally include an approval transaction. The ERC-20 ABI
already includes `allowance`, but production action code never reads it. Repeat users therefore pay
for an approval even when existing allowance is sufficient.

Relevant source:

- `packages/client/src/lib/abis/erc20.ts`
- `packages/client/src/lib/plan.ts`
- all four files under `packages/client/src/lib/actions`
- `packages/client/src/lib/api.ts` — hosted quote plan conversion

### Required change

Add an explicit approval policy to preparation, with exact approval as the safest default:

- `exact`: approve only the required amount when allowance is insufficient;
- `max`: caller explicitly opts into persistent maximum allowance;
- `none`: never add approval; return a typed insufficient-allowance result;
- future permit/authorization mode only after verifying token and wallet support.

Read allowance during plan preparation when the policy requires it. Record the allowance snapshot,
decision, token, spender, and required amount in quote/plan metadata. Recheck deterministic plan
integrity before execution; allowance remains race-prone and the final transaction can still revert.

For hosted quotes, combine this with F03: never skip or execute API-provided authorization without
validating its semantics.

### Required tests

- zero, insufficient, exact, and excess allowance;
- exact and explicit max policy;
- no-approval policy failure;
- multiple approvals and mainnet intermediate-token approval;
- allowance changes after preparation;
- hosted quote whose allowance already covers the amount.

### Do not

- default to unlimited approval;
- claim allowance preflight guarantees execution;
- use a cached allowance without recording when/how it was obtained.

## F09 — Complete local routes and add exact-output preparation

### Current behavior

The local SDK exposes only exact-input:

- USDC to USDS;
- USDC to sUSDS;
- USDS to USDC;
- sUSDS to USDC.

Users cannot directly prepare USDS to sUSDS or sUSDS to USDS, despite those operations already
appearing as embedded mainnet steps. The current ABIs support more:

- PSM3 exposes `swapExactOut` and `previewSwapExactOut`;
- ERC-4626 exposes `mint`, `withdraw`, `previewMint`, and `previewWithdraw`.

A stale `dist/lib/actions/depositSUsds.*` artifact exists, but no matching current source/export does.
It is evidence of a dirty build, not an implementation specification.

Relevant source:

- `packages/client/src/lib/actions/index.ts`
- `packages/client/src/lib/abis/psm3.ts`
- `packages/client/src/lib/abis/erc4626.ts`
- `packages/client/src/lib/types.ts` — existing deposit/redeem operation tags

### Required change

Design a complete route/capability matrix for each supported chain and add:

- direct USDS to sUSDS;
- direct sUSDS to USDS;
- exact-output variants where the deployed protocol supports them;
- clear max-input/min-output semantics.

Choose one deliberate public shape:

- explicit pair-named functions; or
- a typed `prepareSwap` with `assetIn`, `assetOut`, and `exactIn`/`exactOut` mode.

Do not implement a generic route dispatcher until every supported pair and chain has verified
contract behavior, decimals, approval requirements, and quote math.

### Required tests

- route matrix for all five local chains;
- direct mainnet ERC-4626 deposit/redeem/mint/withdraw behavior;
- L2 PSM3 exact-in and exact-out calldata;
- rounding direction for exact-output maximum input;
- slippage bounds and referral support per route;
- plan shape with and without approval.

### Do not

- copy the stale generated `depositSUsds` file;
- assume PSM3 liquidity/support for a pair solely because its ABI is generic;
- reuse exact-input rounding for exact-output paths.

## F10 — Return one rich prepared quote and preserve gas metadata

### Current behavior

Local preview helpers return only a raw output `bigint`. A caller commonly previews and then calls the
action, which reads state again; the displayed quote may not be the quote used to encode the plan.
Local plans do not expose expected output, minimum output, fee inputs, quote block, or route summary.

Hosted responses contain `quote.gas` and `approval.gas`, but `swapQuoteToExecutionPlan` drops both.
Adding those values directly as an authoritative transaction gas limit would be unsafe: they are
remote estimates and may be stale.

Relevant source:

- action preview and build functions under `packages/client/src/lib/actions`
- `packages/client/src/lib/api.ts` — `OseroApiSwapQuoteInfo`, `OseroApiSwapApproval`,
  `swapQuoteToExecutionPlan`
- `packages/client/src/lib/types.ts` — `TransactionRequest`

### Required change

Return one prepared object that ties user-visible quote data to the exact plan:

- input and output assets/amounts;
- expected output;
- minimum output or maximum input;
- slippage representation;
- protocol fee inputs;
- route and source/destination chain;
- quote timestamp/block when available;
- plan;
- advisory per-step gas estimates with provenance.

Name remote values `estimatedGas` or equivalent. Keep estimate metadata distinct from an explicitly
chosen transaction gas limit. Executors may use a trusted estimate only under a documented policy
with appropriate buffering or fresh simulation.

### Required tests

- quote metadata exactly matches encoded min/max calldata;
- preparing once does not perform a hidden second quote read;
- hosted decimal gas strings decode to bigint metadata without becoming an automatic gas limit;
- absent gas remains absent;
- stale/too-low remote estimates do not bypass executor safety policy.

### Do not

- let an API gas estimate silently disable local wallet/provider estimation;
- add a single ambiguous `gas` field that means both estimate and hard limit;
- claim a quote is current without block/timestamp evidence.

## F11 — Unify amount, slippage, referral, and chain vocabulary safely

### Current behavior

Local and hosted APIs expose different representations:

- local `amount: bigint` has implicit token units determined by the action name;
- hosted amount accepts bigint or decimal integer string;
- local slippage is integer basis points as `number`;
- hosted slippage is a decimal string passed through to API policy, with tests accepting values such
  as `7.123`;
- local referral code is `bigint` for ABI encoding;
- hosted referral code is JSON `number`;
- local action chain IDs are `number` despite a known `OseroChainId` union.

The mismatch is real. The supplied proposal to accept `bigint | number` for hosted referral and
replace hosted slippage with integer `slippageBps` is not safe without a serializer and API contract
change.

### Required change

Define domain values and explicit boundary serializers:

- token-aware `amountIn`/`amountOut`, a branded raw amount, or `TokenAmount<Symbol>`;
- a slippage value that preserves the hosted API's required decimal precision and serializes to the
  exact current wire format;
- one validated referral domain type with separate ABI and JSON serializers;
- `OseroChainId` for local-only routes, while retaining widened positive chain IDs for the
  forward-compatible hosted API.

If changing the hosted request wire format, confirm the server contract and update server/client
fixtures together. Otherwise keep the existing wire format and improve only the SDK-facing domain
representation.

### Required tests

- token-decimal mismatch prevention at compile time where possible;
- exact decimal slippage serialization, including fractional basis-point-equivalent values;
- bigint referral conversion rejects values unsafe for the JSON/API representation;
- local versus hosted chain type behavior;
- migration examples for every changed request field.

### Do not

- pass bigint directly to `JSON.stringify`;
- collapse exact decimal slippage to integer bps without product/API approval;
- use `bigint | number | string` as an unvalidated convenience union.

## F12 — Make referral attribution explicit and route-correct

### Current behavior

The local client silently applies `DEFAULT_REFERRAL_CODE = 3000n` when callers omit a code. Mainnet
sUSDS referral is bounded by its ABI, L2 PSM3 accepts a wider integer, and hosted referral is a JSON
number governed by server policy. Some action docs call referral ignored on mainnet while validation
still runs before the route branch.

Relevant source:

- `packages/client/src/lib/referrals.ts`
- `packages/client/src/lib/config.ts`
- all four local action request types/entrypoints
- hosted API request encoding in `packages/client/src/lib/api.ts`

### Required change

Make a product decision before coding:

- preferred safety/clarity: no attribution unless explicitly configured;
- if Osero attribution by default is required, expose it prominently in client configuration and
  migration docs rather than relying on optional-property presence.

Use an explicit opt-out/opt-in representation such as `referral: false` versus
`referral: { code }`. Define route capabilities and bounds, and ensure inapplicable fields are absent,
rejected, or truly ignored consistently.

### Required tests

- omitted, configured, per-request override, and explicit opt-out;
- route-specific bounds;
- mainnet routes where referral is unsupported;
- hosted JSON serialization and server-policy errors;
- migration behavior from the current implicit 3000 default.

## F13 — Add cancellable cross-chain completion polling

### Current behavior

`getSwapStatusForQuote` performs one status request. The execution example tells users to call it
after source execution but leaves polling, timeout, cancellation, and terminal-state handling to
every application.

Relevant source:

- `packages/client/src/lib/api.ts` — `getSwapStatus`, `getSwapStatusForQuote`
- `examples/src/api/execute-quote-viem.ts`

### Required change

Add a helper such as `waitForSwapCompletion` that:

- accepts quote/status request plus source transaction hash;
- accepts `AbortSignal`, timeout, and polling interval;
- emits status transitions through a callback or async iterator;
- stops on completed, failed, timeout, or abort;
- returns source and destination hashes and the final provider state;
- preserves unknown future provider statuses without crashing;
- can resume after process restart from persisted request data.

A higher-level `executeQuote` may compose source-plan execution with this waiter after F04 defines a
reliable source hash/result contract.

### Required tests

Use fake timers and deterministic fetch fixtures for:

- pending to inflight to completed;
- provider failure;
- timeout;
- abort during sleep and during request;
- unknown nonterminal provider status;
- same-chain quote rejection without HTTP polling.

### Do not

- poll forever by default;
- retry arbitrary HTTP failures without a documented policy;
- treat source confirmation as destination completion.

## F14 — Add honest simulation and fee estimation

### Current behavior

The dry-run example inspects plans and performs quote reads. It does not simulate complete execution
or return balance, allowance, revert, and fee information. Viem estimates each transaction only at
send time; ethers delegates population/estimation behavior to the signer/provider; Privy delegates
to its wallet API.

### Required change

Provide a non-broadcasting preparation/simulation result with:

- validated account and chain;
- allowance and balance observations;
- per-step estimate and estimated native fee;
- revert reason and failing step when available;
- quote/minimum-output metadata;
- simulation block and transport/provider provenance.

Multi-step plans require special care because later steps depend on earlier state. Full-plan
simulation is valid only if using state overrides, a fork, a bundler simulation, or another verified
mechanism. Otherwise report exactly which steps were independently simulated and which remain
conditional.

### Required tests

- single-step and approval-plus-action simulation;
- later-step dependency disclosure;
- revert reason mapping;
- fee calculation with explicit fee data;
- no signing or broadcast;
- unsupported simulation capability returns a typed result.

### Do not

- label independent per-step estimates as an end-to-end simulation;
- add balance preflight to every action without making latency and race semantics explicit;
- use one adapter's gas behavior as the universal policy.

## F15 — Model executor capabilities for batches, permits, and smart accounts

### Current behavior

Execution assumes sequential normal transactions with one hash and receipt each. The plan can be
flattened for custom execution, but no public capability contract lets preparation choose batching,
permit authorization, sponsored/user-operation execution, or chain transition.

Privy explicitly rejects sponsored transactions when the API returns no standard transaction hash.
It also rejects hosted quote chains absent from the local chain registry because it cannot construct
a receipt client.

### Required change

Define executor capabilities separately from plan semantics, for example:

- sequential transaction support;
- atomic/multi-call batching;
- permit or typed-signature authorization;
- sponsored/user-operation submission and receipt tracking;
- supported chains and chain-switch behavior;
- simulation and gas-estimation support.

Use capabilities to choose or reject an execution strategy before broadcasting. Extend Privy only
after verifying its sponsored transaction receipt/user-operation API; do not invent a hash mapping.
Allow caller-supplied chain metadata/receipt clients if forward-compatible hosted chains are intended
to work before the local registry is updated.

### Required tests

- capability negotiation happens before any send;
- unsupported sponsored/batch mode returns a specific error;
- batch result still maps each semantic step;
- unknown hosted chain works only with sufficient caller-supplied metadata;
- existing sequential adapters remain behaviorally stable.

## F16 — Define adapter gas, confirmation, and error behavior explicitly

### Current behavior

- viem explicitly estimates gas, adds 15%, and maps estimation failure to `SigningError`;
- ethers does not explicitly estimate or buffer inside the SDK, but `Signer.sendTransaction` may
  populate/estimate through ethers, so saying ethers performs no estimation at all is too strong;
- Privy delegates gas selection to its Wallet API;
- all three adapters duplicate a `confirmations?: number` field, while Privy has additional options;
- confirmation values are not centrally validated.

Relevant source:

- `packages/client/src/{viem,ethers,privy}.ts`

### Required change

Document a shared behavioral contract, not necessarily an identical implementation:

- what constitutes estimation versus signing versus broadcast;
- whether and how gas buffers are applied;
- how an advisory plan/API estimate is used;
- valid confirmation values and default;
- receipt timeout and replacement behavior;
- which error kind each stage produces.

A small shared `ConfirmationOptions` type is reasonable if it remains meaningful across adapters.
Do not create a broad shared options abstraction solely to eliminate one repeated field.

### Required tests

Run the same contract suite against all adapters for:

- invalid confirmation values;
- account/chain preflight;
- estimation/simulation failure;
- cancellation;
- broadcast failure;
- receipt timeout, revert, and replacement where supported;
- direct and curried calls.

## F17 — Consolidate chain capabilities and qualify dependency-floor changes

### Current behavior

Chain-related data is split among:

- `SUPPORTED_CHAIN_IDS` and `CHAINS`;
- token registry;
- PSM addresses;
- private `SSR_SOURCES` in `apy.ts`;
- route logic based on `ChainMetadata.isMainnet`.

`isMainnet` really means the Ethereum Lite-PSM/ERC-4626 route rather than a general network property.
The workspace-installed viem exports `unichain`, while the package's peer minimum is `^2.21.0` and
`chains.ts` carries an inline definition for compatibility.

The supplied recommendation to bump viem, ethers, and Privy floors together is only partially
validated. Only the viem/Unichain relationship is evidenced; no source finding requires higher
ethers or Privy minimums.

### Required change

Consolidate internal capability data around route semantics, for example:

- chain metadata;
- token addresses;
- protocol kind (`psm3`, Lite PSM, ERC-4626);
- protocol addresses;
- savings-rate source;
- supported exact-in/exact-out pairs.

Keep exported metadata narrower than internal route configuration unless consumers need all details.
Replace `isMainnet` with a protocol/route discriminant if changing the public shape.

If replacing the inline Unichain definition:

1. determine the first viem version that exports the required chain object;
2. raise only the viem peer minimum to that verified version;
3. test the minimum version, not only the workspace-installed latest version.

Do not raise ethers or Privy floors without identifying an API actually required by the SDK and
adding minimum-version compatibility tests.

## F18 — Harden balance reads and optionally use multicall

### Current behavior

`getTokenBalance` has the unknown-symbol throw described in F01 and does not validate `account`
upfront. `getTokenBalances` starts three independent `balanceOf` calls for USDC, USDS, and sUSDS.

### Required change

First fix correctness:

- validate account;
- validate a runtime symbol against the canonical symbol set;
- preserve support for arbitrary valid ERC-20 addresses;
- return `ValidationError` without issuing RPC calls for bad input.

Then consider one multicall for canonical balances, with a documented fallback when provider/chain
capabilities do not support it. Decide whether one failed token fails the whole aggregate or returns
per-token results; do not change that contract accidentally while optimizing calls.

### Required tests

- every canonical symbol;
- arbitrary address;
- malformed address and unknown symbol;
- account validation;
- multicall success, one-call failure semantics, and fallback;
- verify call count.

## F19 — Improve APY numerical precision

### Current behavior

`ssrToApy` converts the full RAY-scaled bigint to `number` before subtracting the base:

```ts
(Number(ssr) / 1e27) ** SECONDS_PER_YEAR - 1;
```

For `ssr = RAY + 10^18`, the current calculation produced approximately
`0.03203853099053755`; a high-precision calculation produced approximately
`0.03203852829763911`. The display error is small but avoidable.

Relevant source:

- `packages/client/src/lib/apy.ts` — `ssrToApy`

### Required change

Calculate the small delta before converting to `number`, then use numerically stable functions such
as `Math.log1p` and `Math.expm1`. Preserve documented behavior for `ssr === RAY` and decide how to
handle malformed rates below or far above expected protocol bounds.

### Required tests

- exactly RAY;
- representative positive rates against high-precision fixtures;
- very small delta that the old full-value conversion rounds away;
- protocol-boundary behavior.

## F20 — Fix license, clean-build, tarball, and publication gating

### Current behavior

- `package.json` declares MIT, but no `LICENSE*` file exists in the repository.
- `pnpm pack --dry-run --json` includes stale `dist/lib/actions/depositSUsds.js`, `.d.ts`, and
  `.d.ts.map` files with no matching current source/export.
- the build uses incremental `tsc --build` without first cleaning `dist`;
- the release workflow runs the build-and-publish script but does not itself run lint, format,
  typecheck, tests, or package validation;
- CI and release are independent workflows. A release can therefore be attempted without a direct
  dependency on successful CI for that commit;
- the dry-run tarball includes README but not CHANGELOG.

Relevant source:

- `packages/client/package.json`
- root `package.json` — `ci:publish`
- `.github/workflows/{ci,release}.yml`
- `packages/client/tsconfig.lib.json`

### Required change

- add the actual MIT license and assert it appears in the tarball;
- clean the package output before release build;
- validate tarball contents against an expected allowlist;
- make publication depend on all required quality and package checks for the exact commit;
- decide whether source files, declaration maps, changelog, and custom `osero-sdk` condition are
  intentionally shipped;
- preserve npm provenance;
- prevent stale generated outputs from entering local or CI publication.

The manifest's `main`, `module`, and `types` fields are not automatically defects. They provide
compatibility for resolvers that do not fully honor `exports`. Keep them synchronized with `exports`
unless the documented runtime/tooling support policy deliberately drops those consumers.

### Required tests

- clean checkout build followed by tarball inspection;
- dirty/stale `dist` fixture cannot leak deleted files;
- packed install resolves every public entrypoint;
- package contains license and intended docs;
- release job refuses to publish when any required gate fails;
- manifest entrypoints all resolve to equivalent built files.

### Do not

- delete `main`/`module`/`types` merely because modern Node prioritizes `exports`;
- publish directly from a developer's incremental output directory;
- assume a separate CI workflow is a publication dependency.

## F21 — Add adapter, fork, package-consumer, and full-source coverage gates

### Current behavior

The unit suite is healthy but heavily mocked:

- 268 tests pass;
- there is no ethers adapter test file;
- viem has only two tests and approximately 59% line coverage in the current report;
- coverage does not include all production files, so the aggregate approximately 91% line result is
  optimistic;
- no pinned-chain fork/integration tests verify deployed addresses, ABI compatibility, quote math,
  or plan simulation;
- CI tests Node 24 only;
- no packed-package consumer/type-resolution gate is configured.

### Required change

Add release gates for:

1. a shared adapter behavioral contract suite for viem, ethers, and Privy;
2. `coverage.all` or an explicit production include list, plus thresholds that include all source;
3. pinned-block fork tests on every supported chain for deployed bytecode, read methods, quote math,
   and non-broadcasting simulation;
4. hosted API malicious-response fixtures from F03;
5. packed-tarball ESM imports and TypeScript consumer builds;
6. optional-peer tests where root/API imports work without ethers or Privy installed;
7. minimum and supported Node/TypeScript/dependency versions;
8. a public declaration/API report.

Keep live/fork tests deterministic and pinned. Broadcasting real funds is not required for release
confidence.

### Required acceptance

- all production files appear in coverage output;
- each adapter exercises success, cancellation, mismatch, estimate/broadcast/wait failure, revert,
  and partial-plan behavior;
- every supported chain has a pinned, reproducible contract smoke test;
- every documented package import works from the actual tarball;
- unsupported optional peers fail only when their corresponding subpath is imported.

## Validation of the supplied audit

The following table records how each supplied finding was handled. “Qualified” means the observed
problem is real but the proposed fix was incomplete or unsafe as written.

| Supplied item                                           | Result                                                           | Consolidated location |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------- |
| 1. Unvalidated slippage escapes Result                  | Confirmed by source and runtime probe                            | F01                   |
| 2. Unknown balance symbol throws                        | Confirmed by source and runtime probe                            | F01, F18              |
| 3. `InsufficientBalanceError` has no producer           | Confirmed by LSP references                                      | F05                   |
| 4. Disconnected viem wallet throws plain `Error`        | Confirmed by runtime probe                                       | F01, F05              |
| 5. `ClientConfig.confirmations` is dead                 | Confirmed by LSP references                                      | F07                   |
| 6. Error names are not literal discriminants            | Confirmed by LSP hover (`Error.name: string`)                    | F05                   |
| 7. `ValidationError.field` is documented but absent     | Confirmed; current field is `context.field`                      | F05                   |
| 8. Intermediate transaction hashes are discarded        | Confirmed                                                        | F04                   |
| 9. Local/hosted slippage and referral vocabulary differ | Confirmed; proposed unions require safer serializers             | F11                   |
| 10. Duplicate synchronous and async chain APIs          | Confirmed                                                        | F06                   |
| 11. Testing hook leaks through the public class         | Confirmed in emitted declarations                                | F06                   |
| 12. Raise all peer dependency floors                    | Qualified; only viem/Unichain need is evidenced                  | F17                   |
| 13. `@internal` exports are contradictory               | Confirmed; external-documentation claim was not needed           | F06                   |
| 14. Plans always approve                                | Confirmed; ERC-20 allowance ABI is already present but unused    | F08                   |
| 15. Direct USDS/sUSDS routes are absent                 | Confirmed                                                        | F09                   |
| 16. Hosted gas estimates are dropped                    | Confirmed; do not treat remote estimates as hard gas limits      | F10                   |
| 17. Adapter gas/error behavior differs                  | Confirmed with qualification about ethers internal estimation    | F16                   |
| SSR sources are separate from other registries          | Confirmed                                                        | F17                   |
| `SendWithOptions.confirmations` is repeated             | Confirmed; shared type is optional, not inherently necessary     | F16                   |
| Remove legacy `main`/`module`/`types` fields            | Not accepted as a default fix; test and synchronize them instead | F20                   |

## Recommended v1 cut line

Do not publish a stable tag before F01–F05, F20, and F21 are resolved or explicitly waived with a
written product/security decision.

Use the breaking window for F06, F07, F10, F11, and F12. F04 should establish enough plan/executor
structure that F08, F13, and F15 can be added without another plan-shape break.

F09, F13, F14, F15, F18, and F19 are feature/performance wins. Their implementations must not delay
or weaken the transaction-safety and release-integrity blockers above.
