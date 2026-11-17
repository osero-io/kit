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

- **viem and Privy** observe viem's `onReplaced` callback. If viem returns a receipt for a different
  hash without naming a reason, the adapter fails closed and treats it as `replaced`.
- **ethers** reads the `TRANSACTION_REPLACED` error. A replacement flagged `cancelled`, or with any
  reason other than `repriced`, fails.
- **EIP-5792** applies the rule to the extra-confirmation wait (`confirmations` greater than `1`).
  Replacement of a batch before the wallet reports its terminal status is the wallet's concern and
  is not observable through `wallet_getCallsStatus`.
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

| Stage          | viem                                                                                                       | ethers                                                                                                                                            | Privy                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `simulation`   | Estimate failed: `SimulationError`                                                                         | Estimate failed: `SimulationError`                                                                                                                | Not performed                                         |
| `signing`      | User rejection: `CancelError`. Any send error viem does not classify as an execution error: `SigningError` | `ACTION_REJECTED`: `CancelError`. Any send error not listed under broadcast: `SigningError`                                                       | Caller abort (`APIUserAbortError`): `CancelError`     |
| `broadcast`    | viem `TransactionExecutionError` that is not a user rejection: `BroadcastError`                            | `INSUFFICIENT_FUNDS`, `NONCE_EXPIRED`, `REPLACEMENT_UNDERPRICED`, `NETWORK_ERROR`, `SERVER_ERROR`, or a malformed returned hash: `BroadcastError` | **Every other Wallet API error: `BroadcastError`**    |
| `confirmation` | Receipt wait failed or timed out: `ConfirmationError`                                                      | Receipt wait failed, timed out, or returned no receipt: `ConfirmationError`                                                                       | Receipt wait failed or timed out: `ConfirmationError` |
| `replacement`  | Not repriced: `ConfirmationError`                                                                          | Not repriced: `ConfirmationError`                                                                                                                 | Not repriced: `ConfirmationError`                     |
| `revert`       | Receipt status `reverted`: `TransactionError`                                                              | Receipt status `0`: `TransactionError`                                                                                                            | Receipt status `reverted`: `TransactionError`         |

Two mappings are worth knowing when you branch on `code`:

- In viem and ethers, a send failure the adapter cannot recognise is reported as `SigningError`
  (`SIGNING_FAILED`), not `BroadcastError`. Do not read `SIGNING_FAILED` as proof that nothing
  reached the network.
- In Privy, the SDK cannot tell a policy denial from a network failure, so every Wallet API error
  other than a caller abort is `BroadcastError`. A response without a standard transaction hash,
  such as a sponsored or user-operation response, is `UnsupportedCapabilityError`; the adapter never
  invents a hash.

### EIP-5792 atomic batch

| Stage          | Condition                                                                                                      | Error                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| preflight      | Wallet cannot batch atomically and fallback is disabled or the plan requires `atomic-batch`                    | `UnsupportedCapabilityError`                    |
| `signing`      | `wallet_sendCalls` rejected with code `4001` (user rejection) or `5750` (upgrade declined)                     | `CancelError`                                   |
| `signing`      | `wallet_sendCalls` rejected with code `4100` (unauthorized)                                                    | `SigningError`                                  |
| `broadcast`    | Any other `wallet_sendCalls` failure, or a response without a usable batch ID                                  | `BroadcastError`                                |
| `confirmation` | The status wait failed or timed out                                                                            | `ConfirmationError`, message names the batch ID |
| `confirmation` | The wallet returned a malformed status, a failure without a receipt, or a status that is not an atomic success | `ConfirmationError`, message names the batch ID |
| `revert`       | Status `500` or `600` with a receipt                                                                           | `TransactionError` with that transaction hash   |
| `replacement`  | During the extra-confirmation wait, the batch transaction was cancelled or replaced                            | `ConfirmationError`                             |

`wallet_sendCalls` code `5760` (atomicity not supported) is not an error by itself: the adapter falls
back to sequential viem execution unless fallback is disabled.

For every batch failure after submission, `execution.completed` lists the steps that were confirmed
before the batch (a resumed prefix), never the batched steps themselves. An atomic batch either
confirms every pending step or none.

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
