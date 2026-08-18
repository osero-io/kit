import { isError, type Signer, type TransactionReceipt, type TransactionResponse } from 'ethers';

import {
  preflightExecutorCapabilities,
  runExecutionPlan,
  type SingleTransactionContext,
  type SingleTransactionResult,
  type SingleTxExecutor,
} from './lib/adapters.js';
import {
  BroadcastError,
  CancelError,
  ConfigurationError,
  ConfirmationError,
  RpcError,
  SigningError,
  SimulationError,
  TransactionError,
  ValidationError,
} from './lib/errors.js';
import { checkExecutionPlanExpiry } from './lib/plan.js';
import { err, errAsync, ok, ResultAsync, type Result } from './lib/result.js';
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

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const ETHERS_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
  name: 'ethers',
  sequentialTransactions: true,
  atomicBatch: false,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'independent-steps',
};

export type SendWithOptions = ConfirmationOptions & {
  readonly gasBufferBps?: number;
  readonly confirmationTimeoutMs?: number;
};

type ResolvedOptions = SendWithOptions & {
  readonly confirmations: number;
  readonly gasBufferBps: number;
};

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

function sendSingleTransaction(
  signer: Signer,
  plan: ExecutionPlan,
  request: TransactionRequest,
  context: SingleTransactionContext,
  options: ResolvedOptions,
): ResultAsync<SingleTransactionResult, SendWithError> {
  const transaction = {
    to: request.to,
    data: request.data,
    value: request.value,
    from: request.from,
  };

  return ResultAsync.fromPromise(signer.estimateGas(transaction), (cause) =>
    SimulationError.from(cause, context.failure('simulation')),
  )
    .map((gas) => {
      const numerator = gas * BigInt(10_000 + options.gasBufferBps);
      return (numerator + 9_999n) / 10_000n;
    })
    .andThen((gasLimit) => {
      const expiry = checkExecutionPlanExpiry(plan);
      if (expiry.isErr()) return errAsync(expiry.error);
      return ResultAsync.fromPromise(
        signer.sendTransaction({ ...transaction, gasLimit }),
        (cause) => mapSendError(cause, context),
      );
    })
    .andThen((response) => waitForEthersReceipt(response, context, options));
}

function mapSendError(
  cause: unknown,
  context: SingleTransactionContext,
): CancelError | SigningError | BroadcastError {
  if (isError(cause, 'ACTION_REJECTED')) {
    return CancelError.from(cause, context.failure('signing'));
  }
  if (
    isError(cause, 'INSUFFICIENT_FUNDS') ||
    isError(cause, 'NONCE_EXPIRED') ||
    isError(cause, 'REPLACEMENT_UNDERPRICED') ||
    isError(cause, 'NETWORK_ERROR') ||
    isError(cause, 'SERVER_ERROR')
  ) {
    return BroadcastError.from(cause, context.failure('broadcast'));
  }
  return SigningError.from(cause, context.failure('signing'));
}

function waitForEthersReceipt(
  response: TransactionResponse,
  context: SingleTransactionContext,
  options: ResolvedOptions,
): ResultAsync<SingleTransactionResult, SendWithError> {
  if (!HASH_PATTERN.test(response.hash)) {
    return errAsync(
      new BroadcastError(
        'ethers returned a malformed transaction hash',
        context.failure('broadcast'),
      ),
    );
  }
  const submittedHash = response.hash as `0x${string}`;
  const wait = async (): Promise<SingleTransactionResult> => {
    await context.notifySubmitted(submittedHash);
    let receipt: TransactionReceipt | null;
    let replacement: SingleTransactionResult['replacement'];
    try {
      receipt = await response.wait(context.confirmations, options.confirmationTimeoutMs ?? 0);
    } catch (cause) {
      if (!isError(cause, 'TRANSACTION_REPLACED')) throw cause;
      if (cause.reason !== 'repriced' || cause.cancelled) {
        throw new ConfirmationError(
          `Transaction ${submittedHash} was ${cause.reason} and cannot be treated as this plan step`,
          context.failure('replacement', submittedHash),
          { cause },
        );
      }
      receipt = cause.receipt;
      const replacementHash = receipt.hash as `0x${string}`;
      replacement = {
        reason: cause.reason,
        originalHash: submittedHash,
        replacementHash,
      };
    }
    if (receipt === null) {
      throw new ConfirmationError(
        `ethers wait() returned null for transaction ${submittedHash}`,
        context.failure('confirmation', submittedHash),
      );
    }
    const effectiveHash = receipt.hash as `0x${string}`;
    if (!HASH_PATTERN.test(effectiveHash)) {
      throw new ConfirmationError(
        'ethers returned a receipt with a malformed transaction hash',
        context.failure('confirmation', submittedHash),
      );
    }
    if (receipt.status === 0) {
      throw new TransactionError(
        `Transaction ${effectiveHash} reverted`,
        effectiveHash,
        context.failure('revert', effectiveHash),
      );
    }
    return {
      submittedHash,
      hash: effectiveHash,
      ...(replacement === undefined ? {} : { replacement }),
      confirmation: {
        status: 'success',
        transactionHash: effectiveHash,
        blockNumber: BigInt(receipt.blockNumber),
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.gasPrice,
        confirmations: context.confirmations,
      },
    };
  };

  return ResultAsync.fromPromise(wait(), (cause) => {
    if (cause instanceof ConfirmationError || cause instanceof TransactionError) return cause;
    return ConfirmationError.from(cause, context.failure('confirmation', submittedHash));
  });
}

function verifyResumeReceipts(
  signer: Signer,
  plan: ExecutionPlan,
  options: ResolvedOptions,
): ResultAsync<void, SendWithError> {
  const resume = validateResumeState(plan, options.resume);
  if (resume.isErr()) return errAsync(resume.error);
  if (signer.provider === null) {
    return errAsync(
      new ConfigurationError('ethers Signer must have a provider attached', 'signer.provider'),
    );
  }

  const verification = async (): Promise<Result<void, SendWithError>> => {
    // oxlint-disable no-await-in-loop -- Validate the confirmed prefix in deterministic order.
    for (const transaction of resume.value) {
      const step = plan.steps[transaction.stepIndex]!;
      const completed = resume.value.slice(0, transaction.stepIndex);
      const execution = {
        planId: plan.id,
        stepId: step.id,
        stepIndex: transaction.stepIndex,
        operation: step.operation,
        stage: 'confirmation' as const,
        hash: transaction.hash,
        completed: completed.map((value) => ({
          planId: value.planId,
          stepId: value.stepId,
          stepIndex: value.stepIndex,
          operation: value.operation,
          hash: value.hash,
        })),
      };
      const receipt = await ResultAsync.fromPromise(
        signer.provider!.getTransactionReceipt(transaction.hash),
        (cause) => ConfirmationError.from(cause, execution),
      );
      if (receipt.isErr()) return err(receipt.error);
      if (
        receipt.value === null ||
        receipt.value.status !== 1 ||
        receipt.value.hash.toLowerCase() !== transaction.hash.toLowerCase()
      ) {
        return err(
          new ConfirmationError(
            `Resume proof for step ${step.id} is not a successful matching receipt`,
            execution,
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
  signer: Signer,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  const resolvedOptions = resolveOptions(options);
  if (resolvedOptions.isErr()) return errAsync(resolvedOptions.error);
  if (signer.provider === null) {
    return errAsync(
      new ConfigurationError('ethers Signer must have a provider attached', 'signer.provider'),
    );
  }

  const preflight = async (): Promise<Result<ExecutionPlan, SendWithError>> => {
    const [account, network] = await Promise.all([
      ResultAsync.fromPromise(
        signer.getAddress(),
        (cause) =>
          new ConfigurationError('Could not resolve ethers signer account', 'signer', { cause }),
      ),
      ResultAsync.fromPromise(signer.provider!.getNetwork(), (cause) =>
        RpcError.from({
          cause,
          operation: 'getNetwork',
          chainId: plan.steps[0]?.chainId ?? 0,
        }),
      ),
    ]);
    if (account.isErr()) return err(account.error);
    if (network.isErr()) return err(network.error as SendWithError);
    const chainId = Number(network.value.chainId);
    const binding = validateExecutorBinding(plan, account.value as `0x${string}`, chainId);
    if (binding.isErr()) return err(binding.error);
    const capability = preflightExecutorCapabilities(binding.value, ETHERS_EXECUTOR_CAPABILITIES);
    if (capability.isErr()) return err(capability.error);
    return ok(binding.value);
  };

  return new ResultAsync(preflight()).andThen((validatedPlan) =>
    verifyResumeReceipts(signer, validatedPlan, resolvedOptions.value).andThen(() => {
      const executor: SingleTxExecutor = (transaction, context) =>
        sendSingleTransaction(signer, validatedPlan, transaction, context, resolvedOptions.value);
      return runExecutionPlan(
        validatedPlan,
        executor,
        ETHERS_EXECUTOR_CAPABILITIES,
        resolvedOptions.value,
      );
    }),
  );
}

export function sendWith(signer: Signer, options?: SendWithOptions): ExecutionPlanHandler;
export function sendWith(
  signer: Signer,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError>;
export function sendWith(
  signer: Signer,
  planOrOptions?: ExecutionPlan | SendWithOptions,
  maybeOptions?: SendWithOptions,
): ExecutionPlanHandler | ResultAsync<TransactionResult, SendWithError> {
  const isPlan =
    typeof planOrOptions === 'object' &&
    planOrOptions !== null &&
    '__typename' in planOrOptions &&
    planOrOptions.__typename === 'ExecutionPlan';
  if (isPlan) return executePlan(signer, planOrOptions, maybeOptions);
  const options = planOrOptions as SendWithOptions | undefined;
  return (plan) => executePlan(signer, plan, options);
}
