---
'@osero/client': patch
---

Close the bug and security gaps left from the v1 audit. No export, type, error code, or default changed. The observable behaviour changes are:

**Approval calldata must be canonical.** An approval step is accepted only when its calldata is byte-for-byte the canonical encoding of `approve(spender, amount)`. Calldata that decodes to the right spender and amount but carries extra bytes after the arguments was previously accepted and is now rejected. This applies to hosted quotes (`getSwapQuote`, `refreshSwapQuote`, and `executeSwap` return `ApiResponseError`) and to plans you build or load yourself (`createTransactionRequest`, `createExecutionPlan`, `deserializeExecutionPlan`, `resumeExecutionPlan`, and every `sendWith` return `ValidationError`). Approvals built with `createApprovalTransaction` are unaffected.

**A cancelled or replaced transaction is no longer treated as confirmed.** In the viem, Privy, and EIP-5792 adapters, if a submitted transaction is cancelled or replaced by a different transaction, `sendWith` now returns `ConfirmationError` at stage `replacement` with the submitted hash, and no later step is broadcast. Previously the replacement's receipt was recorded as a successful step. This matches the ethers adapter. A transaction that was only repriced still succeeds, for any number of confirmations. viem names the kind of replacement only when one confirmation is requested; with more, the viem and Privy adapters compare the replacement viem found in the mined block with what was submitted and accept it only if its sender, target, calldata, and value are exactly the same. This adds no RPC request. To observe that block, the adapter's receipt wait no longer joins a `waitForTransactionReceipt` you started yourself on the same client and hash: it polls for the receipt on its own, so that wait's `confirmations` no longer stand in for the ones passed to `sendWith`. Block-number polling is still shared.

**Repriced transactions are labelled `repriced`.** For a repriced step the viem adapter now reports `replacement.reason` as `'repriced'` instead of `'replaced'`, matching ethers. The Privy adapter now also reports `submittedHash` and `replacement` for a repriced step instead of only the effective hash. The EIP-5792 adapter cannot verify a wallet-built batch transaction, so a change of the batch transaction's hash while it waits for extra confirmations now fails with `ConfirmationError` at stage `replacement`.

**Privy `sendWith` no longer throws on a malformed plan.** A malformed plan passed together with `idempotencyKeys`, a `null` plan, or an `idempotencyKeys` value that is not an object made `sendWith` throw a `TypeError`. Each now returns `ValidationError` and makes no Wallet API call.

**EIP-5792 failures are classified.** The EIP-5792 adapter returned `UnexpectedError` for failures it can identify. Now:

- a `wallet_sendCalls` failure returns `SigningError` for an unauthorized account (code `4100`) and `BroadcastError` for anything else that is not a user rejection or an atomic-capability refusal (code `5760`, which still falls back to sequential sends or returns `UnsupportedCapabilityError`); a response without a batch ID returns `BroadcastError`;
- a batch status wait that fails or times out returns `ConfirmationError`, with the batch ID in the message;
- a malformed, failed, or non-atomic batch status returns `ConfirmationError`;
- a batch that reverted as a whole still returns `TransactionError`, and its `execution.completed` now lists the steps confirmed before the batch instead of being empty;
- a partial revert (status `600`, or a status `500` that carries a successful receipt or is not reported as atomic) now returns `ConfirmationError` instead of `TransactionError`, because some calls may be on chain;
- an unreadable receipt during the extra-confirmation wait now returns `ConfirmationError` instead of `TransactionError`.

**EIP-5792 batch progress is reported as it happens.** Progress events for an atomic batch were emitted only after the batch succeeded, so a failed batch reported nothing. `preflight-complete` and `step-started` are now emitted when the wallet accepts the batch, `step-submitted` when the wallet reports the batch's transaction hash, and `step-confirmed` and `plan-completed` only after confirmation. For a successful batch the same events are emitted, with all submissions before all confirmations.

**A progress callback failure on an EIP-5792 batch reports every confirmed step.** When `onProgress` threw during an atomic batch, the returned `ProgressCallbackError` listed only the steps before the failing event in `execution.completed`, even though the whole batch had confirmed. It now lists every batched step.

**Unknown Transfer States keep polling.** A normalized transfer `state` this SDK release does not know is decoded as `'unknown'` instead of failing the response with `ApiResponseError`. `waitForSwapCompletion` keeps polling on it.

**Referral codes in responses are not range-checked.** The response decoder rejected referral codes outside 3000–3999 even though requests accept any code and the range was documented as not enforced client-side. Any non-negative safe integer the API returns is now accepted. The code must still match the one you requested.

**Multicall works on Unichain.** `getTokenBalances` with `multicall: 'require'` always failed on chain 130, and `'prefer'` always fell back to three separate reads, because the Unichain chain definition did not declare Multicall3. It now does, so `getChain(130).viemChain.contracts.multicall3` is set.

Documentation: the adapter defaults and per-stage error mappings are now specified in `docs/osero-sdk/adapters.md`, and the README states the supported runtimes.
