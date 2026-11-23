import { makeError, type Signer, type TransactionReceipt, type TransactionResponse } from 'ethers';
import { type Mock, vi } from 'vitest';

import { sendWith } from './ethers.js';
import {
  defineAdapterContract,
  mockFn,
  type AdapterContractFactory,
  type AdapterFault,
} from './lib/_testing.js';
import { ConfirmationError, TransactionError } from './lib/errors.js';
import {
  createExecutionPlan,
  createTransactionRequest,
  executionResumeStateFromError,
} from './lib/plan.js';

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

/** The error ethers v6 `TransactionResponse.wait()` throws for a reverted receipt. */
function revertedByEthers(receipt: { readonly hash: string; readonly status: number }) {
  return makeError('transaction execution reverted', 'CALL_EXCEPTION', {
    action: 'sendTransaction',
    data: null,
    reason: null,
    invocation: null,
    revert: null,
    transaction: { to: TARGET, from: ACCOUNT, data: '' },
    receipt: receipt as unknown as TransactionReceipt,
  });
}

const factory: AdapterContractFactory = (configuration = {}) => {
  const state = makeHarness(configuration.account ?? ACCOUNT, configuration.chainId ?? 8453);
  let faults: { readonly fault: AdapterFault; readonly step: number }[] = [];
  const faultFor = (stage: AdapterFault['stage'], step: number) =>
    faults.find((entry) => entry.fault.stage === stage && entry.step === step)?.fault;
  let estimated = 0;
  state.estimateGas.mockImplementation(async () => {
    estimated += 1;
    if (faultFor('estimate', estimated) !== undefined) throw new Error('estimate failed');
    return 100n;
  });
  let sent = 0;
  state.sendTransaction.mockImplementation(async () => {
    sent += 1;
    const step = sent;
    const sendFault = faultFor('send', step);
    if (sendFault?.stage === 'send') {
      throw sendFault.kind === 'cancel'
        ? makeError('user rejected', 'ACTION_REJECTED', {
            action: 'sendTransaction',
            reason: 'rejected',
          })
        : makeError('network unreachable', 'NETWORK_ERROR', { event: 'broadcast' });
    }
    const transactionHash = hash(step);
    const receipt = {
      hash: transactionHash,
      status: 1,
      blockNumber: 123,
      gasUsed: 50n,
      gasPrice: 2n,
    };
    const wait = mockFn(async (_confirmations?: number, _timeout?: number) => {
      const receiptFault = faultFor('receipt', step);
      if (receiptFault?.stage !== 'receipt') return receipt;
      if (receiptFault.kind === 'timeout') throw new Error('receipt timeout');
      if (receiptFault.kind === 'revert') {
        // What ethers v6 really does: wait() throws CALL_EXCEPTION for a status-0 receipt.
        throw revertedByEthers({ ...receipt, status: 0 });
      }
      const replacementHash = hash(9_000 + step);
      throw makeError('replaced', 'TRANSACTION_REPLACED', {
        cancelled: receiptFault.kind === 'cancelled',
        reason: receiptFault.kind,
        hash: transactionHash,
        replacement: { hash: replacementHash } as TransactionResponse,
        receipt: { ...receipt, hash: replacementHash } as unknown as TransactionReceipt,
      });
    });
    return { hash: transactionHash, wait };
  });
  return {
    broadcast: state.sendTransaction,
    resumeReceiptLookup: state.getTransactionReceipt,
    performs: { estimate: true },
    revertSurfacesAt: 'confirmation',
    // An ethers revert is reported at the confirmation stage, so the provable
    // failure for resume tests is an explicit wallet rejection instead.
    provableFailure: { stage: 'send', kind: 'cancel' },
    fail(fault, step = 1) {
      faults = [...faults, { fault, step }];
      if (fault.stage === 'resume-receipt') {
        state.getTransactionReceipt.mockImplementation(async (transactionHash: string) => {
          if (fault.kind === 'unavailable') return null;
          return { hash: transactionHash, status: 0 };
        });
      }
    },
    execute(valuePlan, form, confirmations, extra) {
      const options = { ...(confirmations === undefined ? {} : { confirmations }), ...extra };
      return form === 'direct'
        ? sendWith(state.signer, valuePlan, options)
        : sendWith(state.signer, options)(valuePlan);
    },
  };
};

defineAdapterContract('ethers', factory);

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
  afterEach(() => vi.useRealTimers());

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

  it('rechecks quote expiry after estimation and immediately before wallet submission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T19:59:59Z'));
    const state = makeHarness();
    state.estimateGas.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-07-22T20:00:00Z'));
      return 100n;
    });

    const result = await sendWith(state.signer, singlePlan('2026-07-22T20:00:00Z'));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('QUOTE_EXPIRED');
    expect(state.estimateGas).toHaveBeenCalledOnce();
    expect(state.sendTransaction).not.toHaveBeenCalled();
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

  it.each([
    { name: 'cancelled', reason: 'cancelled', cancelled: true },
    { name: 'replaced by a different transaction', reason: 'replaced', cancelled: false },
    { name: 'repriced but flagged cancelled', reason: 'repriced', cancelled: true },
  ] as const)(
    'fails at the replacement stage and broadcasts nothing further when a step is $name',
    async ({ reason, cancelled }) => {
      const state = makeHarness();
      const replacementHash = hash(2);
      state.wait.mockRejectedValue(
        makeError('replaced', 'TRANSACTION_REPLACED', {
          cancelled,
          reason,
          hash: hash(1),
          replacement: { hash: replacementHash } as TransactionResponse,
          receipt: {
            hash: replacementHash,
            status: 1,
            blockNumber: 124,
            gasUsed: 55n,
            gasPrice: 3n,
          } as unknown as TransactionReceipt,
        }),
      );
      state.sendTransaction.mockResolvedValue({ hash: hash(1), wait: state.wait });

      const result = await sendWith(state.signer, twoStepPlan());

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.message).toBe(
          `Transaction ${hash(1)} was ${reason} and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({
            stepId: 'swap',
            stepIndex: 0,
            stage: 'replacement',
            hash: hash(1),
            completed: [],
          });
        }
      }
      expect(state.sendTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a real ethers revert as a confirmation failure that keeps the hash', async () => {
    // ethers v6 wait() throws CALL_EXCEPTION for a status-0 receipt, so the
    // status check after wait() is reached only for a repriced replacement.
    // This is the mapping on main; it is documented rather than changed.
    const state = makeHarness();
    state.wait.mockRejectedValue(revertedByEthers({ hash: hash(1), status: 0 }));
    state.sendTransaction.mockResolvedValue({ hash: hash(1), wait: state.wait });
    const valuePlan = twoStepPlan();

    const result = await sendWith(state.signer, valuePlan);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfirmationError);
      if (result.error instanceof ConfirmationError) {
        expect(result.error.execution).toMatchObject({
          stage: 'confirmation',
          stepId: 'swap',
          hash: hash(1),
        });
        // Resuming would send the step again, so it needs the caller's acknowledgement.
        expect(executionResumeStateFromError(valuePlan, result.error).isErr()).toBe(true);
      }
    }
    expect(state.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
