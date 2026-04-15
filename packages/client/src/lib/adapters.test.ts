import { vi } from 'vitest';

import {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  isTransactionRequest,
  operationsFor,
  runExecutionPlan,
  type SingleTxExecutor,
} from './adapters.js';
import { UnexpectedError } from './errors.js';
import { makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest } from './plan.js';
import { errAsync, okAsync } from './result.js';
import type { TransactionRequest } from './types.js';

function fakeTx(hex: `0x${string}`, op: TransactionRequest['operation'] = 'MINT_USDS') {
  return makeTransactionRequest({
    chainId: 1,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    data: hex,
    operation: op,
  });
}

describe('type guards', () => {
  it('identifies a TransactionRequest', () => {
    const tx = fakeTx('0x01');
    expect(isTransactionRequest(tx)).toBe(true);
    expect(isErc20ApprovalRequired(tx)).toBe(false);
    expect(isMultiStepExecution(tx)).toBe(false);
  });

  it('identifies an Erc20ApprovalRequired plan', () => {
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: fakeTx('0x02'),
    });
    expect(isErc20ApprovalRequired(plan)).toBe(true);
    expect(isTransactionRequest(plan)).toBe(false);
    expect(isMultiStepExecution(plan)).toBe(false);
  });

  it('identifies a MultiStepExecution', () => {
    const plan = makeMultiStepPlan([fakeTx('0x03')]);
    expect(isMultiStepExecution(plan)).toBe(true);
    expect(isTransactionRequest(plan)).toBe(false);
    expect(isErc20ApprovalRequired(plan)).toBe(false);
  });
});

describe('flattenExecutionPlan', () => {
  it('returns a single tx for a bare TransactionRequest', () => {
    const tx = fakeTx('0x01');
    expect(flattenExecutionPlan(tx)).toEqual([tx]);
  });

  it('returns approvals then original for an Erc20ApprovalRequired', () => {
    const main = fakeTx('0x99');
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: main,
    });
    const flat = flattenExecutionPlan(plan);
    expect(flat).toHaveLength(2);
    expect(flat[0]!.operation).toBe('APPROVE_ERC20');
    expect(flat[1]).toBe(main);
  });

  it('recursively flattens a multi-step plan', () => {
    const main1 = fakeTx('0xaa', 'MINT_USDS');
    const main2 = fakeTx('0xbb', 'DEPOSIT_USDS_FOR_SUSDS');
    const step1 = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: main1,
    });
    const step2 = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x4444444444444444444444444444444444444444',
      spender: '0x5555555555555555555555555555555555555555',
      amount: 2n,
      mainTransaction: main2,
    });
    const plan = makeMultiStepPlan([step1, step2]);
    const flat = flattenExecutionPlan(plan);
    expect(flat).toHaveLength(4);
    expect(flat.map((t) => t.operation)).toEqual([
      'APPROVE_ERC20',
      'MINT_USDS',
      'APPROVE_ERC20',
      'DEPOSIT_USDS_FOR_SUSDS',
    ]);
  });
});

describe('operationsFor', () => {
  it('extracts the operation sequence from a plan', () => {
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: fakeTx('0x01', 'MINT_USDS'),
    });
    expect(operationsFor(plan)).toEqual(['APPROVE_ERC20', 'MINT_USDS']);
  });
});

describe('runExecutionPlan', () => {
  it('executes every transaction in strict order', async () => {
    const main = fakeTx('0x02', 'MINT_USDS');
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: main,
    });

    const calls: TransactionRequest[] = [];
    const executor = vi.fn<SingleTxExecutor>((tx) => {
      calls.push(tx);
      return okAsync(`0x${calls.length.toString(16).padStart(64, '0')}` as `0x${string}`);
    });

    const result = await runExecutionPlan(plan, executor);
    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.operation).toBe('APPROVE_ERC20');
    expect(calls[1]).toBe(main);
    if (result.isOk()) {
      expect(result.value.operations).toEqual(['APPROVE_ERC20', 'MINT_USDS']);
      // Final hash is the LAST tx, not the first.
      expect(result.value.txHash).toBe(`0x${(2).toString(16).padStart(64, '0')}`);
    }
  });

  it('short-circuits on the first executor failure', async () => {
    const main = fakeTx('0x02');
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: '0x1111111111111111111111111111111111111111',
      token: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
      mainTransaction: main,
    });

    const executor = vi.fn<SingleTxExecutor>(() =>
      errAsync(UnexpectedError.from(new Error('rpc timeout'))),
    );
    const result = await runExecutionPlan(plan, executor);
    expect(result.isErr()).toBe(true);
    // Should have tried exactly once — not twice.
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
