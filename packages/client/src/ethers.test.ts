import { makeError, type Signer, type TransactionReceipt, type TransactionResponse } from 'ethers';
import type { Mock } from 'vitest';

import { sendWith } from './ethers.js';
import { defineAdapterContract, mockFn, type AdapterContractFactory } from './lib/_testing.js';
import { ConfirmationError, TransactionError } from './lib/errors.js';
import { createExecutionPlan, createTransactionRequest } from './lib/plan.js';

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;

function hash(index: number): `0x${string}` {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

type EthersHarnessState = {
  readonly getAddress: Mock;
  readonly getNetwork: Mock;
  readonly getTransactionReceipt: Mock;
  readonly estimateGas: Mock;
  readonly sendTransaction: Mock;
  readonly wait: Mock;
  readonly signer: Signer;
};

function makeHarness(account: `0x${string}` = ACCOUNT, chainId = 8453): EthersHarnessState {
  const getAddress = mockFn(async () => account);
  const getNetwork = mockFn(async () => ({ chainId: BigInt(chainId) }));
  const getTransactionReceipt = mockFn(async (transactionHash: string) => ({
    hash: transactionHash,
    status: 1,
  }));
  const estimateGas = mockFn(async () => 100n);
  const wait = mockFn(async (_confirmations?: number, _timeout?: number) => ({
    hash: hash(1),
    status: 1,
    blockNumber: 123,
    gasUsed: 50n,
    gasPrice: 2n,
  }));
  const sendTransaction = mockFn(async () => ({ hash: hash(1), wait }));
  const signer = {
    provider: { getNetwork, getTransactionReceipt },
    getAddress,
    estimateGas,
    sendTransaction,
  } as unknown as Signer;
  return {
    getAddress,
    getNetwork,
    getTransactionReceipt,
    estimateGas,
    sendTransaction,
    wait,
    signer,
  };
}

const factory: AdapterContractFactory = (configuration = {}) => {
  const state = makeHarness(configuration.account ?? ACCOUNT, configuration.chainId ?? 8453);
  let sent = 0;
  state.sendTransaction.mockImplementation(async () => {
    sent += 1;
    const transactionHash = hash(sent);
    const wait = mockFn(async (_confirmations?: number, _timeout?: number) => ({
      hash: transactionHash,
      status: 1,
      blockNumber: 123,
      gasUsed: 50n,
      gasPrice: 2n,
    }));
    return { hash: transactionHash, wait };
  });
  return {
    broadcast: state.sendTransaction,
    execute(valuePlan, form, confirmations) {
      const options = confirmations === undefined ? {} : { confirmations };
      return form === 'direct'
        ? sendWith(state.signer, valuePlan, options)
        : sendWith(state.signer, options)(valuePlan);
    },
  };
};

defineAdapterContract('ethers', factory);

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

function twoStepPlan() {
  const first = singlePlan().steps[0];
  if (first === undefined) throw new Error('first step missing');
  const valuePlan = createExecutionPlan({
    steps: [first, { ...first, id: 'swap-two', data: '0x5678' }],
  });
  if (valuePlan.isErr()) throw valuePlan.error;
  return valuePlan.value;
}

describe('ethers stage behavior', () => {
  it('rejects a detached signer before resolving account or sending', async () => {
    const state = makeHarness();
    const detached = { ...state.signer, provider: null } as unknown as Signer;

    const result = await sendWith(detached, singlePlan());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CONFIGURATION_ERROR');
    expect(state.getAddress).not.toHaveBeenCalled();
    expect(state.sendTransaction).not.toHaveBeenCalled();
  });

  it('classifies explicit estimation, cancellation, signing, and broadcast stages', async () => {
    const estimation = makeHarness();
    estimation.estimateGas.mockRejectedValue(new Error('estimate failed'));
    const estimationResult = await sendWith(estimation.signer, singlePlan());

    const cancelled = makeHarness();
    cancelled.sendTransaction.mockRejectedValue(
      makeError('rejected', 'ACTION_REJECTED', { action: 'sendTransaction', reason: 'rejected' }),
    );
    const cancelResult = await sendWith(cancelled.signer, singlePlan());

    const broadcast = makeHarness();
    broadcast.sendTransaction.mockRejectedValue(
      makeError('funds', 'INSUFFICIENT_FUNDS', { transaction: {} }),
    );
    const broadcastResult = await sendWith(broadcast.signer, singlePlan());

    const signing = makeHarness();
    signing.sendTransaction.mockRejectedValue(new Error('sign failed'));
    const signingResult = await sendWith(signing.signer, singlePlan());

    expect(estimationResult.isErr()).toBe(true);
    if (estimationResult.isErr()) expect(estimationResult.error.code).toBe('SIMULATION_FAILED');
    expect(cancelResult.isErr()).toBe(true);
    if (cancelResult.isErr()) expect(cancelResult.error.code).toBe('CANCELLED');
    expect(broadcastResult.isErr()).toBe(true);
    if (broadcastResult.isErr()) expect(broadcastResult.error.code).toBe('BROADCAST_FAILED');
    expect(signingResult.isErr()).toBe(true);
    if (signingResult.isErr()) expect(signingResult.error.code).toBe('SIGNING_FAILED');
  });

  it('uses a fresh buffered estimate instead of advisory gas', async () => {
    const state = makeHarness();

    const result = await sendWith(state.signer, singlePlan());

    expect(result.isOk()).toBe(true);
    expect(state.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gasLimit: 115n }));
  });

  it('preserves submitted hash on receipt timeout and maps reverts truthfully', async () => {
    const timeout = makeHarness();
    timeout.wait.mockRejectedValue(new Error('timeout'));
    timeout.sendTransaction.mockResolvedValue({ hash: hash(1), wait: timeout.wait });
    const timeoutResult = await sendWith(timeout.signer, singlePlan());

    const reverted = makeHarness();
    reverted.wait.mockResolvedValue({
      hash: hash(1),
      status: 0,
      blockNumber: 123,
      gasUsed: 50n,
      gasPrice: 2n,
    });
    reverted.sendTransaction.mockResolvedValue({ hash: hash(1), wait: reverted.wait });
    const revertedResult = await sendWith(reverted.signer, singlePlan());

    expect(timeoutResult.isErr()).toBe(true);
    if (timeoutResult.isErr()) {
      expect(timeoutResult.error).toBeInstanceOf(ConfirmationError);
      if (timeoutResult.error instanceof ConfirmationError) {
        expect(timeoutResult.error.execution?.hash).toBe(hash(1));
      }
    }
    expect(revertedResult.isErr()).toBe(true);
    if (revertedResult.isErr()) expect(revertedResult.error).toBeInstanceOf(TransactionError);
  });

  it('returns confirmed prefix recovery state when a later step cannot be confirmed', async () => {
    const state = makeHarness();
    const firstWait = mockFn(async () => ({
      hash: hash(1),
      status: 1,
      blockNumber: 123,
      gasUsed: 50n,
      gasPrice: 2n,
    }));
    const secondWait = mockFn(async () => {
      throw new Error('second receipt timeout');
    });
    state.sendTransaction
      .mockResolvedValueOnce({ hash: hash(1), wait: firstWait })
      .mockResolvedValueOnce({ hash: hash(2), wait: secondWait });

    const result = await sendWith(state.signer, twoStepPlan());

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

  it('records a repriced replacement effective hash and receipt', async () => {
    const state = makeHarness();
    const replacementHash = hash(2);
    const replacementReceipt = {
      hash: replacementHash,
      status: 1,
      blockNumber: 124,
      gasUsed: 55n,
      gasPrice: 3n,
    };
    const replacementResponse = { hash: replacementHash } as TransactionResponse;
    state.wait.mockRejectedValue(
      makeError('replaced', 'TRANSACTION_REPLACED', {
        cancelled: false,
        reason: 'repriced',
        hash: hash(1),
        replacement: replacementResponse,
        receipt: replacementReceipt as unknown as TransactionReceipt,
      }),
    );
    state.sendTransaction.mockResolvedValue({ hash: hash(1), wait: state.wait });

    const result = await sendWith(state.signer, singlePlan());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: hash(1),
        hash: replacementHash,
        replacement: {
          reason: 'repriced',
          originalHash: hash(1),
          replacementHash,
        },
      });
    }
  });
});
