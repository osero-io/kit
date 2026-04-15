import {
  type Account,
  type Chain,
  type Transport,
  TransactionExecutionError,
  UserRejectedRequestError,
  type WalletClient,
} from 'viem';
import {
  estimateGas as estimateGasWithViem,
  sendTransaction as sendTransactionWithViem,
  waitForTransactionReceipt,
} from 'viem/actions';

import { type SingleTxExecutor, runExecutionPlan } from './lib/adapters.js';
import { CancelError, SigningError, TransactionError, UnexpectedError } from './lib/errors.js';
import { errAsync, okAsync, ResultAsync } from './lib/result.js';
import type {
  ExecutionPlan,
  ExecutionPlanHandler,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';

/**
 * Any viem `WalletClient` that has an account attached. The viem
 * adapter refuses to run without an account because we need to set
 * `from` and `chain` explicitly on every tx.
 */
export type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

function hasConnectedAccount(walletClient: WalletClient): walletClient is ConnectedWalletClient {
  return walletClient.account !== undefined && walletClient.chain !== undefined;
}

/**
 * Estimate gas for a single transaction and add a 15% buffer. The
 * buffer matches the Aave SDK's default and cushions against minor
 * block-to-block variance (storage writes, fresh slots, etc.).
 *
 * @internal
 */
function estimateGas(
  walletClient: ConnectedWalletClient,
  request: TransactionRequest,
): ResultAsync<bigint, SigningError> {
  return ResultAsync.fromPromise(
    estimateGasWithViem(walletClient, {
      account: walletClient.account,
      to: request.to,
      data: request.data,
      value: request.value,
    }),
    (err) => SigningError.from(err),
  ).map((gas) => (gas * 115n) / 100n);
}

/**
 * Translate a viem error into the corresponding Osero error, mapping
 * user cancellations to {@link CancelError} and everything else to
 * {@link SigningError}.
 *
 * @internal
 */
function mapSendError(err: unknown): CancelError | SigningError {
  if (err instanceof TransactionExecutionError) {
    const rejected = err.walk((inner) => inner instanceof UserRejectedRequestError);
    if (rejected) {
      return CancelError.from(rejected);
    }
  }
  if (err instanceof UserRejectedRequestError) {
    return CancelError.from(err);
  }
  return SigningError.from(err);
}

/**
 * Broadcast a single transaction with a connected viem wallet and
 * wait for it to be mined. Returns the resulting tx hash or a typed
 * error.
 *
 * @internal
 */
function sendSingleTransaction(
  walletClient: ConnectedWalletClient,
  request: TransactionRequest,
  confirmations: number,
): ResultAsync<`0x${string}`, CancelError | SigningError | TransactionError | UnexpectedError> {
  return estimateGas(walletClient, request)
    .andThen((gas) =>
      ResultAsync.fromPromise(
        sendTransactionWithViem(walletClient, {
          account: walletClient.account,
          chain: walletClient.chain,
          to: request.to,
          data: request.data,
          value: request.value,
          gas,
        }),
        mapSendError,
      ),
    )
    .andThen((hash) =>
      ResultAsync.fromPromise(
        waitForTransactionReceipt(walletClient, {
          hash,
          confirmations,
        }),
        (err) => UnexpectedError.from(err),
      ).andThen((receipt) => {
        if (receipt.status === 'reverted') {
          const explorer = walletClient.chain.blockExplorers?.default?.url;
          const link = explorer
            ? new URL(`/tx/${receipt.transactionHash}`, explorer).toString()
            : undefined;
          return errAsync(
            TransactionError.from({
              txHash: receipt.transactionHash,
              link,
            }),
          );
        }
        return okAsync(receipt.transactionHash);
      }),
    );
}

function buildExecutor(
  walletClient: ConnectedWalletClient,
  confirmations: number,
): SingleTxExecutor {
  return (tx) => sendSingleTransaction(walletClient, tx, confirmations);
}

/**
 * Options accepted by {@link sendWith}.
 */
export type SendWithOptions = {
  /**
   * Override the number of confirmations the adapter waits for
   * after each transaction. Defaults to `1`, matching the Osero
   * client's default.
   */
  readonly confirmations?: number;
};

/**
 * Turn an {@link ExecutionPlan} into a concrete sequence of viem
 * `sendTransaction` calls bound to `walletClient`. Every tx in the
 * plan is broadcast in order; the adapter waits for each receipt
 * before starting the next one.
 *
 * Two usage modes:
 *
 * - **Curried** (the common form — pipe it into `.andThen`):
 *
 *   ```ts
 *   import { sendWith } from '@osero/client/viem';
 *
 *   const result = await mintUsds(client, request)
 *     .andThen(sendWith(wallet));
 *   ```
 *
 * - **Direct** (for eagerly-obtained plans):
 *
 *   ```ts
 *   const plan = await mintUsds(client, request);
 *   if (plan.isOk()) {
 *     const result = await sendWith(wallet, plan.value);
 *   }
 *   ```
 *
 * @throws if `walletClient.account` or `walletClient.chain` is
 *   missing — viem wallet clients must be bound to both before being
 *   passed to the adapter.
 */
export function sendWith(
  walletClient: WalletClient,
  options?: SendWithOptions,
): ExecutionPlanHandler;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  walletClient: WalletClient,
  plan: T,
  options?: SendWithOptions,
): ReturnType<ExecutionPlanHandler<T>>;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  walletClient: WalletClient,
  planOrOptions?: T | SendWithOptions,
  maybeOptions?: SendWithOptions,
):
  | ExecutionPlanHandler<T>
  | ResultAsync<
      TransactionResult,
      CancelError | SigningError | TransactionError | UnexpectedError
    > {
  if (!hasConnectedAccount(walletClient)) {
    throw new Error(
      'sendWith requires a viem WalletClient with both `account` and `chain` configured',
    );
  }

  const isPlan =
    typeof planOrOptions === 'object' && planOrOptions !== null && '__typename' in planOrOptions;

  const options = (isPlan ? maybeOptions : planOrOptions) as SendWithOptions | undefined;
  const confirmations = options?.confirmations ?? 1;
  const executor = buildExecutor(walletClient, confirmations);

  if (isPlan) {
    return runExecutionPlan(planOrOptions as T, executor);
  }
  return (plan: T) => runExecutionPlan(plan, executor);
}
