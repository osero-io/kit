import type { Chain, Hex, WalletClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { sendWith, supportsAtomicBatch } from './eip5792.js';
import { defineAdapterContract, type AdapterContractFactory } from './lib/_testing.js';
import {
  AccountMismatchError,
  BroadcastError,
  CancelError,
  ChainMismatchError,
  ConfirmationError,
  ProgressCallbackError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedCapabilityError,
  ValidationError,
} from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutionProgress,
  ExecutionResumeState,
} from './lib/types.js';

const actions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: unknown[]) => Promise<bigint>>(),
  getCapabilities: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  sendCalls: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  sendTransaction: vi.fn<(...args: unknown[]) => Promise<Hex>>(),
  waitForCallsStatus: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  waitForTransactionReceipt: vi.fn<
    (
      _client: unknown,
      input: {
        readonly hash: Hex;
        readonly onReplaced?: (replacement: { readonly reason: string }) => void;
      },
    ) => Promise<unknown>
  >(),
}));

vi.mock('viem/actions', () => actions);

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const OTHER_ACCOUNT = '0x3333333333333333333333333333333333333333' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;
const BATCH_ID = 'batch-1';

function hash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function wallet(account: `0x${string}` = ACCOUNT, chainId = 8453): WalletClient {
  const chain: Chain = chainId === 1 ? mainnet : base;
  return {
    account: { address: account, type: 'json-rpc' },
    chain,
  } as unknown as WalletClient;
}

function receipt(transactionHash: Hex, status: 'success' | 'reverted' = 'success') {
  return {
    status,
    transactionHash,
    blockNumber: 123n,
    gasUsed: 50n,
    effectiveGasPrice: 2n,
  } as const;
}

function resetActions(): void {
  actions.estimateGas.mockReset().mockResolvedValue(100n);
  actions.getCapabilities.mockReset().mockResolvedValue({
    atomic: { status: 'unsupported' },
  });
  actions.getTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
  }));
  actions.sendCalls.mockReset().mockResolvedValue({ id: BATCH_ID });
  actions.sendTransaction
    .mockReset()
    .mockImplementation(async () => hash(actions.sendTransaction.mock.calls.length));
  actions.waitForCallsStatus.mockReset().mockResolvedValue({
    atomic: true,
    status: 'success',
    statusCode: 200,
    receipts: [receipt(hash(9))],
  });
  actions.waitForTransactionReceipt
    .mockReset()
    .mockImplementation(async (_client, input) => receipt(input.hash));
}

function plan(
  overrides: {
    readonly account?: `0x${string}`;
    readonly chainId?: number;
    readonly execution?: 'sequential' | 'atomic-batch';
    readonly stepCount?: number;
  } = {},
): ExecutionPlan {
  const account = overrides.account ?? ACCOUNT;
  const chainId = overrides.chainId ?? 8453;
  const steps = Array.from({ length: overrides.stepCount ?? 2 }, (_, index) => {
    const transaction = createTransactionRequest({
      id: `step-${index + 1}`,
      chainId,
      from: account,
      to: TARGET,
      data: `0x${(index + 1).toString(16).padStart(2, '0')}`,
      operation: 'SWAP_EXACT_IN',
    });
    if (transaction.isErr()) throw transaction.error;
    return transaction.value;
  });
  const valuePlan = createExecutionPlan({
    steps,
    requirements: {
      execution: overrides.execution ?? 'sequential',
      authorization: 'transactions',
      sponsored: false,
      chainTransitions: false,
    },
  });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

const factory: AdapterContractFactory = (configuration = {}) => {
  resetActions();
  actions.getCapabilities.mockResolvedValue({ atomic: { status: 'unsupported' } });
  const valueWallet = wallet(configuration.account ?? ACCOUNT, configuration.chainId ?? 8453);
  return {
    broadcast: actions.sendTransaction,
    execute(valuePlan, form, confirmations) {
      const options = confirmations === undefined ? {} : { confirmations };
      return form === 'direct'
        ? sendWith(valueWallet, valuePlan, options)
        : sendWith(valueWallet, options)(valuePlan);
    },
  };
};

defineAdapterContract('eip5792', factory);

describe('eip5792 atomic behavior', () => {
  beforeEach(resetActions);

  it('probes atomic support without throwing', async () => {
    actions.getCapabilities
      .mockResolvedValueOnce({ atomic: { status: 'supported' } })
      .mockResolvedValueOnce({ atomic: { status: 'ready' } })
      .mockRejectedValueOnce(new Error('probe failed'));

    await expect(supportsAtomicBatch(wallet())).resolves.toBe(true);
    await expect(supportsAtomicBatch(wallet())).resolves.toBe(true);
    await expect(supportsAtomicBatch(wallet())).resolves.toBe(false);
    await expect(supportsAtomicBatch({} as WalletClient)).resolves.toBe(false);
    expect(actions.getCapabilities).toHaveBeenCalledWith(expect.anything(), {
      account: ACCOUNT,
      chainId: 8453,
    });
  });

  it('sends a sequential two-step plan as one forced atomic batch', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    const valuePlan = plan();

    const result = await sendWith(wallet(), valuePlan);

    expect(result.isOk()).toBe(true);
    expect(actions.sendCalls).toHaveBeenCalledOnce();
    expect(actions.sendCalls).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        account: expect.objectContaining({ address: ACCOUNT }),
        chain: base,
        calls: valuePlan.steps.map((step) => ({
          to: step.to,
          data: step.data,
          value: step.value,
        })),
        forceAtomic: true,
        experimental_fallback: false,
      }),
    );
    expect(actions.sendTransaction).not.toHaveBeenCalled();
    if (result.isOk()) {
      expect(result.value.transactions).toHaveLength(2);
      expect(result.value.transactions.map((transaction) => transaction.hash)).toEqual([
        hash(9),
        hash(9),
      ]);
      expect(result.value.txHash).toBe(hash(9));
    }
  });

  it('accepts ready atomic support', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'ready' } });

    const result = await sendWith(wallet(), plan());

    expect(result.isOk()).toBe(true);
    expect(actions.sendCalls).toHaveBeenCalledOnce();
  });

  it('maps a declined ready-wallet upgrade to CancelError', async () => {
    const cause = Object.assign(new Error('upgrade declined'), { code: 5750 });
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'ready' } });
    actions.sendCalls.mockRejectedValue(cause);

    const result = await sendWith(wallet(), plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(CancelError);
      expect(result.error.cause).toBe(cause);
    }
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('does not fall back on 5760 when sequential fallback is disabled', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.sendCalls.mockRejectedValue(
      Object.assign(new Error('atomicity not supported'), { code: 5760 }),
    );

    const result = await sendWith(wallet(), plan(), { fallbackToSequential: false });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('falls back to viem when sendCalls reports code 5760', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.sendCalls.mockRejectedValue(
      Object.assign(new Error('atomicity not supported'), { code: 5760 }),
    );

    const result = await sendWith(wallet(), plan());

    expect(result.isOk()).toBe(true);
    expect(actions.sendCalls).toHaveBeenCalledOnce();
    expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(['unsupported', 'probe failure'] as const)(
    'falls through to viem when capability discovery reports %s',
    async (condition) => {
      if (condition === 'unsupported') {
        actions.getCapabilities.mockResolvedValue({ atomic: { status: 'unsupported' } });
      } else {
        actions.getCapabilities.mockRejectedValue(new Error('probe failed'));
      }

      const result = await sendWith(wallet(), plan());

      expect(result.isOk()).toBe(true);
      expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
      expect(actions.sendCalls).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported atomic execution when sequential fallback is disabled', async () => {
    const result = await sendWith(wallet(), plan(), { fallbackToSequential: false });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(actions.sendCalls).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a required atomic batch when the wallet cannot batch', async () => {
    const result = await sendWith(wallet(), plan({ execution: 'atomic-batch' }));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(actions.sendCalls).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'mixed accounts',
      mutate: (valuePlan: ExecutionPlan) => ({
        ...valuePlan,
        steps: [valuePlan.steps[0]!, { ...valuePlan.steps[1]!, from: OTHER_ACCOUNT }],
      }),
      error: ValidationError,
    },
    {
      name: 'mixed chains',
      mutate: (valuePlan: ExecutionPlan) => ({
        ...valuePlan,
        steps: [valuePlan.steps[0]!, { ...valuePlan.steps[1]!, chainId: 1 }],
      }),
      error: ValidationError,
    },
    {
      name: 'wallet account mismatch',
      mutate: (valuePlan: ExecutionPlan) => valuePlan,
      error: AccountMismatchError,
      valueWallet: wallet(OTHER_ACCOUNT),
    },
    {
      name: 'wallet chain mismatch',
      mutate: (valuePlan: ExecutionPlan) => valuePlan,
      error: ChainMismatchError,
      valueWallet: wallet(ACCOUNT, 1),
    },
  ])('rejects $name before any RPC send', async ({ mutate, error, valueWallet }) => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });

    const result = await sendWith(valueWallet ?? wallet(), mutate(plan()) as ExecutionPlan);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(error);
    expect(actions.getCapabilities).not.toHaveBeenCalled();
    expect(actions.sendCalls).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('maps status 500 with a receipt to TransactionError with its hash', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.waitForCallsStatus.mockResolvedValue({
      atomic: true,
      status: 'failure',
      statusCode: 500,
      receipts: [receipt(hash(4), 'reverted')],
    });

    const result = await sendWith(wallet(), plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TransactionError);
      if (result.error instanceof TransactionError) expect(result.error.txHash).toBe(hash(4));
    }
  });

  it('maps a calls-status timeout to ConfirmationError that names the batch', async () => {
    const cause = new Error('timed out');
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.waitForCallsStatus.mockRejectedValue(cause);

    const result = await sendWith(wallet(), plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      expect(result.error.message).toContain(BATCH_ID);
      expect(result.error.cause).toBe(cause);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution).toMatchObject({
          stage: 'confirmation',
          stepId: 'step-2',
          completed: [],
        });
        expect(result.error.execution?.hash).toBeUndefined();
      }
    }
    expect(actions.sendCalls).toHaveBeenCalledOnce();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('uses one terminal receipt for every call in the batch', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.waitForCallsStatus.mockResolvedValue({
      atomic: true,
      status: 'success',
      statusCode: 200,
      receipts: [receipt(hash(7))],
    });

    const result = await sendWith(wallet(), plan());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions.map((transaction) => transaction.hash)).toEqual([
        hash(7),
        hash(7),
      ]);
    }
  });
});

function atomicWallet(): WalletClient {
  actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
  return wallet();
}

function resumeFirstStep(valuePlan: ExecutionPlan): ExecutionResumeState {
  const step = valuePlan.steps[0]!;
  const confirmed: ConfirmedTransaction = {
    planId: valuePlan.id,
    stepId: step.id,
    stepIndex: 0,
    operation: step.operation,
    submittedHash: hash(1),
    hash: hash(1),
    confirmation: { status: 'success', transactionHash: hash(1), confirmations: 1 },
  };
  return { planId: valuePlan.id, confirmed: [confirmed] };
}

function recordProgress(): {
  readonly events: ExecutionProgress[];
  readonly onProgress: (event: ExecutionProgress) => void;
  readonly types: () => string[];
} {
  const events: ExecutionProgress[] = [];
  return {
    events,
    onProgress: (event) => void events.push(event),
    types: () =>
      events.map((event) => ('stepId' in event ? `${event.type}:${event.stepId}` : event.type)),
  };
}

describe('eip5792 submission failures', () => {
  beforeEach(resetActions);

  it.each([
    ['a wallet RPC error', Object.assign(new Error('internal error'), { code: -32603 })],
    ['an error without a code', new Error('network down')],
    ['an unrecognized provider code', Object.assign(new Error('unsupported'), { code: 4200 })],
    ['a non-error rejection', 'boom'],
  ])('maps %s from wallet_sendCalls to BroadcastError', async (_name, cause) => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    actions.sendCalls.mockRejectedValue(cause);

    const result = await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(BroadcastError);
      expect(result.error.code).toBe('BROADCAST_FAILED');
      expect(result.error.cause).toBe(cause);
      if (result.error instanceof BroadcastError) {
        expect(result.error.execution).toMatchObject({
          stage: 'broadcast',
          stepId: 'step-1',
          stepIndex: 0,
          completed: [],
        });
      }
    }
    expect(actions.waitForCallsStatus).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
    expect(progress.events).toEqual([]);
  });

  it.each([
    ['user rejection 4001', 4001, CancelError],
    ['declined upgrade 5750', 5750, CancelError],
    ['unauthorized 4100', 4100, SigningError],
  ])('keeps %s at the signing stage', async (_name, code, errorClass) => {
    const valueWallet = atomicWallet();
    const cause = Object.assign(new Error('wallet said no'), { code });
    actions.sendCalls.mockRejectedValue(new Error('wrapped', { cause }));

    const result = await sendWith(valueWallet, plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(errorClass);
      if (result.error instanceof CancelError || result.error instanceof SigningError) {
        expect(result.error.execution?.stage).toBe('signing');
      }
    }
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing id', {}],
    ['an empty id', { id: '' }],
    ['a non-string id', { id: 7 }],
    ['a null response', null],
  ])('maps %s from wallet_sendCalls to BroadcastError', async (_name, response) => {
    const valueWallet = atomicWallet();
    actions.sendCalls.mockResolvedValue(response);

    const result = await sendWith(valueWallet, plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(BroadcastError);
      expect(result.error.message).toBe('wallet_sendCalls returned an invalid batch id');
      if (result.error instanceof BroadcastError) {
        expect(result.error.execution?.stage).toBe('broadcast');
      }
    }
    expect(actions.waitForCallsStatus).not.toHaveBeenCalled();
  });
});

describe('eip5792 status failures', () => {
  beforeEach(resetActions);

  it.each([
    ['a non-object status', 'pending', undefined],
    ['a status without a status code', { receipts: [] }, undefined],
    ['a status without receipts', { statusCode: 200 }, undefined],
    ['an on-chain failure without a receipt', { statusCode: 500, receipts: [] }, undefined],
    ['a partial failure without a receipt', { statusCode: 600, receipts: [] }, undefined],
    [
      'an off-chain failure status',
      { atomic: true, statusCode: 400, receipts: [receipt(hash(4))] },
      hash(4),
    ],
    [
      'a non-atomic execution',
      { atomic: false, statusCode: 200, receipts: [receipt(hash(4))] },
      hash(4),
    ],
    [
      'a success status carrying a reverted receipt',
      { atomic: true, statusCode: 200, receipts: [receipt(hash(4), 'reverted')] },
      hash(4),
    ],
    [
      'a receipt count matching neither one nor the batch size',
      {
        atomic: true,
        statusCode: 200,
        receipts: [receipt(hash(4)), receipt(hash(5)), receipt(hash(6))],
      },
      hash(6),
    ],
    [
      'a success status with an unreadable receipt',
      { atomic: true, statusCode: 200, receipts: [{ status: 'success' }] },
      undefined,
    ],
  ])('maps %s to ConfirmationError naming the batch', async (_name, status, expectedHash) => {
    const valueWallet = atomicWallet();
    actions.waitForCallsStatus.mockResolvedValue(status);

    const result = await sendWith(valueWallet, plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      expect(result.error.code).toBe('CONFIRMATION_FAILED');
      expect(result.error.message).toContain(BATCH_ID);
      expect(result.error.cause).toBe(status);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution).toMatchObject({ stage: 'confirmation', completed: [] });
        expect(result.error.execution?.hash).toBe(expectedHash);
      }
    }
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it.each([500, 600])(
    'maps reverted status %d to TransactionError carrying the steps confirmed before the batch',
    async (statusCode) => {
      const valueWallet = atomicWallet();
      const valuePlan = plan({ stepCount: 3 });
      actions.waitForCallsStatus.mockResolvedValue({
        atomic: true,
        status: 'failure',
        statusCode,
        receipts: [receipt(hash(4), 'reverted')],
      });

      const result = await sendWith(valueWallet, valuePlan, {
        resume: resumeFirstStep(valuePlan),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(TransactionError);
        if (result.error instanceof TransactionError) {
          expect(result.error.txHash).toBe(hash(4));
          expect(result.error.message).toContain(BATCH_ID);
          expect(result.error.execution).toMatchObject({
            stage: 'revert',
            stepId: 'step-3',
            hash: hash(4),
            completed: [{ stepId: 'step-1', stepIndex: 0, hash: hash(1) }],
          });
        }
      }
      // Only the two pending steps were batched; the resumed step is not resent.
      expect(actions.sendCalls).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          calls: valuePlan.steps.slice(1).map((step) => ({
            to: step.to,
            data: step.data,
            value: step.value,
          })),
        }),
      );
    },
  );

  it('carries the resumed prefix on a status-wait failure', async () => {
    const valueWallet = atomicWallet();
    const valuePlan = plan({ stepCount: 3 });
    actions.waitForCallsStatus.mockRejectedValue(new Error('timed out'));

    const result = await sendWith(valueWallet, valuePlan, { resume: resumeFirstStep(valuePlan) });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error instanceof ConfirmationError) {
      expect(result.error.execution?.completed).toEqual([
        expect.objectContaining({ stepId: 'step-1', hash: hash(1) }),
      ]);
    }
    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
  });
});

describe('eip5792 extra confirmations', () => {
  beforeEach(resetActions);

  it('keeps the batch hash when the extra confirmation wait fails', async () => {
    const valueWallet = atomicWallet();
    actions.waitForTransactionReceipt.mockRejectedValue(new Error('receipt timeout'));

    const result = await sendWith(valueWallet, plan(), { confirmations: 2 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution).toMatchObject({ stage: 'confirmation', hash: hash(9) });
      }
    }
  });

  it('maps a reverted confirmation receipt to TransactionError', async () => {
    const valueWallet = atomicWallet();
    actions.waitForTransactionReceipt.mockResolvedValue(receipt(hash(9), 'reverted'));

    const result = await sendWith(valueWallet, plan(), { confirmations: 2 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TransactionError);
      if (result.error instanceof TransactionError) {
        expect(result.error.txHash).toBe(hash(9));
        expect(result.error.execution?.stage).toBe('revert');
      }
    }
  });

  it.each(['cancelled', 'replaced'] as const)(
    'fails at the replacement stage when the batch transaction is %s',
    async (reason) => {
      const valueWallet = atomicWallet();
      actions.waitForTransactionReceipt.mockImplementation(async (_client, input) => {
        input.onReplaced?.({ reason });
        return receipt(hash(77));
      });

      const result = await sendWith(valueWallet, plan(), { confirmations: 2 });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.message).toBe(
          `Transaction ${hash(9)} was ${reason} and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({ stage: 'replacement', hash: hash(9) });
        }
      }
    },
  );

  it('records a repriced batch transaction as a replacement', async () => {
    const valueWallet = atomicWallet();
    actions.waitForTransactionReceipt.mockImplementation(async (_client, input) => {
      input.onReplaced?.({ reason: 'repriced' });
      return receipt(hash(77));
    });

    const result = await sendWith(valueWallet, plan(), { confirmations: 2 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.txHash).toBe(hash(77));
      for (const transaction of result.value.transactions) {
        expect(transaction).toMatchObject({
          submittedHash: hash(9),
          hash: hash(77),
          replacement: { reason: 'repriced', originalHash: hash(9), replacementHash: hash(77) },
          confirmation: { transactionHash: hash(77), confirmations: 2 },
        });
      }
    }
  });
});

describe('eip5792 batch progress', () => {
  beforeEach(resetActions);

  it('reports submission before confirmation for a successful batch', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();

    const result = await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(result.isOk()).toBe(true);
    expect(progress.types()).toEqual([
      'preflight-complete',
      'step-started:step-1',
      'step-started:step-2',
      'step-submitted:step-1',
      'step-submitted:step-2',
      'step-confirmed',
      'step-confirmed',
      'plan-completed',
    ]);
    expect(progress.events[0]).toEqual({
      type: 'preflight-complete',
      planId: result.isOk() ? result.value.planId : '',
      totalSteps: 2,
      resumedSteps: 0,
    });
    expect(progress.events[3]).toMatchObject({ type: 'step-submitted', hash: hash(9) });
    if (result.isOk()) {
      expect(progress.events[5]).toEqual({
        type: 'step-confirmed',
        transaction: result.value.transactions[0],
      });
      expect(progress.events[7]).toEqual({ type: 'plan-completed', result: result.value });
    }
  });

  it('emits nothing before the wallet accepts the batch', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    let eventsWhenSent = -1;
    actions.sendCalls.mockImplementation(async () => {
      eventsWhenSent = progress.events.length;
      return { id: BATCH_ID };
    });

    await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(eventsWhenSent).toBe(0);
  });

  it('still shows the submissions of a batch that reverts, without confirmations', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    actions.waitForCallsStatus.mockResolvedValue({
      atomic: true,
      status: 'failure',
      statusCode: 500,
      receipts: [receipt(hash(4), 'reverted')],
    });

    const result = await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(result.isErr() && result.error).toBeInstanceOf(TransactionError);
    expect(progress.types()).toEqual([
      'preflight-complete',
      'step-started:step-1',
      'step-started:step-2',
      'step-submitted:step-1',
      'step-submitted:step-2',
    ]);
    expect(progress.events[4]).toMatchObject({ type: 'step-submitted', hash: hash(4) });
  });

  it('shows accepted steps but invents no hash when the status wait times out', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    actions.waitForCallsStatus.mockRejectedValue(new Error('timed out'));

    const result = await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
    expect(progress.types()).toEqual([
      'preflight-complete',
      'step-started:step-1',
      'step-started:step-2',
    ]);
  });

  it('reports a resumed batch from its first pending step', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    const valuePlan = plan({ stepCount: 3 });

    const result = await sendWith(valueWallet, valuePlan, {
      onProgress: progress.onProgress,
      resume: resumeFirstStep(valuePlan),
    });

    expect(result.isOk()).toBe(true);
    expect(progress.events[0]).toMatchObject({
      type: 'preflight-complete',
      totalSteps: 3,
      resumedSteps: 1,
    });
    expect(progress.types().slice(1, 5)).toEqual([
      'step-started:step-2',
      'step-started:step-3',
      'step-submitted:step-2',
      'step-submitted:step-3',
    ]);
  });

  it('does not duplicate events when sendCalls falls back to sequential execution', async () => {
    const progress = recordProgress();
    const valueWallet = atomicWallet();
    actions.sendCalls.mockRejectedValue(
      Object.assign(new Error('atomicity not supported'), { code: 5760 }),
    );

    const result = await sendWith(valueWallet, plan(), { onProgress: progress.onProgress });

    expect(result.isOk()).toBe(true);
    expect(progress.types()).toEqual([
      'preflight-complete',
      'step-started:step-1',
      'step-submitted:step-1',
      'step-confirmed',
      'step-started:step-2',
      'step-submitted:step-2',
      'step-confirmed',
      'plan-completed',
    ]);
  });

  it.each([
    ['preflight-complete', 'step-1', 0],
    ['step-started', 'step-1', 0],
    ['step-submitted', 'step-1', 0],
    ['step-confirmed', 'step-1', 1],
    ['plan-completed', 'step-2', 2],
  ] as const)(
    'returns ProgressCallbackError after the batch confirms when %s throws',
    async (failingType, stepId, completedCount) => {
      const valueWallet = atomicWallet();
      const seen: string[] = [];
      const cause = new Error('consumer failed');

      const result = await sendWith(valueWallet, plan(), {
        onProgress: (event) => {
          seen.push(event.type);
          if (event.type === failingType) throw cause;
        },
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ProgressCallbackError);
        expect(result.error.cause).toBe(cause);
        if (result.error instanceof ProgressCallbackError) {
          expect(result.error.execution).toMatchObject({ stage: 'progress', stepId });
          expect(result.error.execution?.completed).toHaveLength(completedCount);
        }
      }
      // The first failing callback is the last one invoked.
      expect(seen.at(-1)).toBe(failingType);
      expect(seen.filter((type) => type === failingType)).toHaveLength(1);
      // A throwing callback never interrupts the submitted batch.
      expect(actions.waitForCallsStatus).toHaveBeenCalledOnce();
    },
  );

  it('reports the batch failure rather than an earlier callback failure', async () => {
    const valueWallet = atomicWallet();
    actions.waitForCallsStatus.mockRejectedValue(new Error('timed out'));

    const result = await sendWith(valueWallet, plan(), {
      onProgress: () => {
        throw new Error('consumer failed');
      },
    });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
  });
});

function throwingOptions(cause: unknown) {
  return new Proxy(
    {},
    {
      get: () => {
        throw cause;
      },
    },
  );
}

describe('eip5792 last-resort error net', () => {
  beforeEach(resetActions);

  it('wraps a genuine defect as UnexpectedError', async () => {
    const cause = new TypeError('defect');

    const result = await sendWith(wallet(), plan(), throwingOptions(cause));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.cause).toBe(cause);
    }
  });

  it('never re-wraps an error that is already classified', async () => {
    const classified = ValidationError.forField('confirmations', 'already classified');

    const result = await sendWith(wallet(), plan(), throwingOptions(classified));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBe(classified);
  });
});
