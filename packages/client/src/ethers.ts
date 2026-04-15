import { isError, type Signer, type TransactionResponse } from 'ethers';

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
 * Verify that a signer is pointing at the chain a transaction
 * requires. The ethers adapter is intentionally stricter than the
 * viem one: viem can hot-switch chains for us, but ethers signers
 * are usually bound to a single provider, so we error out instead
 * of auto-switching.
 *
 * @internal
 */
function ensureChain(
  signer: Signer,
  request: TransactionRequest,
): ResultAsync<Signer, UnexpectedError> {
  if (!signer.provider) {
    return errAsync(
      new UnexpectedError(
        'ethers Signer is detached — it must have a provider attached to send transactions',
      ),
    );
  }
  return ResultAsync.fromPromise(signer.provider.getNetwork(), (err) =>
    UnexpectedError.from(err),
  ).andThen((network) => {
    const current = Number(network.chainId);
    if (current !== request.chainId) {
      return errAsync(
        new UnexpectedError(
          `ethers Signer is on chain ${current} but the transaction targets chain ${request.chainId}`,
        ),
      );
    }
    return okAsync(signer);
  });
}

/**
 * Translate an ethers error into the corresponding Osero error.
 *
 * @internal
 */
function mapSendError(err: unknown): CancelError | SigningError {
  if (isError(err, 'ACTION_REJECTED')) {
    return CancelError.from(err);
  }
  return SigningError.from(err);
}

/**
 * Broadcast a single transaction through an ethers signer and wait
 * for it to be mined.
 *
 * @internal
 */
function sendSingleTransaction(
  signer: Signer,
  request: TransactionRequest,
  confirmations: number,
): ResultAsync<`0x${string}`, CancelError | SigningError | TransactionError | UnexpectedError> {
  return ensureChain(signer, request)
    .andThen(() =>
      ResultAsync.fromPromise(
        signer.sendTransaction({
          to: request.to,
          data: request.data,
          value: request.value,
          from: request.from,
        }),
        mapSendError,
      ),
    )
    .andThen((response: TransactionResponse) =>
      ResultAsync.fromPromise(response.wait(confirmations), (err) =>
        UnexpectedError.from(err),
      ).andThen((receipt) => {
        if (!receipt) {
          return errAsync(
            UnexpectedError.from(new Error(`ethers wait() returned null for tx ${response.hash}`)),
          );
        }
        if (receipt.status === 0) {
          return errAsync(
            TransactionError.from({
              txHash: receipt.hash as `0x${string}`,
            }),
          );
        }
        return okAsync(receipt.hash as `0x${string}`);
      }),
    );
}

function buildExecutor(signer: Signer, confirmations: number): SingleTxExecutor {
  return (tx) => sendSingleTransaction(signer, tx, confirmations);
}

/**
 * Options accepted by {@link sendWith}.
 */
export type SendWithOptions = {
  /**
   * Override the number of confirmations the adapter waits for
   * after each transaction.
   *
   * @defaultValue 1
   */
  readonly confirmations?: number;
};

/**
 * Turn an {@link ExecutionPlan} into a concrete sequence of
 * `signer.sendTransaction` calls bound to the supplied ethers v6
 * signer. Every tx in the plan is broadcast in order; the adapter
 * waits for each receipt before starting the next one.
 *
 * ```ts
 * import { sendWith } from '@osero/client/ethers';
 * import { JsonRpcProvider, Wallet } from 'ethers';
 *
 * const provider = new JsonRpcProvider('https://...');
 * const signer = new Wallet(PRIVATE_KEY, provider);
 *
 * const result = await mintUsds(client, request).andThen(sendWith(signer));
 * ```
 *
 * Unlike the viem adapter, this one does **not** switch chains for
 * the caller. The signer must already be connected to the chain
 * that the plan targets; if it isn't, the first step short-circuits
 * with {@link UnexpectedError}.
 */
export function sendWith(signer: Signer, options?: SendWithOptions): ExecutionPlanHandler;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  signer: Signer,
  plan: T,
  options?: SendWithOptions,
): ReturnType<ExecutionPlanHandler<T>>;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  signer: Signer,
  planOrOptions?: T | SendWithOptions,
  maybeOptions?: SendWithOptions,
):
  | ExecutionPlanHandler<T>
  | ResultAsync<
      TransactionResult,
      CancelError | SigningError | TransactionError | UnexpectedError
    > {
  const isPlan =
    typeof planOrOptions === 'object' && planOrOptions !== null && '__typename' in planOrOptions;

  const options = (isPlan ? maybeOptions : planOrOptions) as SendWithOptions | undefined;
  const confirmations = options?.confirmations ?? 1;
  const executor = buildExecutor(signer, confirmations);

  if (isPlan) {
    return runExecutionPlan(planOrOptions as T, executor);
  }
  return (plan: T) => runExecutionPlan(plan, executor);
}
