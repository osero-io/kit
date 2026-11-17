---
'@osero/client': minor
---

Add the remaining capabilities from the v1 audit. Everything here is additive: no export, type, error code, default, or existing behaviour changed, and every new field is optional.

**Resume from a failure.**

- `executionResumeStateFromError(plan, error)` builds the `resume` option for the next `sendWith` call from a failed execution. It returns state only when that is safe: every confirmed step on the error must carry its receipt, and the step that failed must provably not have taken effect (it was never sent, or it was mined and reverted). When the failed step may already have been submitted, such as a receipt timeout or an EIP-5792 batch whose status never arrived, it returns a `ValidationError` naming the hash or batch id to check. Pass `{ unresolvedStep: 'assume-not-executed' }` after confirming the step did not execute.
- `serializeExecutionResumeState(state)` and `deserializeExecutionResumeState(json)` persist resume state as bigint-safe canonical JSON, like the plan serializers.
- Completed steps on an execution error (`error.execution.completed`) now carry optional `submittedHash`, `replacement`, and `confirmation`. Every bundled adapter sets them. `JSON.stringify(error.execution)` keeps working: the bigint receipt fields are written as decimal strings.
- `error.execution.batchId` is set on EIP-5792 failures once the wallet has accepted a batch.
- `QuoteExpiredError` has an optional `execution` context. When a quote expires between steps, it names the step that was not sent and lists the steps already confirmed.

**Wait for a cross-chain transfer without the quote.** `OseroApiClient.waitForTransferStatus({ sourceTransactionHash, statusContext }, options)` polls with the same options and semantics as `waitForSwapCompletion`, so a restarted process can resume waiting from a persisted status request. `waitForSwapCompletion` is unchanged.

**Richer simulation.** `simulateExecutionPlan` results gain:

- `feeData.basis` (`'max-fee-per-gas'` or `'gas-price'`) and `feeData.maxFeePerGas`. `feeData.gasPrice` keeps its value and meaning.
- `revert: { reason?, data? }` on a failed step, when the node returned a revert reason or raw revert data.
- an optional fourth argument `{ quote }`. Given the prepared quote the plan came from, the result's `quote` field echoes the expected amount and the minimum output or maximum input. A quote for a different plan is a `ValidationError`.

**Opt-in local gas estimates.** `prepareSwap` accepts `gasEstimates: 'independent-steps'`. It estimates, at the quote block, the steps that do not depend on an earlier step (the first step) and attaches `estimatedGas` with source `'local-simulation'`. The default is `'none'`, which makes no extra RPC call. A failed estimate omits the field and never fails `prepareSwap`. Estimates do not change the plan ID.

**Route discovery.** `listSwapRoutes(chainId)` lists each supported local pair with its modes, how each mode enforces its slippage bound, and its referral capability.

**Executor capabilities.**

- `ExecutorCapabilities.supportedChainIds` is an optional declaration of the chains an executor can submit to. The SDK's capability preflight rejects a plan with a step on another chain when a capability object sets it. The bundled adapters leave it unset, and the preflight is internal, so a custom executor must enforce its own declaration.
- When the Privy Wallet API returns a response without a standard transaction hash, the `UnsupportedCapabilityError` now carries an optional `execution` context naming the step and the steps already confirmed.

**Refresh Context forward compatibility.** Primitive fields the API adds to a Refresh Context are preserved and sent back unchanged on refresh. A Refresh Context without extra fields is sent byte-for-byte as before.

Release tooling: the packed-consumer check now typechecks the ethers and Privy entrypoints with their peers installed at the supported floors (viem 2.28.0, ethers 6.14.0, `@privy-io/node` 0.19.0), the adapter files have per-file coverage floors, and CI bundles the browser-supported entrypoints and fails on any Node.js built-in import.
