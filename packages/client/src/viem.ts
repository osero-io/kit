import {
  concat,
  type Account,
  type Chain,
  type Hex,
  type Transport,
  TransactionExecutionError,
  UserRejectedRequestError,
  type WalletClient,
} from 'viem';
import {
  estimateGas as estimateGasWithViem,
  getTransactionReceipt,
  sendTransaction as sendTransactionWithViem,
} from 'viem/actions';

import {
  preflightExecutorCapabilities,
  runExecutionPlan,
  toCompletedExecutionStep,
  type SingleTransactionContext,
  type SingleTransactionResult,
  type SingleTxExecutor,
} from './lib/adapters.js';
import {
  BroadcastError,
  CancelError,
  ConfigurationError,
  ConfirmationError,
  SigningError,
  SimulationError,
  TransactionError,
  ValidationError,
} from './lib/errors.js';
import { checkExecutionPlanExpiry } from './lib/plan.js';
import { err, errAsync, ok, ResultAsync, type Result } from './lib/result.js';
import { observeResult } from './lib/telemetry.js';
import type {
  ConfirmationOptions,
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutorCapabilities,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';
import {
  validateConfirmations,
  validateExecutorBinding,
  validateResumeState,
} from './lib/validation.js';
import { nonRepricedReplacementError, waitForViemReceipt } from './lib/viemReceipt.js';

export type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

export const VIEM_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
  name: 'viem',
  sequentialTransactions: true,
  atomicBatch: false,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'independent-steps',
};

export type SendWithOptions = ConfirmationOptions & {
  /** Fresh viem estimation is always used; advisory plan estimates never become gas limits. */
  readonly gasBufferBps?: number;
  readonly confirmationTimeoutMs?: number;
};

type ResolvedOptions = SendWithOptions & {
  readonly confirmations: number;
  readonly gasBufferBps: number;
};

function hasConnectedAccount(walletClient: WalletClient): walletClient is ConnectedWalletClient {
  return walletClient.account !== undefined && walletClient.chain !== undefined;
}

function resolveOptions(
  options: SendWithOptions | undefined,
): Result<ResolvedOptions, ValidationError> {
  const confirmations = validateConfirmations(options?.confirmations ?? 1);
  if (confirmations.isErr()) return err(confirmations.error);
  const gasBufferBps = options?.gasBufferBps ?? 1_500;
  if (!Number.isSafeInteger(gasBufferBps) || gasBufferBps < 0 || gasBufferBps > 10_000) {
    return err(
      ValidationError.forField('gasBufferBps', 'gasBufferBps must be an integer in [0, 10000]'),
    );
  }
  if (
    options?.confirmationTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.confirmationTimeoutMs) || options.confirmationTimeoutMs <= 0)
  ) {
    return err(
      ValidationError.forField(
        'confirmationTimeoutMs',
        'confirmationTimeoutMs must be a positive safe integer',
      ),
    );
  }
  if (options?.onProgress !== undefined && typeof options.onProgress !== 'function') {
    return err(ValidationError.forField('onProgress', 'onProgress must be a function'));
  }
  return ok({ ...options, confirmations: confirmations.value, gasBufferBps });
}

/**
 * The calldata viem broadcasts for `data` from this client. Since 2.45.0,
 * viem's `sendTransaction` appends the client's `dataSuffix` (how ERC-8021
 * builder codes are attached), in its string or `{ value }` form. A repricing
 * re-sends that calldata, so it is what the replacement is compared with.
 * Older viem has no such field and appends nothing. The adapter never passes
 * the per-call `dataSuffix`, which would take precedence.
 */
function broadcastCalldata(walletClient: WalletClient, data: Hex): Hex {
  const { dataSuffix } = walletClient as { readonly dataSuffix?: unknown };
  const suffix =
    typeof dataSuffix === 'object' && dataSuffix !== null
      ? (dataSuffix as { readonly value?: unknown }).value
      : dataSuffix;
  return typeof suffix === 'string' ? concat([data, suffix as Hex]) : data;
}

function sendSingleTransaction(
  walletClient: ConnectedWalletClient,
  plan: ExecutionPlan,
  request: TransactionRequest,
  context: SingleTransactionContext,
  options: ResolvedOptions,
): ResultAsync<SingleTransactionResult, SendWithError> {
  return ResultAsync.fromPromise(
    estimateGasWithViem(walletClient, {
      account: walletClient.account,
      to: request.to,
      data: request.data,
      value: request.value,
    }),
    (cause) => SimulationError.from(cause, context.failure('simulation')),
  )
    .map((gas) => {
      const numerator = gas * BigInt(10_000 + options.gasBufferBps);
      return (numerator + 9_999n) / 10_000n;
    })
    .andThen((gas) => {
      const expiry = checkExecutionPlanExpiry(plan, context.failure('preflight'));
      if (expiry.isErr()) return errAsync(expiry.error);
      return ResultAsync.fromPromise(
        sendTransactionWithViem(walletClient, {
          account: walletClient.account,
          chain: walletClient.chain,
          to: request.to,
          data: request.data,
          value: request.value,
          gas,
        }),
        (cause) => mapSendError(cause, context),
      );
    })
    .andThen((submittedHash) => {
      const confirmation = async (): Promise<SingleTransactionResult> => {
        await context.notifySubmitted(submittedHash);
        const { receipt, replacement } = await waitForViemReceipt(walletClient, {
          hash: submittedHash,
          confirmations: context.confirmations,
          submitted: {
            from: walletClient.account.address,
            to: request.to,
            data: broadcastCalldata(walletClient, request.data),
            value: request.value,
          },
          ...(options.confirmationTimeoutMs === undefined
            ? {}
            : { timeout: options.confirmationTimeoutMs }),
        });
        // A cancellation, or a different transaction reusing the nonce, is not this
        // plan step. Continuing would broadcast later steps on top of a step that
        // never executed, so only a same-transaction fee bump counts as confirmed.
        if (replacement !== undefined && replacement !== 'repriced') {
          throw nonRepricedReplacementError(
            submittedHash,
            replacement,
            receipt.transactionHash,
            context.failure('replacement', submittedHash),
          );
        }
        if (receipt.status === 'reverted') {
          throw new TransactionError(
            `Transaction ${receipt.transactionHash} reverted`,
            receipt.transactionHash,
            context.failure('revert', receipt.transactionHash),
          );
        }
        const effectiveHash = receipt.transactionHash;
        return {
          submittedHash,
          hash: effectiveHash,
          ...(replacement === undefined
            ? {}
            : {
                replacement: {
                  reason: replacement,
                  originalHash: submittedHash,
                  replacementHash: effectiveHash,
                },
              }),
          confirmation: {
            status: 'success',
            transactionHash: effectiveHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
            confirmations: context.confirmations,
          },
        };
      };

      return ResultAsync.fromPromise(confirmation(), (cause) => {
        if (cause instanceof ConfirmationError || cause instanceof TransactionError) return cause;
        return ConfirmationError.from(cause, context.failure('confirmation', submittedHash));
      });
    });
}

function mapSendError(
  cause: unknown,
  context: SingleTransactionContext,
): CancelError | SigningError | BroadcastError {
  if (cause instanceof TransactionExecutionError) {
    const rejected = cause.walk((inner) => inner instanceof UserRejectedRequestError);
    if (rejected) return CancelError.from(rejected, context.failure('signing'));
    return BroadcastError.from(cause, context.failure('broadcast'));
  }
  if (cause instanceof UserRejectedRequestError) {
    return CancelError.from(cause, context.failure('signing'));
  }
  return SigningError.from(cause, context.failure('signing'));
}

function verifyResumeReceipts(
  walletClient: ConnectedWalletClient,
  plan: ExecutionPlan,
  options: ResolvedOptions,
): ResultAsync<void, SendWithError> {
  const resume = validateResumeState(plan, options.resume);
  if (resume.isErr()) return errAsync(resume.error);

  const verification = async (): Promise<Result<void, SendWithError>> => {
    // oxlint-disable no-await-in-loop -- Validate the confirmed prefix in deterministic order.
    for (const transaction of resume.value) {
      const step = plan.steps[transaction.stepIndex]!;
      const context: SingleTransactionContext = {
        planId: plan.id,
        stepIndex: transaction.stepIndex,
        confirmations: options.confirmations,
        completed: resume.value.slice(0, transaction.stepIndex),
        notifySubmitted: async () => undefined,
        failure: (stage, hash) => ({
          planId: plan.id,
          stepId: step.id,
          stepIndex: transaction.stepIndex,
          operation: step.operation,
          stage,
          ...(hash === undefined ? {} : { hash }),
          completed: resume.value.slice(0, transaction.stepIndex).map(toCompletedExecutionStep),
        }),
      };
      const receipt = await ResultAsync.fromPromise(
        getTransactionReceipt(walletClient, { hash: transaction.hash }),
        (cause) => ConfirmationError.from(cause, context.failure('confirmation', transaction.hash)),
      );
      if (receipt.isErr()) return err(receipt.error);
      if (
        receipt.value.status !== 'success' ||
        receipt.value.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()
      ) {
        return err(
          new ConfirmationError(
            `Resume proof for step ${step.id} is not a successful matching receipt`,
            context.failure('confirmation', transaction.hash),
          ),
        );
      }
    }
    // oxlint-enable no-await-in-loop
    return ok(undefined);
  };

  return new ResultAsync(verification());
}

function executePlan(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  const resolvedOptions = resolveOptions(options);
  if (resolvedOptions.isErr()) return errAsync(resolvedOptions.error);
  if (!hasConnectedAccount(walletClient)) {
    return errAsync(
      new ConfigurationError(
        'sendWith requires a viem WalletClient with both account and chain configured',
        'walletClient',
      ),
    );
  }
  const binding = validateExecutorBinding(
    plan,
    walletClient.account.address,
    walletClient.chain.id,
  );
  if (binding.isErr()) return errAsync(binding.error);
  const capability = preflightExecutorCapabilities(binding.value, VIEM_EXECUTOR_CAPABILITIES);
  if (capability.isErr()) return errAsync(capability.error);

  return verifyResumeReceipts(walletClient, binding.value, resolvedOptions.value).andThen(() => {
    const executor: SingleTxExecutor = (transaction, context) =>
      sendSingleTransaction(
        walletClient,
        binding.value,
        transaction,
        context,
        resolvedOptions.value,
      );
    return runExecutionPlan(
      binding.value,
      executor,
      VIEM_EXECUTOR_CAPABILITIES,
      resolvedOptions.value,
    );
  });
}

export function sendWith(
  walletClient: WalletClient,
  options?: SendWithOptions,
): ExecutionPlanHandler;
export function sendWith(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError>;
export function sendWith(
  walletClient: WalletClient,
  planOrOptions?: ExecutionPlan | SendWithOptions,
  maybeOptions?: SendWithOptions,
): ExecutionPlanHandler | ResultAsync<TransactionResult, SendWithError> {
  const isPlan =
    typeof planOrOptions === 'object' &&
    planOrOptions !== null &&
    '__typename' in planOrOptions &&
    planOrOptions.__typename === 'ExecutionPlan';
  if (isPlan) return observedExecutePlan(walletClient, planOrOptions, maybeOptions);
  const options = planOrOptions as SendWithOptions | undefined;
  return (plan) => observedExecutePlan(walletClient, plan, options);
}

function observedExecutePlan(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  return observeResult(executePlan(walletClient, plan, options), {
    operation: 'viem.sendWith',
    executor: 'viem',
    ...(plan?.steps?.[0]?.chainId === undefined ? {} : { chainId: plan.steps[0].chainId }),
  });
}
