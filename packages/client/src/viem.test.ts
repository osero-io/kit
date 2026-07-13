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

import { defineAdapterContract, type AdapterContractFactory } from './lib/_testing.js';
import { ConfirmationError, TransactionError } from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';
import { sendWith } from './viem.js';

const actions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: unknown[]) => Promise<bigint>>(),
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  sendTransaction: vi.fn<(...args: unknown[]) => Promise<Hex>>(),
  waitForTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
}));

vi.mock('viem/actions', () => actions);

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;

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
  actions.getTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
  }));
}

const factory: AdapterContractFactory = (configuration = {}) => {
  resetActions();
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

defineAdapterContract('viem', factory);

function singlePlan() {
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
  const valuePlan = createExecutionPlan({ steps: [transaction.value] });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

describe('viem stage behavior', () => {
  beforeEach(resetActions);

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
