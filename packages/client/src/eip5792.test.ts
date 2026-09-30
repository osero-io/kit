import type { Chain, Hex, WalletClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { sendWith, supportsAtomicBatch } from './eip5792.js';
import { defineAdapterContract, type AdapterContractFactory } from './lib/_testing.js';
import {
  AccountMismatchError,
  CancelError,
  ChainMismatchError,
  TransactionError,
  UnexpectedError,
  UnsupportedCapabilityError,
  ValidationError,
} from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';
import type { ExecutionPlan } from './lib/types.js';

const actions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: unknown[]) => Promise<bigint>>(),
  getCapabilities: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  sendCalls: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  sendTransaction: vi.fn<(...args: unknown[]) => Promise<Hex>>(),
  waitForCallsStatus: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  waitForTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
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

  it('maps a calls-status timeout to UnexpectedError that names the batch', async () => {
    actions.getCapabilities.mockResolvedValue({ atomic: { status: 'supported' } });
    actions.waitForCallsStatus.mockRejectedValue(new Error('timed out'));

    const result = await sendWith(wallet(), plan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toContain(BATCH_ID);
    }
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
