import { decodeFunctionData, getAddress } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { ValidationError } from './errors.js';
import {
  createApprovalTransaction,
  createExecutionPlan,
  createTransactionRequest,
  deserializeExecutionPlan,
  resumeExecutionPlan,
  serializeExecutionPlan,
} from './plan.js';
import type { ConfirmedTransaction, TransactionRequest } from './types.js';

const ACCOUNT_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const ACCOUNT = getAddress(ACCOUNT_LOWER);
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const TARGET = '0x3333333333333333333333333333333333333333' as const;
const TOKEN = '0x4444444444444444444444444444444444444444' as const;
const HASH = `0x${'a'.repeat(64)}` as const;

function transaction(id: string, overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  const result = createTransactionRequest({
    id,
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    value: 99n,
    operation: 'SWAP_EXACT_IN',
    ...overrides,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

function confirmed(planId: string, step: TransactionRequest, index: number): ConfirmedTransaction {
  return {
    planId,
    stepId: step.id,
    stepIndex: index,
    operation: step.operation,
    submittedHash: HASH,
    hash: HASH,
    confirmation: {
      status: 'success',
      transactionHash: HASH,
      blockNumber: 123n,
      gasUsed: 42n,
      effectiveGasPrice: 7n,
      confirmations: 2,
    },
  };
}

describe('transaction construction', () => {
  it('validates every executable field without throwing', () => {
    const malformed = [
      { field: 'id', value: '' },
      { field: 'chainId', value: 1.5 },
      { field: 'from', value: '0x1234' },
      { field: 'to', value: '0x1234' },
      { field: 'data', value: '0x123' },
      { field: 'value', value: -1n },
      { field: 'operation', value: 'UNKNOWN' },
    ] as const;

    for (const sample of malformed) {
      const result = createTransactionRequest({
        id: 'step',
        chainId: 1,
        from: ACCOUNT,
        to: TARGET,
        data: '0x',
        operation: 'SWAP_EXACT_IN',
        [sample.field]: sample.value,
      } as never);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(createTransactionRequest(null as never).isErr()).toBe(true);
  });

  it('builds a self-describing ERC-20 approval and validates its calldata', () => {
    const result = createApprovalTransaction({
      id: 'approve-token',
      chainId: 8453,
      owner: ACCOUNT,
      token: TOKEN,
      spender: TARGET,
      amount: 123n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: result.value.data });
      expect(decoded).toEqual({ functionName: 'approve', args: [TARGET, 123n] });
      expect(result.value.authorization).toEqual({
        kind: 'erc20-approval',
        token: TOKEN,
        owner: ACCOUNT,
        spender: TARGET,
        amount: 123n,
      });
    }
  });
});

describe('flat execution plans', () => {
  it('assigns a deterministic identity to ordered steps and requirements', () => {
    const steps = [transaction('one'), transaction('two', { data: '0xabcd' })];
    const first = createExecutionPlan({ steps });
    const second = createExecutionPlan({ steps });
    const batch = createExecutionPlan({
      steps,
      requirements: {
        execution: 'atomic-batch',
        authorization: 'transactions',
        sponsored: false,
        chainTransitions: false,
      },
    });

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(batch.isOk()).toBe(true);
    if (first.isOk() && second.isOk() && batch.isOk()) {
      expect(first.value.id).toBe(second.value.id);
      expect(batch.value.id).not.toBe(first.value.id);
      expect(first.value.steps).toEqual(steps);
    }
  });

  it('rejects duplicate IDs, mixed accounts, and unmodelled mixed chains', () => {
    const duplicate = createExecutionPlan({ steps: [transaction('same'), transaction('same')] });
    const mixedAccount = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { from: OTHER_ACCOUNT })],
    });
    const mixedChain = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { chainId: 10 })],
    });
    const modelledTransition = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { chainId: 10 })],
      requirements: {
        execution: 'sequential',
        authorization: 'transactions',
        sponsored: false,
        chainTransitions: true,
      },
    });

    expect(duplicate.isErr()).toBe(true);
    expect(mixedAccount.isErr()).toBe(true);
    expect(mixedChain.isErr()).toBe(true);
    expect(modelledTransition.isOk()).toBe(true);
  });

  it('treats checksum-equivalent sender spellings as one account', () => {
    const result = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { from: ACCOUNT_LOWER })],
    });
    expect(result.isOk()).toBe(true);
  });
});

describe('canonical persistence and recovery', () => {
  it('round-trips bigint, hex, estimates, and approval metadata exactly', () => {
    const approval = createApprovalTransaction({
      id: 'approve',
      chainId: 8453,
      owner: ACCOUNT,
      token: TOKEN,
      spender: TARGET,
      amount: 2n ** 255n,
      estimatedGas: { gas: 21_000n, source: 'hosted-api' },
    });
    if (approval.isErr()) throw approval.error;
    const plan = createExecutionPlan({
      steps: [approval.value, transaction('swap')],
      metadata: {
        source: 'hosted-api',
        allowanceSnapshots: [
          {
            token: TOKEN,
            owner: ACCOUNT,
            spender: TARGET,
            allowance: 0n,
            requiredAmount: 2n ** 255n,
            approvalAmount: 2n ** 255n,
            policy: 'exact',
            observedAtBlock: 999n,
          },
        ],
      },
    });
    if (plan.isErr()) throw plan.error;

    const serialized = serializeExecutionPlan(plan.value);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isOk()) {
      const restored = deserializeExecutionPlan(serialized.value);
      expect(restored).toEqual(plan);
    }
  });

  it('rejects tampered serialized plans', () => {
    const plan = createExecutionPlan({ steps: [transaction('one')] });
    if (plan.isErr()) throw plan.error;
    const serialized = serializeExecutionPlan(plan.value);
    if (serialized.isErr()) throw serialized.error;
    const tampered = serialized.value.replace('0x1234', '0xabcd');

    const result = deserializeExecutionPlan(tampered);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.field).toBe('plan.id');
  });

  it('resumes only an ordered prefix proven confirmed', () => {
    const plan = createExecutionPlan({ steps: [transaction('one'), transaction('two')] });
    if (plan.isErr()) throw plan.error;
    const first = confirmed(plan.value.id, plan.value.steps[0]!, 0);

    const resumed = resumeExecutionPlan(plan.value, {
      planId: plan.value.id,
      confirmed: [first],
    });
    const skippedSecond = resumeExecutionPlan(plan.value, {
      planId: plan.value.id,
      confirmed: [{ ...confirmed(plan.value.id, plan.value.steps[1]!, 1), stepIndex: 1 }],
    });

    expect(resumed.isOk()).toBe(true);
    if (resumed.isOk()) {
      expect(resumed.value.confirmed).toEqual([first]);
      expect(resumed.value.pending.map((step) => step.id)).toEqual(['two']);
    }
    expect(skippedSecond.isErr()).toBe(true);
  });
});
