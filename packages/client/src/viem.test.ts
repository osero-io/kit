import {
  BaseError,
  TransactionExecutionError,
  UserRejectedRequestError,
  type Chain,
  type Hex,
  type WalletClient,
} from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import {
  defineAdapterContract,
  type AdapterContractFactory,
  readReplacementBlock,
  type AdapterFault,
  type MinedTransactionFixture,
} from './lib/_testing.js';
import { ConfirmationError, TransactionError } from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';
import { _configureTelemetryForTesting, type TelemetryEvent } from './lib/telemetry.js';
import { sendWith } from './viem.js';

type ReceiptWaitInput = {
  readonly hash: Hex;
  readonly onReplaced?: (replacement: { readonly reason: string }) => void;
};

const actions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: unknown[]) => Promise<bigint>>(),
  getBlock: vi.fn<(_client: unknown, input: unknown) => Promise<unknown>>(),
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  sendTransaction: vi.fn<(...args: unknown[]) => Promise<Hex>>(),
  waitForTransactionReceipt:
    vi.fn<(_client: unknown, input: ReceiptWaitInput) => Promise<unknown>>(),
}));

vi.mock('viem/actions', () => actions);

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;
const OTHER = '0x3333333333333333333333333333333333333333' as const;

function hash(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function wallet(account: `0x${string}`, chainId: number): WalletClient {
  const chain: Chain = chainId === 1 ? mainnet : base;
  return {
    account: { address: account, type: 'json-rpc' },
    chain,
  } as unknown as WalletClient;
}

function resetActions(): void {
  actions.estimateGas.mockReset().mockResolvedValue(100n);
  actions.sendTransaction
    .mockReset()
    .mockImplementation(async () => hash(actions.sendTransaction.mock.calls.length));
  actions.waitForTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
    blockNumber: 123n,
    gasUsed: 50n,
    effectiveGasPrice: 2n,
  }));
  actions.getBlock.mockReset().mockResolvedValue({ transactions: [] });
  actions.getTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
  }));
}

async function successfulReceipt(_client: unknown, input: ReceiptWaitInput) {
  return {
    status: 'success',
    transactionHash: input.hash,
    blockNumber: 123n,
    gasUsed: 50n,
    effectiveGasPrice: 2n,
  };
}

/** The fields of a mocked viem `sendTransaction` call the fault injection reads. */
type SentTransaction = {
  readonly account: { readonly address: Hex };
  readonly to: Hex;
  readonly data: Hex;
  readonly value: bigint;
};

/** Injects one failure into the mocked viem actions for the shared adapter contract. */
function injectViemFault(fault: AdapterFault, step: number): void {
  const nth = <Args extends unknown[], Value>(
    mock: { mockImplementation(implementation: (...args: Args) => Promise<Value>): unknown },
    normal: (...args: Args) => Promise<Value>,
    faulty: (...args: Args) => Promise<Value>,
  ): void => {
    let call = 0;
    mock.mockImplementation((...args: Args) => {
      call += 1;
      return call === step ? faulty(...args) : normal(...args);
    });
  };
  if (fault.stage === 'estimate') {
    nth(
      actions.estimateGas,
      async () => 100n,
      async () => {
        throw new Error('estimate failed');
      },
    );
    return;
  }
  if (fault.stage === 'send') {
    nth(
      actions.sendTransaction,
      async () => hash(actions.sendTransaction.mock.calls.length),
      async () => {
        throw fault.kind === 'cancel'
          ? new UserRejectedRequestError(new Error('user rejected'))
          : new TransactionExecutionError(new BaseError('rpc failure'), {
              account: null,
              chain: base,
              to: TARGET,
            });
      },
    );
    return;
  }
  if (fault.stage === 'resume-receipt') {
    actions.getTransactionReceipt.mockImplementation(async (_client, input) => {
      if (fault.kind === 'unavailable') throw new Error('receipt not found');
      return { status: 'reverted', transactionHash: input.hash };
    });
    return;
  }
  nth(actions.waitForTransactionReceipt, successfulReceipt, async (client, input) => {
    if (fault.kind === 'timeout') throw new Error('receipt timeout');
    if (fault.kind === 'revert') {
      return { ...(await successfulReceipt(client, input)), status: 'reverted' };
    }
    const replacementHash = hash(9_000 + step);
    // A repricing re-sends the step that was just sent, at another fee.
    const sent = actions.sendTransaction.mock.lastCall?.[1] as SentTransaction;
    await readReplacementBlock(client, actions.getBlock, {
      hash: replacementHash,
      from: sent.account.address,
      to: sent.to,
      input: sent.data,
      value: sent.value,
    });
    input.onReplaced?.({ reason: fault.kind });
    return { ...(await successfulReceipt(client, input)), transactionHash: replacementHash };
  });
}

const factory: AdapterContractFactory = (configuration = {}) => {
  resetActions();
  const valueWallet = wallet(configuration.account ?? ACCOUNT, configuration.chainId ?? 8453);
  return {
    broadcast: actions.sendTransaction,
    resumeReceiptLookup: actions.getTransactionReceipt,
    performs: { estimate: true },
    fail: (fault, step = 1) => injectViemFault(fault, step),
    execute(valuePlan, form, confirmations, extra) {
      const options = { ...(confirmations === undefined ? {} : { confirmations }), ...extra };
      return form === 'direct'
        ? sendWith(valueWallet, valuePlan, options)
        : sendWith(valueWallet, options)(valuePlan);
    },
  };
};

defineAdapterContract('viem', factory);

function singlePlan(quoteExpiresAt?: string) {
  const transaction = createTransactionRequest({
    id: 'swap',
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
    estimatedGas: { gas: 1n, source: 'hosted-api' },
  });
  if (transaction.isErr()) throw transaction.error;
  const valuePlan = createExecutionPlan({
    steps: [transaction.value],
    ...(quoteExpiresAt === undefined ? {} : { quoteExpiresAt }),
  });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

describe('viem stage behavior', () => {
  beforeEach(resetActions);
  afterEach(() => vi.useRealTimers());

  it('returns typed configuration failure for a disconnected wallet without throwing', async () => {
    const disconnected = {} as WalletClient;

    const direct = await sendWith(disconnected, singlePlan());
    const curried = await sendWith(disconnected)(singlePlan());

    expect(direct.isErr()).toBe(true);
    expect(curried.isErr()).toBe(true);
    if (direct.isErr()) expect(direct.error.code).toBe('CONFIGURATION_ERROR');
    expect(actions.estimateGas).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('classifies fresh estimation failures as simulation errors', async () => {
    actions.estimateGas.mockRejectedValue(new Error('estimate failed'));

    const result = await sendWith(wallet(ACCOUNT, 8453), singlePlan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('SIMULATION_FAILED');
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('classifies wallet rejection separately from broadcast failure', async () => {
    actions.sendTransaction.mockRejectedValueOnce(
      new UserRejectedRequestError(new Error('user rejected')),
    );
    const cancelled = await sendWith(wallet(ACCOUNT, 8453), singlePlan());
    const executionError = new TransactionExecutionError(new BaseError('rpc failure'), {
      account: null,
      chain: base,
      to: TARGET,
    });
    actions.sendTransaction.mockRejectedValueOnce(executionError);
    const broadcast = await sendWith(wallet(ACCOUNT, 8453), singlePlan());

    expect(cancelled.isErr()).toBe(true);
    if (cancelled.isErr()) expect(cancelled.error.code).toBe('CANCELLED');
    expect(broadcast.isErr()).toBe(true);
    if (broadcast.isErr()) expect(broadcast.error.code).toBe('BROADCAST_FAILED');
  });

  it('uses a fresh buffered estimate and never promotes advisory gas to a limit', async () => {
    const result = await sendWith(wallet(ACCOUNT, 8453), singlePlan());

    expect(result.isOk()).toBe(true);
    expect(actions.estimateGas).toHaveBeenCalledTimes(1);
    expect(actions.sendTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gas: 115n }),
    );
  });

  it('rechecks quote expiry after estimation and immediately before wallet submission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T19:59:59Z'));
    actions.estimateGas.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-07-22T20:00:00Z'));
      return 100n;
    });

    const result = await sendWith(wallet(ACCOUNT, 8453), singlePlan('2026-07-22T20:00:00Z'));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('QUOTE_EXPIRED');
    expect(actions.estimateGas).toHaveBeenCalledOnce();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
  });

  it('preserves the submitted hash on receipt failure and records partial progress', async () => {
    const first = createTransactionRequest({
      id: 'first',
      chainId: 8453,
      from: ACCOUNT,
      to: TARGET,
      data: '0x01',
      operation: 'SWAP_EXACT_IN',
    });
    const second = createTransactionRequest({
      id: 'second',
      chainId: 8453,
      from: ACCOUNT,
      to: TARGET,
      data: '0x02',
      operation: 'SWAP_EXACT_IN',
    });
    if (first.isErr() || second.isErr()) throw new Error('test plan failed');
    const valuePlan = createExecutionPlan({ steps: [first.value, second.value] });
    if (valuePlan.isErr()) throw valuePlan.error;
    actions.waitForTransactionReceipt
      .mockResolvedValueOnce({
        status: 'success',
        transactionHash: hash(1),
        blockNumber: 1n,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
      })
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await sendWith(wallet(ACCOUNT, 8453), valuePlan.value);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution?.hash).toBe(hash(2));
        expect(result.error.execution?.completed).toHaveLength(1);
      }
    }
    expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('maps reverted receipts to transaction errors', async () => {
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      transactionHash: hash(1),
      blockNumber: 1n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
    });

    const result = await sendWith(wallet(ACCOUNT, 8453), singlePlan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(TransactionError);
  });
});

function twoStepPlan() {
  const steps = ['first', 'second'].map((id, index) => {
    const transaction = createTransactionRequest({
      id,
      chainId: 8453,
      from: ACCOUNT,
      to: TARGET,
      data: index === 0 ? '0x01' : '0x02',
      operation: 'SWAP_EXACT_IN',
    });
    if (transaction.isErr()) throw transaction.error;
    return transaction.value;
  });
  const valuePlan = createExecutionPlan({ steps });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

/** The first step of `twoStepPlan`, as viem reads it from a block. */
const FIRST_STEP_MINED = { from: ACCOUNT, to: TARGET, input: '0x01', value: 0n } as const;

/**
 * Models viem naming a replacement: it reads the block that mined it through
 * the client it was given, `onReplaced` fires, then the wait resolves with the
 * replacement's receipt. `mined` is what that block holds under the
 * replacement's hash; by default the first step at another fee.
 */
function replaceFirstReceipt(
  reason: string | undefined,
  replacementHash: Hex,
  status = 'success',
  mined: Omit<MinedTransactionFixture, 'hash'> = FIRST_STEP_MINED,
): void {
  actions.waitForTransactionReceipt.mockImplementationOnce(async (client, input) => {
    if (reason !== undefined) {
      await readReplacementBlock(client, actions.getBlock, { hash: replacementHash, ...mined });
      input.onReplaced?.({ reason });
    }
    return {
      status,
      transactionHash: replacementHash,
      blockNumber: 124n,
      gasUsed: 55n,
      effectiveGasPrice: 3n,
    };
  });
}

/**
 * A substitution viem resolves without naming a reason. As in viem, the waiter
 * finds the replacement by reading its block through the client it was given.
 */
function substituteFirstReceipt(replacementHash: Hex, mined: Record<string, unknown>): void {
  actions.getBlock.mockResolvedValue({ transactions: [{ hash: replacementHash, ...mined }] });
  actions.waitForTransactionReceipt.mockImplementationOnce(async (client) => {
    await (client as { getBlock(input: unknown): Promise<unknown> }).getBlock({
      blockNumber: 124n,
      includeTransactions: true,
    });
    return {
      status: 'success',
      transactionHash: replacementHash,
      blockNumber: 124n,
      gasUsed: 55n,
      effectiveGasPrice: 3n,
    };
  });
}

describe('viem transaction replacement', () => {
  beforeEach(resetActions);

  it('records a repriced replacement and continues with the next step', async () => {
    replaceFirstReceipt('repriced', hash(99));

    const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: hash(1),
        hash: hash(99),
        replacement: { reason: 'repriced', originalHash: hash(1), replacementHash: hash(99) },
        confirmation: { status: 'success', transactionHash: hash(99) },
      });
      expect(result.value.transactions[1]?.replacement).toBeUndefined();
    }
    expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(['cancelled', 'replaced'] as const)(
    'fails at the replacement stage and broadcasts nothing further when a step is %s',
    async (reason) => {
      replaceFirstReceipt(reason, hash(99));
      const onProgress = vi.fn<(event: { readonly type: string }) => void>();

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { onProgress });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.code).toBe('CONFIRMATION_FAILED');
        expect(result.error.message).toBe(
          `Transaction ${hash(1)} was ${reason} and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({
            stepId: 'first',
            stepIndex: 0,
            stage: 'replacement',
            hash: hash(1),
            completed: [],
          });
          expect(result.error.cause).toEqual({
            reason,
            originalHash: hash(1),
            replacementHash: hash(99),
          });
        }
      }
      expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
      expect(onProgress.mock.calls.map(([event]) => event.type)).toEqual([
        'preflight-complete',
        'step-started',
        'step-submitted',
      ]);
    },
  );

  it('fails closed when the receipt belongs to another hash and viem named no reason', async () => {
    replaceFirstReceipt(undefined, hash(99));

    const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan());

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error instanceof ConfirmationError) {
      expect(result.error.execution?.stage).toBe('replacement');
      expect(result.error.execution?.hash).toBe(hash(1));
    }
    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
    expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
  });

  describe('when viem returns another hash without naming a reason', () => {
    // viem skips onReplaced when more than one confirmation is requested.
    const firstStep = { from: ACCOUNT, to: TARGET, input: '0x01', value: 0n };

    it.each([
      ['the same transaction at another fee', firstStep, 'repriced'],
      [
        'the same transaction with other hex casing',
        { ...firstStep, to: TARGET.toUpperCase().replace('0X', '0x') },
        'repriced',
      ],
    ] as const)('accepts %s as a repricing', async (_name, mined, reason) => {
      substituteFirstReceipt(hash(99), mined);

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations: 2 });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.transactions[0]).toMatchObject({
          submittedHash: hash(1),
          hash: hash(99),
          replacement: { reason, originalHash: hash(1), replacementHash: hash(99) },
        });
      }
      // The only block read is the one the waiter made itself.
      expect(actions.getBlock).toHaveBeenCalledTimes(1);
      expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a cancellation', { ...firstStep, to: ACCOUNT, input: '0x' }, 'cancelled'],
      ['other calldata', { ...firstStep, input: '0x02' }, 'replaced'],
      ['another target', { ...firstStep, to: OTHER }, 'replaced'],
      ['another value', { ...firstStep, value: 1n }, 'replaced'],
      ['another sender', { ...firstStep, from: OTHER }, 'replaced'],
      ['a contract creation', { ...firstStep, to: null }, 'replaced'],
      ['a transaction with yet another hash', { ...firstStep, hash: hash(98) }, 'replaced'],
      ['a block entry that is not a transaction body', { from: ACCOUNT }, 'replaced'],
    ] as const)(
      'fails closed for %s and broadcasts nothing further',
      async (_name, mined, reason) => {
        substituteFirstReceipt(hash(99), mined);

        const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations: 2 });

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(ConfirmationError);
          expect(result.error.message).toBe(
            `Transaction ${hash(1)} was ${reason} and cannot be treated as this plan step`,
          );
          if (result.error instanceof ConfirmationError) {
            expect(result.error.execution).toMatchObject({ stage: 'replacement', hash: hash(1) });
          }
        }
        expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
      },
    );

    it('fails closed when the waiter never read the block that mined the replacement', async () => {
      replaceFirstReceipt(undefined, hash(99));

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations: 2 });

      expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
      expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('reads blocks through the client own getBlock when it has one', async () => {
      const own = vi
        .fn<(input: unknown) => Promise<unknown>>()
        .mockResolvedValue({ transactions: [{ hash: hash(99), ...firstStep }] });
      const decorated = { ...wallet(ACCOUNT, 8453), getBlock: own } as unknown as WalletClient;
      substituteFirstReceipt(hash(99), firstStep);
      actions.getBlock.mockClear();

      const result = await sendWith(decorated, twoStepPlan(), { confirmations: 2 });

      expect(result.isOk()).toBe(true);
      expect(own).toHaveBeenCalledWith({ blockNumber: 124n, includeTransactions: true });
      expect(actions.getBlock).not.toHaveBeenCalled();
    });

    it('makes no read of its own in any case', async () => {
      replaceFirstReceipt('repriced', hash(99));

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations: 2 });

      expect(result.isOk()).toBe(true);
      // The only block read is the one the waiter made itself.
      expect(actions.getBlock).toHaveBeenCalledTimes(1);
    });
  });

  describe.each([1, 2])('when viem names a repricing with %i confirmations', (confirmations) => {
    it('accepts it when the mined transaction is the step that was sent', async () => {
      replaceFirstReceipt('repriced', hash(99));

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.transactions[0]?.replacement).toEqual({
          reason: 'repriced',
          originalHash: hash(1),
          replacementHash: hash(99),
        });
      }
      expect(actions.getBlock).toHaveBeenCalledTimes(1);
      expect(actions.sendTransaction).toHaveBeenCalledTimes(2);
    });

    // viem compares the replacement with what the node holds under the
    // submitted hash, not with what the adapter asked the wallet to send.
    it.each([
      ['another sender', { ...FIRST_STEP_MINED, from: OTHER }, 'replaced'],
      ['other calldata', { ...FIRST_STEP_MINED, input: '0x02' }, 'replaced'],
      ['another target', { ...FIRST_STEP_MINED, to: OTHER }, 'replaced'],
      ['another value', { ...FIRST_STEP_MINED, value: 1n }, 'replaced'],
      ['a cancellation', { ...FIRST_STEP_MINED, to: ACCOUNT, input: '0x' }, 'cancelled'],
    ] as const)(
      'fails closed when the mined transaction has %s and broadcasts nothing further',
      async (_name, mined, reason) => {
        replaceFirstReceipt('repriced', hash(99), 'success', mined);

        const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations });

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(ConfirmationError);
          expect(result.error.message).toBe(
            `Transaction ${hash(1)} was ${reason} and cannot be treated as this plan step`,
          );
          if (result.error instanceof ConfirmationError) {
            expect(result.error.execution).toMatchObject({
              stage: 'replacement',
              hash: hash(1),
              completed: [],
            });
          }
        }
        expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
      },
    );

    it('fails closed when the waiter never read the block that mined the replacement', async () => {
      actions.waitForTransactionReceipt.mockImplementationOnce(async (_client, input) => {
        input.onReplaced?.({ reason: 'repriced' });
        return { status: 'success', transactionHash: hash(99), blockNumber: 124n };
      });

      const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan(), { confirmations });

      expect(result.isErr()).toBe(true);
      if (result.isErr() && result.error instanceof ConfirmationError) {
        expect(result.error.execution?.stage).toBe('replacement');
        expect(result.error.message).toBe(
          `Transaction ${hash(1)} was replaced and cannot be treated as this plan step`,
        );
      }
      expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it('treats an unrecognized replacement reason as not repriced', async () => {
    replaceFirstReceipt('future-reason', hash(99));

    const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan());

    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
    expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports a reverted repriced replacement as a revert of the effective hash', async () => {
    replaceFirstReceipt('repriced', hash(99), 'reverted');

    const result = await sendWith(wallet(ACCOUNT, 8453), twoStepPlan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TransactionError);
      if (result.error instanceof TransactionError) {
        expect(result.error.txHash).toBe(hash(99));
        expect(result.error.execution?.stage).toBe('revert');
      }
    }
    expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('viem telemetry boundary', () => {
  afterEach(() => {
    _configureTelemetryForTesting({ enabled: undefined });
  });

  it('reports reverted executions once with executor context', async () => {
    resetActions();
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      transactionHash: hash(1),
      blockNumber: 1n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
    });
    const events: TelemetryEvent[] = [];
    _configureTelemetryForTesting({
      enabled: true,
      sink: { capture: (event) => void events.push(event), flush: async () => true },
    });

    const result = await sendWith(wallet(ACCOUNT, 8453), singlePlan());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.isErr() && result.error).toBeInstanceOf(TransactionError);
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({
      'osero.operation': 'viem.sendWith',
      'osero.executor': 'viem',
      'osero.chain_id': 8453,
      'osero.error_code': 'TRANSACTION_REVERTED',
      'osero.stage': 'revert',
    });
  });

  it('does not report caller-side configuration failures', async () => {
    resetActions();
    const events: TelemetryEvent[] = [];
    _configureTelemetryForTesting({
      enabled: true,
      sink: { capture: (event) => void events.push(event), flush: async () => true },
    });

    const result = await sendWith({} as WalletClient, singlePlan());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.isErr()).toBe(true);
    expect(events).toHaveLength(0);
  });
});
