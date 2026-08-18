import { APIUserAbortError, type PrivyClient } from '@privy-io/node';
import type { Hex, PublicClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { type Mock, vi } from 'vitest';

import { defineAdapterContract, mockFn, type AdapterContractFactory } from './lib/_testing.js';
import { ConfirmationError, TransactionError } from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';
import { sendWith, type PrivyWallet } from './privy.js';

const actions = vi.hoisted(() => ({
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  waitForTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
}));

vi.mock('viem/actions', () => actions);

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;

function hash(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

type PrivyHarnessState = {
  readonly sendTransaction: Mock;
  readonly privy: PrivyClient;
};

function makePrivy(): PrivyHarnessState {
  let sent = 0;
  const sendTransaction = mockFn(async () => {
    sent += 1;
    return { hash: hash(sent) };
  });
  const privy = {
    wallets: () => ({
      ethereum: () => ({ sendTransaction }),
    }),
  } as unknown as PrivyClient;
  return { sendTransaction, privy };
}

function receiptClient(chainId: number): PublicClient {
  return {
    chain: chainId === 1 ? mainnet : base,
  } as unknown as PublicClient;
}

function resetReceipts(): void {
  actions.waitForTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
    blockNumber: 123n,
    gasUsed: 50n,
    effectiveGasPrice: 2n,
  }));
  actions.getTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
  }));
}

const factory: AdapterContractFactory = (configuration = {}) => {
  resetReceipts();
  const state = makePrivy();
  const chainId = configuration.chainId ?? 8453;
  const wallet: PrivyWallet = {
    id: 'wallet-1',
    address: configuration.account ?? ACCOUNT,
  };
  return {
    broadcast: state.sendTransaction,
    execute(valuePlan, form, confirmations) {
      const options = {
        chainId,
        receiptClient: receiptClient(chainId),
        idempotencyKeys: Object.fromEntries(
          valuePlan.steps.map((step) => [step.id, `key-${step.id}`]),
        ),
        ...(confirmations === undefined ? {} : { confirmations }),
      };
      return form === 'direct'
        ? sendWith(state.privy, wallet, valuePlan, options)
        : sendWith(state.privy, wallet, options)(valuePlan);
    },
  };
};

defineAdapterContract('Privy', factory);

function singlePlan() {
  const transaction = createTransactionRequest({
    id: 'swap',
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
  });
  if (transaction.isErr()) throw transaction.error;
  const valuePlan = createExecutionPlan({ steps: [transaction.value] });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

function twoStepPlan() {
  const first = singlePlan().steps[0];
  if (first === undefined) throw new Error('first step missing');
  const valuePlan = createExecutionPlan({
    steps: [first, { ...first, id: 'swap-two', data: '0x5678' }],
  });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

describe('Privy stage behavior', () => {
  beforeEach(resetReceipts);

  it('validates stable idempotency-key content before Wallet API calls', async () => {
    const state = makePrivy();
    const wallet = { id: 'wallet-1', address: ACCOUNT } satisfies PrivyWallet;
    const valuePlan = singlePlan();

    const missing = await sendWith(state.privy, wallet, valuePlan, {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: {},
    });
    const unknown = await sendWith(state.privy, wallet, valuePlan, {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: { swap: 'same', extra: 'same' },
    });

    expect(missing.isErr()).toBe(true);
    expect(unknown.isErr()).toBe(true);
    expect(state.sendTransaction).not.toHaveBeenCalled();
  });

  it('separates caller cancellation from Wallet API broadcast failure', async () => {
    const cancelled = makePrivy();
    cancelled.sendTransaction.mockRejectedValue(
      new APIUserAbortError({ message: 'caller aborted' }),
    );
    const broadcast = makePrivy();
    broadcast.sendTransaction.mockRejectedValue(new Error('wallet API unavailable'));
    const options = {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: { swap: 'key-swap' },
    } as const;

    const cancelResult = await sendWith(
      cancelled.privy,
      { id: 'wallet-1', address: ACCOUNT },
      singlePlan(),
      options,
    );
    const broadcastResult = await sendWith(
      broadcast.privy,
      { id: 'wallet-1', address: ACCOUNT },
      singlePlan(),
      options,
    );

    expect(cancelResult.isErr()).toBe(true);
    if (cancelResult.isErr()) expect(cancelResult.error.code).toBe('CANCELLED');
    expect(broadcastResult.isErr()).toBe(true);
    if (broadcastResult.isErr()) expect(broadcastResult.error.code).toBe('BROADCAST_FAILED');
  });

  it('rejects sponsored responses without inventing a transaction hash', async () => {
    const state = makePrivy();
    state.sendTransaction.mockResolvedValue({ hash: '' });

    const result = await sendWith(state.privy, { id: 'wallet-1', address: ACCOUNT }, singlePlan(), {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: { swap: 'key-swap' },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('preserves submitted hash on receipt failure and maps reverts', async () => {
    const timeoutState = makePrivy();
    actions.waitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const timeoutResult = await sendWith(
      timeoutState.privy,
      { id: 'wallet-1', address: ACCOUNT },
      singlePlan(),
      {
        chainId: 8453,
        receiptClient: receiptClient(8453),
        idempotencyKeys: { swap: 'key-swap' },
      },
    );

    const revertState = makePrivy();
    actions.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      transactionHash: hash(1),
      blockNumber: 1n,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
    });
    const revertResult = await sendWith(
      revertState.privy,
      { id: 'wallet-1', address: ACCOUNT },
      singlePlan(),
      {
        chainId: 8453,
        receiptClient: receiptClient(8453),
        idempotencyKeys: { swap: 'key-swap-2' },
      },
    );

    expect(timeoutResult.isErr()).toBe(true);
    if (timeoutResult.isErr()) {
      expect(timeoutResult.error).toBeInstanceOf(ConfirmationError);
      if (timeoutResult.error instanceof ConfirmationError) {
        expect(timeoutResult.error.execution?.hash).toBe(hash(1));
      }
    }
    expect(revertResult.isErr()).toBe(true);
    if (revertResult.isErr()) expect(revertResult.error).toBeInstanceOf(TransactionError);
  });

  it('returns confirmed prefix recovery state when a later receipt fails', async () => {
    const state = makePrivy();
    actions.waitForTransactionReceipt
      .mockResolvedValueOnce({
        status: 'success',
        transactionHash: hash(1),
        blockNumber: 1n,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
      })
      .mockRejectedValueOnce(new Error('second receipt timeout'));

    const result = await sendWith(
      state.privy,
      { id: 'wallet-1', address: ACCOUNT },
      twoStepPlan(),
      {
        chainId: 8453,
        receiptClient: receiptClient(8453),
        idempotencyKeys: {
          swap: 'key-swap',
          'swap-two': 'key-swap-two',
        },
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error instanceof ConfirmationError) {
      expect(result.error.execution).toMatchObject({
        stepId: 'swap-two',
        hash: hash(2),
        completed: [expect.objectContaining({ stepId: 'swap', hash: hash(1) })],
      });
    }
    expect(state.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('allows forward-compatible unknown chains only with supplied metadata and transport', async () => {
    const state = makePrivy();
    const unknownChain = { ...base, id: 999_999, name: 'Future chain' };
    const transaction = createTransactionRequest({
      id: 'swap',
      chainId: 999_999,
      from: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      operation: 'SWAP_EXACT_IN',
    });
    if (transaction.isErr()) throw transaction.error;
    const futurePlanResult = createExecutionPlan({ steps: [transaction.value] });
    if (futurePlanResult.isErr()) throw futurePlanResult.error;
    const futurePlan = futurePlanResult.value;

    const missing = await sendWith(state.privy, { id: 'wallet-1', address: ACCOUNT }, futurePlan, {
      chainId: 999_999,
      chain: unknownChain,
      idempotencyKeys: { swap: 'future-key' },
    });
    const configured = await sendWith(
      state.privy,
      { id: 'wallet-1', address: ACCOUNT },
      futurePlan,
      {
        chainId: 999_999,
        receiptClient: {
          chain: unknownChain,
        } as unknown as PublicClient,
        idempotencyKeys: { swap: 'future-key' },
      },
    );

    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) expect(missing.error.code).toBe('CONFIGURATION_ERROR');
    expect(configured.isOk()).toBe(true);
  });
});
