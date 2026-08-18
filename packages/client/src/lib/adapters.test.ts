import { vi } from 'vitest';

import {
  runExecutionPlan,
  type SingleTransactionResult,
  type SingleTxExecutor,
} from './adapters.js';
import {
  CancelError,
  ConfirmationError,
  ProgressCallbackError,
  UnsupportedCapabilityError,
} from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import { errAsync, okAsync } from './result.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutorCapabilities,
  TransactionRequest,
} from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;

const CAPABILITIES: ExecutorCapabilities = {
  name: 'test',
  sequentialTransactions: true,
  atomicBatch: false,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'none',
};

function step(id: string): TransactionRequest {
  const result = createTransactionRequest({
    id,
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

function plan(requirements?: ExecutionPlan['requirements']): ExecutionPlan {
  const result = createExecutionPlan({
    steps: [step('one'), step('two'), step('three')],
    ...(requirements === undefined ? {} : { requirements }),
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

function hash(index: number): `0x${string}` {
  return `0x${String(index).repeat(64)}`;
}

function sent(index: number, confirmations = 1): SingleTransactionResult {
  const transactionHash = hash(index);
  return {
    submittedHash: transactionHash,
    hash: transactionHash,
    confirmation: {
      status: 'success',
      transactionHash,
      confirmations,
    },
  };
}

function confirmed(valuePlan: ExecutionPlan, index: number): ConfirmedTransaction {
  const transactionHash = hash(index + 1);
  const valueStep = valuePlan.steps[index]!;
  return {
    planId: valuePlan.id,
    stepId: valueStep.id,
    stepIndex: index,
    operation: valueStep.operation,
    submittedHash: transactionHash,
    hash: transactionHash,
    confirmation: {
      status: 'success',
      transactionHash,
      confirmations: 1,
    },
  };
}

describe('runExecutionPlan', () => {
  it('returns every hash in exact execution order and emits progress', async () => {
    const valuePlan = plan();
    const events: string[] = [];
    let index = 0;
    const executor = vi.fn<SingleTxExecutor>((_transaction, context) => {
      index += 1;
      void context.notifySubmitted(hash(index));
      return okAsync(sent(index, context.confirmations));
    });

    const result = await runExecutionPlan(valuePlan, executor, CAPABILITIES, {
      confirmations: 2,
      onProgress(progress) {
        events.push(progress.type);
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions.map((transaction) => transaction.hash)).toEqual([
        hash(1),
        hash(2),
        hash(3),
      ]);
      expect(result.value.txHash).toBe(hash(3));
      expect(
        result.value.transactions.every(
          (transaction) => transaction.confirmation.confirmations === 2,
        ),
      ).toBe(true);
    }
    expect(events).toEqual([
      'preflight-complete',
      'step-started',
      'step-submitted',
      'step-confirmed',
      'step-started',
      'step-submitted',
      'step-confirmed',
      'step-started',
      'step-submitted',
      'step-confirmed',
      'plan-completed',
    ]);
  });

  it('preserves completed steps and current hash when a later confirmation fails', async () => {
    const valuePlan = plan();
    let index = 0;
    const executor = vi.fn<SingleTxExecutor>((_transaction, context) => {
      index += 1;
      if (index === 2) {
        return errAsync(
          new ConfirmationError('receipt timed out', context.failure('confirmation', hash(index))),
        );
      }
      return okAsync(sent(index));
    });

    const result = await runExecutionPlan(valuePlan, executor, CAPABILITIES);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution?.hash).toBe(hash(2));
        expect(result.error.execution?.completed.map((transaction) => transaction.stepId)).toEqual([
          'one',
        ]);
      }
    }
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('preserves earlier confirmations when a later wallet prompt is cancelled', async () => {
    const valuePlan = plan();
    let index = 0;
    const executor = vi.fn<SingleTxExecutor>((_transaction, context) => {
      index += 1;
      return index === 2
        ? errAsync(CancelError.from(new Error('cancelled'), context.failure('signing')))
        : okAsync(sent(index));
    });

    const result = await runExecutionPlan(valuePlan, executor, CAPABILITIES);

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error instanceof CancelError) {
      expect(result.error.execution?.completed).toHaveLength(1);
      expect(result.error.execution?.completed[0]!.stepId).toBe('one');
    }
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('resumes only after the confirmed prefix and retains it in the final result', async () => {
    const valuePlan = plan();
    const first = confirmed(valuePlan, 0);
    const executor = vi.fn<SingleTxExecutor>((_transaction, context) =>
      okAsync(sent(context.stepIndex + 1)),
    );

    const result = await runExecutionPlan(valuePlan, executor, CAPABILITIES, {
      resume: { planId: valuePlan.id, confirmed: [first] },
    });

    expect(result.isOk()).toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toEqual(first);
      expect(result.value.transactions.map((transaction) => transaction.stepId)).toEqual([
        'one',
        'two',
        'three',
      ]);
    }
  });

  it('rejects unsupported capabilities and invalid confirmations before execution', async () => {
    const batchPlan = plan({
      execution: 'atomic-batch',
      authorization: 'transactions',
      sponsored: false,
      chainTransitions: false,
    });
    const executor = vi.fn<SingleTxExecutor>(() => okAsync(sent(1)));

    const unsupported = await runExecutionPlan(batchPlan, executor, CAPABILITIES);
    const invalidConfirmations = await runExecutionPlan(plan(), executor, CAPABILITIES, {
      confirmations: 0,
    });

    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) {
      expect(unsupported.error).toBeInstanceOf(UnsupportedCapabilityError);
    }
    expect(invalidConfirmations.isErr()).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('turns a progress callback failure into a typed pre-broadcast error', async () => {
    const executor = vi.fn<SingleTxExecutor>(() => okAsync(sent(1)));

    const result = await runExecutionPlan(plan(), executor, CAPABILITIES, {
      onProgress() {
        throw new Error('ui failed');
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ProgressCallbackError);
    expect(executor).not.toHaveBeenCalled();
  });
});
