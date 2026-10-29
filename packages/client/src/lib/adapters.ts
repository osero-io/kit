import type { Hex } from 'viem';

import {
  ProgressCallbackError,
  UnsupportedCapabilityError,
  type ExecutionFailureContext,
  type ExecutionStage,
} from './errors.js';
import { resumeExecutionPlan } from './plan.js';
import { err, ok, ResultAsync, type Result } from './result.js';
import type {
  ConfirmationOptions,
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutionProgress,
  ExecutorCapabilities,
  SendWithError,
  TransactionConfirmation,
  TransactionRequest,
  TransactionResult,
} from './types.js';
import { validateConfirmations, validateExecutionPlan } from './validation.js';

export type SingleTransactionResult = {
  readonly submittedHash: Hex;
  readonly hash: Hex;
  readonly replacement?: ConfirmedTransaction['replacement'];
  readonly confirmation: TransactionConfirmation;
};

export type SingleTransactionContext = {
  readonly planId: string;
  readonly stepIndex: number;
  readonly confirmations: number;
  readonly completed: readonly ConfirmedTransaction[];
  notifySubmitted(hash: Hex): Promise<void>;
  failure(stage: ExecutionStage, hash?: Hex): ExecutionFailureContext;
};

export type SingleTxExecutor = (
  transaction: TransactionRequest,
  context: SingleTransactionContext,
) => ResultAsync<SingleTransactionResult, SendWithError>;

export function preflightExecutorCapabilities(
  plan: ExecutionPlan,
  capabilities: ExecutorCapabilities,
): Result<void, UnsupportedCapabilityError> {
  if (plan.requirements.execution === 'atomic-batch' && !capabilities.atomicBatch) {
    return err(new UnsupportedCapabilityError('atomic-batch', capabilities.name));
  }
  if (plan.requirements.authorization === 'permit' && !capabilities.permitAuthorization) {
    return err(new UnsupportedCapabilityError('permit-authorization', capabilities.name));
  }
  if (plan.requirements.sponsored && !capabilities.sponsoredTransactions) {
    return err(new UnsupportedCapabilityError('sponsored-transactions', capabilities.name));
  }
  if (plan.requirements.chainTransitions && capabilities.chainSwitching === 'none') {
    return err(new UnsupportedCapabilityError('chain-transitions', capabilities.name));
  }
  return ok(undefined);
}

export function runExecutionPlan(
  plan: ExecutionPlan,
  execute: SingleTxExecutor,
  capabilities: ExecutorCapabilities,
  options: ConfirmationOptions = {},
): ResultAsync<TransactionResult, SendWithError> {
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return new ResultAsync(Promise.resolve(err(validated.error)));
  const confirmationCount = validateConfirmations(options.confirmations ?? 1);
  if (confirmationCount.isErr()) {
    return new ResultAsync(Promise.resolve(err(confirmationCount.error)));
  }
  const capabilityCheck = preflightExecutorCapabilities(validated.value, capabilities);
  if (capabilityCheck.isErr()) {
    return new ResultAsync(Promise.resolve(err(capabilityCheck.error)));
  }
  const resumed = resumeExecutionPlan(validated.value, options.resume);
  if (resumed.isErr()) return new ResultAsync(Promise.resolve(err(resumed.error)));

  const execution = async (): Promise<Result<TransactionResult, SendWithError>> => {
    const confirmed = [...resumed.value.confirmed];
    const progressFailures: unknown[] = [];
    const emit = async (event: ExecutionProgress): Promise<void> => {
      if (options.onProgress === undefined) return;
      try {
        await options.onProgress(event);
      } catch (cause) {
        progressFailures.push(cause);
      }
    };

    const firstPendingIndex = confirmed.length;
    const contextFor = (step: TransactionRequest, stepIndex: number): SingleTransactionContext => ({
      planId: validated.value.id,
      stepIndex,
      confirmations: confirmationCount.value,
      completed: confirmed,
      notifySubmitted: async (hash) => {
        await emit({
          type: 'step-submitted',
          planId: validated.value.id,
          stepId: step.id,
          stepIndex,
          operation: step.operation,
          hash,
        });
      },
      failure: (stage, hash) => ({
        planId: validated.value.id,
        stepId: step.id,
        stepIndex,
        operation: step.operation,
        stage,
        ...(hash === undefined ? {} : { hash }),
        completed: confirmed.map((transaction) => ({
          planId: transaction.planId,
          stepId: transaction.stepId,
          stepIndex: transaction.stepIndex,
          operation: transaction.operation,
          hash: transaction.hash,
        })),
      }),
    });

    const preflightStep =
      validated.value.steps[firstPendingIndex] ??
      validated.value.steps[validated.value.steps.length - 1]!;
    await emit({
      type: 'preflight-complete',
      planId: validated.value.id,
      totalSteps: validated.value.steps.length,
      resumedSteps: confirmed.length,
    });
    if (progressFailures.length > 0) {
      return err(
        ProgressCallbackError.from(
          progressFailures[0],
          contextFor(
            preflightStep,
            Math.min(firstPendingIndex, validated.value.steps.length - 1),
          ).failure('progress'),
        ),
      );
    }

    // oxlint-disable no-await-in-loop -- Plans and progress callbacks must complete in order.
    for (let index = firstPendingIndex; index < validated.value.steps.length; index += 1) {
      const step = validated.value.steps[index]!;
      const context = contextFor(step, index);
      await emit({
        type: 'step-started',
        planId: validated.value.id,
        stepId: step.id,
        stepIndex: index,
        operation: step.operation,
      });
      if (progressFailures.length > 0) {
        return err(ProgressCallbackError.from(progressFailures[0], context.failure('progress')));
      }

      const sent = await execute(step, context);
      if (sent.isErr()) return err(sent.error);

      const transaction: ConfirmedTransaction = {
        planId: validated.value.id,
        stepId: step.id,
        stepIndex: index,
        operation: step.operation,
        submittedHash: sent.value.submittedHash,
        hash: sent.value.hash,
        ...(sent.value.replacement === undefined ? {} : { replacement: sent.value.replacement }),
        confirmation: sent.value.confirmation,
      };
      confirmed.push(transaction);
      await emit({ type: 'step-confirmed', transaction });
      if (progressFailures.length > 0) {
        return err(
          ProgressCallbackError.from(
            progressFailures[0],
            contextFor(step, index).failure('progress'),
          ),
        );
      }
    }
    // oxlint-enable no-await-in-loop

    const last = confirmed[confirmed.length - 1]!;
    const result: TransactionResult = {
      planId: validated.value.id,
      transactions: confirmed,
      txHash: last.hash,
    };
    await emit({ type: 'plan-completed', result });
    if (progressFailures.length > 0) {
      const lastStep = validated.value.steps[validated.value.steps.length - 1]!;
      return err(
        ProgressCallbackError.from(
          progressFailures[0],
          contextFor(lastStep, validated.value.steps.length - 1).failure('progress'),
        ),
      );
    }
    return ok(result);
  };

  return new ResultAsync(execution());
}
