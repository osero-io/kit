# Wallet adapter behaviour contract

`@osero/client` ships four executors: `@osero/client/viem`, `@osero/client/ethers`,
`@osero/client/privy`, and `@osero/client/eip5792`. Each exports `sendWith`, takes an
`ExecutionPlan`, and returns `ResultAsync<TransactionResult, SendWithError>`. This page states what
each adapter does at every stage, so a caller knows which defaults apply and which error to expect.

The adapters share one contract but not one implementation. Where they differ, the difference is
listed here rather than hidden.

## What every adapter does

1. **Never throws for an operational failure.** Every failure after the call starts is returned as
   an `Err` whose error has a literal `code`.
2. **Preflights the whole plan before the first broadcast.** The plan, every step, the executor
   options, the connected account, the chain, the executor capabilities, and any resume proof are
   checked first. A malformed later step, a wrong account, or a wrong chain causes zero broadcasts.
3. **Never switches chains and never batches on its own.** `chainSwitching` is `'none'` for all four
   adapters, so a plan whose `requirements.chainTransitions` is `true` is rejected with
   `UnsupportedCapabilityError` before anything is sent.
4. **Never retries a transaction.** A failed or ambiguous step is returned to the caller.
5. **Rechecks quote expiry immediately before each submission.** An expired hosted plan returns
   `QuoteExpiredError` and nothing is sent for that step.
6. **Treats `estimatedGas` as advisory.** A hosted or local estimate attached to a step is never
   used as a gas limit.
7. **Never abandons a submitted transaction because a progress callback threw.** The step in flight
   is still confirmed. The plan then stops before the next broadcast and returns
   `ProgressCallbackError` at stage `progress`.

## Gas estimation and buffer

| Adapter  | Estimation                                                               | Buffer                                                                      |
| -------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| viem     | Fresh `estimateGas` per step through the wallet client                   | `gasBufferBps`, default `1500` (15%), integer in `[0, 10000]`, rounded up   |
| ethers   | Fresh `signer.estimateGas` per step                                      | `gasBufferBps`, default `1500` (15%), integer in `[0, 10000]`, rounded up   |
| Privy    | None in the SDK. The Privy Wallet API selects gas.                       | Not applicable. `gasBufferBps` is not an option.                            |
| EIP-5792 | None for an atomic batch. The wallet selects gas for `wallet_sendCalls`. | `gasBufferBps` applies only when the adapter falls back to sequential viem. |

The buffered limit is `ceil(estimate × (10000 + gasBufferBps) / 10000)`. An out-of-range
`gasBufferBps` is a `ValidationError` before any RPC call.

## Confirmations

`confirmations` defaults to `1` in every adapter. It must be a positive safe integer; anything else
returns `ValidationError` on field `confirmations` before any broadcast.

The EIP-5792 adapter accepts the wallet's terminal batch status as one confirmation. With
`confirmations` greater than `1` it then waits for that many confirmations of the batch's
transaction through viem.

## Receipt timeout

| Adapter  | Default when `confirmationTimeoutMs` is omitted                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| viem     | viem's `waitForTransactionReceipt` default, 180 seconds                                                                                                                                  |
| Privy    | viem's `waitForTransactionReceipt` default, 180 seconds (receipts are read through a viem public client)                                                                                 |
| ethers   | **No timeout.** The adapter calls `response.wait(confirmations, 0)`, and ethers treats `0` as wait indefinitely. Pass `confirmationTimeoutMs` to bound it.                               |
| EIP-5792 | 60 seconds, applied to the batch status wait and to the extra-confirmation wait. The same 60 seconds is passed to the viem executor when the adapter falls back to sequential execution. |

When set, `confirmationTimeoutMs` must be a positive safe integer. A timeout is returned as
`ConfirmationError` at stage `confirmation`. The transaction may still confirm later; the error
carries the submitted hash so the caller can check before deciding anything.

## Replaced transactions

A wallet can replace a pending transaction by reusing its nonce. The adapters distinguish three
cases:

| Replacement                                          | Result                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Repriced**: same transaction, higher fee           | Success. `ConfirmedTransaction.submittedHash` is the original hash, `hash` is the effective hash, and `replacement` is `{ reason: 'repriced', originalHash, replacementHash }` |
| **Cancelled**: replaced by a no-op self-transfer     | `ConfirmationError` at stage `replacement`, with the submitted hash. No later step is broadcast.                                                                               |
| **Replaced**: a different transaction took the nonce | `ConfirmationError` at stage `replacement`, with the submitted hash. No later step is broadcast.                                                                               |

The rule is the same in every adapter: only a repricing may stand in for the step that was
submitted. The message is `Transaction <hash> was <reason> and cannot be treated as this plan step`.

- **viem and Privy** observe viem's `onReplaced` callback. A `cancelled` or `replaced` reason fails
  the step. A repricing is never taken on viem's word: viem decides `repriced` by comparing the
  replacement with the transaction the node returns under the submitted hash, which need not be
  what the adapter asked the wallet to send. So for any `confirmations`, and on every viem version,
  the adapter compares the transaction viem found in the mined block with what it submitted. The
  same sender, target, calldata, and value under another hash is a repricing. Anything else,
  including a replacement the adapter could not observe, fails closed as `cancelled` or `replaced`.
  The same comparison classifies a replacement viem returns without naming a reason, which viem
  before 2.57.12 does when more than one confirmation is requested. The comparison uses the block
  viem already read for the wait, so it adds no RPC request. To see that block, the adapter's wait
  keeps its own receipt polling: it does not join a `waitForTransactionReceipt` you started yourself
  on the same client and hash, so that wait's `confirmations` no longer stand in for the ones you
  passed to `sendWith`. Block-number polling is still shared.
- **ethers** reads the `TRANSACTION_REPLACED` error. A replacement flagged `cancelled`, or with any
  reason other than `repriced`, fails.
- **EIP-5792** applies the rule to the extra-confirmation wait (`confirmations` greater than `1`).
  The wallet builds the batch transaction, so the adapter has nothing to compare a substitute
  against: any change of the batch transaction's hash during that wait fails, unless viem itself
  reports a repricing. Replacement of a batch before the wallet reports its terminal status is the
  wallet's concern and is not observable through `wallet_getCallsStatus`.
- **Privy limitation.** Replacement is detected only for a response that carries a standard
  transaction hash, by scanning blocks through the receipt client. The adapter cannot observe what
  the Privy Wallet API does before it returns that hash.

## Which error each stage returns

`execution.stage` on the returned error names the stage. `execution.hash` is present whenever a
transaction hash exists, and `execution.completed` lists the steps confirmed before the failure.

### Preflight (all adapters, nothing broadcast)

| Condition                                                            | Error                                       |
| -------------------------------------------------------------------- | ------------------------------------------- |
| Malformed plan, step, option, or resume state                        | `ValidationError`                           |
| Wallet client without account or chain (viem, EIP-5792)              | `ConfigurationError`                        |
| Signer without a provider, or signer address unavailable (ethers)    | `ConfigurationError`                        |
| Missing options, receipt client, or transport (Privy)                | `ConfigurationError`                        |
| `provider.getNetwork()` failed (ethers)                              | `RpcError`                                  |
| Executor account differs from the plan's `from`                      | `AccountMismatchError`                      |
| Executor chain differs from the plan's chain                         | `ChainMismatchError`                        |
| Plan requires atomic batch, permit, sponsorship, or chain transition | `UnsupportedCapabilityError`                |
| A resume proof is not a successful matching receipt                  | `ConfirmationError` at stage `confirmation` |

The viem and EIP-5792 adapters bind to `walletClient.account` and `walletClient.chain`. The ethers
adapter resolves the account from `signer.getAddress()` and the chain from `provider.getNetwork()`.
The Privy adapter binds to `wallet.address` and the required `chainId` option.

### Per step

| Stage          | viem                                                                                                       | ethers                                                                                                                                               | Privy                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `simulation`   | Estimate failed: `SimulationError`                                                                         | Estimate failed: `SimulationError`                                                                                                                   | Not performed                                         |
| `signing`      | User rejection: `CancelError`. Any send error viem does not classify as an execution error: `SigningError` | `ACTION_REJECTED`: `CancelError`. Any send error not listed under broadcast: `SigningError`                                                          | Caller abort (`APIUserAbortError`): `CancelError`     |
| `broadcast`    | viem `TransactionExecutionError` that is not a user rejection: `BroadcastError`                            | `INSUFFICIENT_FUNDS`, `NONCE_EXPIRED`, `REPLACEMENT_UNDERPRICED`, `NETWORK_ERROR`, `SERVER_ERROR`, or a malformed returned hash: `BroadcastError`    | **Every other Wallet API error: `BroadcastError`**    |
| `confirmation` | Receipt wait failed or timed out: `ConfirmationError`                                                      | Receipt wait failed, timed out, returned no receipt, or returned a reverted receipt: `ConfirmationError`                                             | Receipt wait failed or timed out: `ConfirmationError` |
| `replacement`  | Not repriced: `ConfirmationError`                                                                          | Not repriced: `ConfirmationError`                                                                                                                    | Not repriced: `ConfirmationError`                     |
| `revert`       | Receipt status `reverted`: `TransactionError`                                                              | Only a repriced replacement whose receipt has status `0`: `TransactionError`. An ordinary reverted receipt is reported at `confirmation` (see below) | Receipt status `reverted`: `TransactionError`         |

Three mappings are worth knowing when you branch on `code`:

- In ethers, a reverted transaction is normally `ConfirmationError` (`CONFIRMATION_FAILED`), not
  `TransactionError`. ethers v6 `wait()` throws `CALL_EXCEPTION` for a receipt with status `0`, and
  the adapter reports every `wait()` failure other than a replacement at stage `confirmation`. The
  error carries the transaction hash and the ethers error, whose `receipt` shows the revert, as
  `cause`. viem, Privy, and EIP-5792 report a revert as `TransactionError`.

- In viem and ethers, a send failure the adapter cannot recognise is reported as `SigningError`
  (`SIGNING_FAILED`), not `BroadcastError`. Do not read `SIGNING_FAILED` as proof that nothing
  reached the network.
- In Privy, the SDK cannot tell a policy denial from a network failure, so every Wallet API error
  other than a caller abort is `BroadcastError`. A response without a standard transaction hash,
  such as a sponsored or user-operation response, is `UnsupportedCapabilityError`; the adapter never
  invents a hash.

### EIP-5792 atomic batch

| Stage          | Condition                                                                                                                                                                                                                                            | Error                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| preflight      | Wallet cannot batch atomically and fallback is disabled or the plan requires `atomic-batch`                                                                                                                                                          | `UnsupportedCapabilityError`                    |
| `signing`      | `wallet_sendCalls` rejected with code `4001` (user rejection) or `5750` (upgrade declined)                                                                                                                                                           | `CancelError`                                   |
| `signing`      | `wallet_sendCalls` rejected with code `4100` (unauthorized)                                                                                                                                                                                          | `SigningError`                                  |
| `broadcast`    | Any other `wallet_sendCalls` failure, or a response without a usable batch ID                                                                                                                                                                        | `BroadcastError`                                |
| `confirmation` | The status wait failed or timed out                                                                                                                                                                                                                  | `ConfirmationError`, message names the batch ID |
| `confirmation` | The wallet returned a malformed status, a failure without a receipt, or a partial revert (status `600`, or a `500` that carries a successful receipt or is not reported as atomic), an unreadable receipt, or a status that is not an atomic success | `ConfirmationError`, message names the batch ID |
| `revert`       | Status `500` (complete revert) with a receipt, atomicity not disclaimed, and no successful receipt                                                                                                                                                   | `TransactionError` with that transaction hash   |
| `replacement`  | During the extra-confirmation wait, the batch transaction was cancelled or replaced                                                                                                                                                                  | `ConfirmationError`                             |

`wallet_sendCalls` code `5760` (atomicity not supported) is not an error by itself: the adapter falls
back to sequential viem execution unless fallback is disabled.

For every batch failure after submission, `execution.completed` lists the steps that were confirmed
before the batch (a resumed prefix), never the batched steps themselves. The adapter asks the wallet
for atomic execution and accepts only an atomic success. If a wallet nevertheless reports a partial
revert, the outcome is unknown rather than reverted: some calls may be on chain.

When a progress callback throws during an atomic batch, the batch is still confirmed and the
returned `ProgressCallbackError` lists every batched step in `execution.completed`, whichever event
the callback failed on. Resume state derived from it resumes to a finished plan and sends nothing.

`UnexpectedError` is reserved for a genuine defect inside the adapter. An error that is already
classified is never re-wrapped.

## Progress events

Sequential adapters emit, in order: `preflight-complete`, then for each step `step-started`,
`step-submitted` (with the submitted hash), `step-confirmed`, and finally `plan-completed`.

An EIP-5792 atomic batch emits the same event types as facts become known:

1. when the wallet accepts the batch: `preflight-complete`, then `step-started` for every batched
   step;
2. when the wallet reports the batch's transaction: `step-submitted` for every step, carrying that
   transaction hash;
3. after confirmation only: `step-confirmed` for every step, then `plan-completed`.

A batch ID is not a transaction hash, so no `step-submitted` event is emitted until the wallet
reports one. A batch whose status wait times out has therefore emitted `step-started` but not
`step-submitted`; the batch ID is in the error message. A batch that reverts has emitted
`step-submitted` and no `step-confirmed`.

## Resuming

Pass `resume` with the confirmed prefix to skip steps that already executed. Every adapter fetches
the receipt for each entry and requires a successful receipt with the same hash before skipping it.
A missing, reverted, or mismatched receipt returns `ConfirmationError` and nothing is sent.

Every bundled adapter records each confirmed step on `execution.completed` with its
`submittedHash`, `replacement`, and `confirmation`, which is everything resume state needs.
`executionResumeStateFromError(plan, error)` turns a failure into the `resume` option, and
`serializeExecutionResumeState` / `deserializeExecutionResumeState` persist it. A custom executor
that reports completed steps without confirmations is still valid; resume state cannot be derived
from its errors.

Resuming sends the failed step again, so the helper returns state only when the failure proves that
step did not take effect. By stage:

| Stage of the failure                        | Derived by default | Why                                                                                                                 |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `preflight`, `simulation`                   | Yes                | The step was never sent.                                                                                            |
| `signing` with an explicit wallet rejection | Yes                | The wallet refused the request: EIP-1193 code `4001`, EIP-5792 code `5750`, or ethers `ACTION_REJECTED`.            |
| `revert`                                    | Yes                | The step was mined and reverted. A batch is reported as reverted only when it reverted as a whole.                  |
| `progress`                                  | Yes                | The step is either unsent or listed as completed.                                                                   |
| `signing` with any other error              | No                 | An unrecognised send error, or a cancellation that is a client-side abort (Privy), does not prove nothing was sent. |
| `broadcast`, `confirmation`, `replacement`  | No                 | A transaction or batch may be in flight or mined under another hash.                                                |

For the "No" rows the helper returns a `ValidationError` whose `details` carry the `stage` and any
`hash` or `batchId`. After checking that the step did not execute, pass
`{ unresolvedStep: 'assume-not-executed' }`.

Two errors carry execution context beyond the per-stage tables above:

- `QuoteExpiredError` raised between steps has `execution` set to the step that was not submitted
  (stage `preflight`), with the confirmed prefix in `execution.completed`.
- The Privy `UnsupportedCapabilityError` for a response without a standard transaction hash has
  `execution` set to that step (stage `broadcast`). The Wallet API accepted the request, so treat
  the step as possibly in flight.

EIP-5792 failures after the wallet accepted a batch carry the batch identifier as
`execution.batchId`.

## Declaring chain support in a custom executor

`ExecutorCapabilities.supportedChainIds` is an optional declaration of the chains an executor can
submit to. The SDK's own capability preflight honours it: a capability object that sets it rejects
a plan with a step on any other chain with `UnsupportedCapabilityError`
(`capability: 'chain:<id>'`) before anything is sent. The bundled adapters leave it unset, because
they bind to the connected wallet's chain instead.

That preflight is internal and is not exported. A custom executor that implements
`ExecutionPlanHandler` itself does not pass through it, so it must enforce its own declaration.
