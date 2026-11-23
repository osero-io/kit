import { APIUserAbortError, type PrivyClient } from '@privy-io/node';
import type { Hex, PublicClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { type Mock, vi } from 'vitest';

import {
  defineAdapterContract,
  mockFn,
  readReplacementBlock,
  type AdapterContractFactory,
  type AdapterFault,
  type MinedTransactionFixture,
} from './lib/_testing.js';
import {
  ConfirmationError,
  TransactionError,
  UnsupportedCapabilityError,
  ValidationError,
} from './lib/errors.js';
import {
  createExecutionPlan,
  createTransactionRequest,
  executionResumeStateFromError,
} from './lib/plan.js';
import { sendWith, type PrivyWallet } from './privy.js';

type ReceiptWaitInput = {
  readonly hash: Hex;
  readonly onReplaced?: (replacement: { readonly reason: string }) => void;
};

const actions = vi.hoisted(() => ({
  getBlock: vi.fn<(_client: unknown, input: unknown) => Promise<unknown>>(),
  getTransactionReceipt:
    vi.fn<(_client: unknown, input: { readonly hash: Hex }) => Promise<unknown>>(),
  waitForTransactionReceipt:
    vi.fn<(_client: unknown, input: ReceiptWaitInput) => Promise<unknown>>(),
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
  actions.getBlock.mockReset().mockResolvedValue({ transactions: [] });
  actions.getTransactionReceipt.mockReset().mockImplementation(async (_client, input) => ({
    status: 'success',
    transactionHash: input.hash,
  }));
}

/** Injects one failure into the Privy harness for the shared adapter contract. */
function injectPrivyFault(state: PrivyHarnessState, fault: AdapterFault, step: number): void {
  if (fault.stage === 'estimate') return;
  if (fault.stage === 'send') {
    let sent = 0;
    state.sendTransaction.mockImplementation(async () => {
      sent += 1;
      if (sent === step) {
        throw fault.kind === 'cancel'
          ? new APIUserAbortError({ message: 'caller aborted' })
          : new Error('wallet API unavailable');
      }
      return { hash: hash(sent) };
    });
    return;
  }
  if (fault.stage === 'resume-receipt') {
    actions.getTransactionReceipt.mockImplementation(async (_client, input) => {
      if (fault.kind === 'unavailable') throw new Error('receipt not found');
      return { status: 'reverted', transactionHash: input.hash };
    });
    return;
  }
  let waited = 0;
  actions.waitForTransactionReceipt.mockImplementation(async (client, input) => {
    waited += 1;
    const receipt = {
      status: 'success',
      transactionHash: input.hash,
      blockNumber: 123n,
      gasUsed: 50n,
      effectiveGasPrice: 2n,
    };
    if (waited !== step) return receipt;
    if (fault.kind === 'timeout') throw new Error('receipt timeout');
    if (fault.kind === 'revert') return { ...receipt, status: 'reverted' };
    const replacementHash = hash(9_000 + step);
    // A repricing re-sends the step that was just sent, at another fee.
    const { transaction } = sentPrivyTransaction(state);
    await readReplacementBlock(client, actions.getBlock, {
      hash: replacementHash,
      from: transaction.from,
      to: transaction.to,
      input: transaction.data,
      value: BigInt(transaction.value),
    });
    input.onReplaced?.({ reason: fault.kind });
    return { ...receipt, transactionHash: replacementHash };
  });
}

/** The transaction of the last Wallet API send. */
function sentPrivyTransaction(state: PrivyHarnessState) {
  const [, request] = state.sendTransaction.mock.lastCall as [
    string,
    {
      readonly params: {
        readonly transaction: { from: Hex; to: Hex; data: Hex; value: Hex };
      };
    },
  ];
  return request.params;
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
    resumeReceiptLookup: actions.getTransactionReceipt,
    // Privy selects gas inside its Wallet API; the SDK performs no estimate.
    performs: { estimate: false },
    // APIUserAbortError is a client-side abort, not a refusal by the wallet.
    cancelProvesNotSent: false,
    fail: (fault, step = 1) => injectPrivyFault(state, fault, step),
    execute(valuePlan, form, confirmations, extra) {
      const options = {
        chainId,
        receiptClient: receiptClient(chainId),
        idempotencyKeys: Object.fromEntries(
          valuePlan.steps.map((step) => [step.id, `key-${step.id}`]),
        ),
        ...(confirmations === undefined ? {} : { confirmations }),
        ...extra,
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

  it('never derives resume state when the caller aborts after the Wallet API accepted the request', async () => {
    // The abort ends the HTTP call on the client; Privy may already be broadcasting.
    let accepted = 0;
    const privy = {
      wallets: () => ({
        ethereum: () => ({
          sendTransaction: async () => {
            accepted += 1;
            throw new APIUserAbortError({ message: 'caller aborted after dispatch' });
          },
        }),
      }),
    } as unknown as PrivyClient;
    const valuePlan = singlePlan();

    const result = await sendWith(privy, { id: 'wallet-1', address: ACCOUNT }, valuePlan, {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: { swap: 'key-swap' },
    });

    expect(accepted).toBe(1);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('CANCELLED');
      const refused = executionResumeStateFromError(valuePlan, result.error);
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error).toBeInstanceOf(ValidationError);
        expect(refused.error.details).toMatchObject({ stage: 'signing', stepId: 'swap' });
      }
      // Only the caller, having checked the wallet, can vouch that nothing was sent.
      const vouched = executionResumeStateFromError(valuePlan, result.error, {
        unresolvedStep: 'assume-not-executed',
      });
      expect(vouched.isOk()).toBe(true);
    }
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

  it('reports where a plan stopped when a later step returns a sponsored response', async () => {
    const state = makePrivy();
    state.sendTransaction
      .mockResolvedValueOnce({ hash: hash(1) })
      .mockResolvedValueOnce({ hash: 'user-operation-id' });
    const valuePlan = twoStepPlan();

    const result = await sendWith(state.privy, { id: 'wallet-1', address: ACCOUNT }, valuePlan, {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: { swap: 'key-swap', 'swap-two': 'key-swap-two' },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedCapabilityError);
      if (result.error instanceof UnsupportedCapabilityError) {
        expect(result.error.executor).toBe('privy');
        expect(result.error.execution).toMatchObject({
          planId: valuePlan.id,
          stepId: 'swap-two',
          stepIndex: 1,
          operation: 'SWAP_EXACT_IN',
          stage: 'broadcast',
        });
        expect(result.error.execution?.hash).toBeUndefined();
        expect(result.error.execution?.completed).toEqual([
          expect.objectContaining({
            stepId: 'swap',
            hash: hash(1),
            submittedHash: hash(1),
            confirmation: expect.objectContaining({ status: 'success' }),
          }),
        ]);
        // The Wallet API accepted the request, so the step may be in flight:
        // nothing is derived until the caller has resolved it.
        const refused = executionResumeStateFromError(valuePlan, result.error);
        expect(refused.isErr()).toBe(true);
        if (refused.isErr()) {
          expect(refused.error.details).toMatchObject({ stage: 'broadcast', stepId: 'swap-two' });
        }
        const derived = executionResumeStateFromError(valuePlan, result.error, {
          unresolvedStep: 'assume-not-executed',
        });
        expect(derived.isOk()).toBe(true);
        if (derived.isOk()) {
          expect(derived.value.confirmed.map((step) => step.stepId)).toEqual(['swap']);
        }
      }
    }
    // The receipt wait ran for the confirmed first step only.
    expect(actions.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
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

  it.each([
    ['a null plan', null],
    ['a plan without steps', { __typename: 'ExecutionPlan', version: 1, id: 'plan-x' }],
    ['a plan whose steps are not an array', { ...singlePlan(), steps: null }],
    ['a plan with a malformed later step', undefined],
  ])(
    'returns a validation error for %s combined with idempotency keys',
    async (_name, candidate) => {
      const valid = twoStepPlan();
      const malformed =
        candidate === undefined
          ? { ...valid, steps: [valid.steps[0], { ...valid.steps[1], data: '0x123' }] }
          : candidate;
      const options = {
        chainId: 8453,
        receiptClient: receiptClient(8453),
        idempotencyKeys: { swap: 'key-swap', 'swap-two': 'key-swap-two' },
      } as const;
      const wallet = { id: 'wallet-1', address: ACCOUNT } satisfies PrivyWallet;
      const direct = makePrivy();
      const curried = makePrivy();

      const directResult = await sendWith(direct.privy, wallet, malformed as never, options);
      const curriedResult = await sendWith(curried.privy, wallet, options)(malformed as never);

      for (const result of [directResult, curriedResult]) {
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(ValidationError);
          expect(result.error.code).toBe('VALIDATION_ERROR');
        }
      }
      expect(direct.sendTransaction).not.toHaveBeenCalled();
      expect(curried.sendTransaction).not.toHaveBeenCalled();
      expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
    },
  );

  it('rejects idempotency keys that are not an object without throwing', async () => {
    const state = makePrivy();

    const result = await sendWith(state.privy, { id: 'wallet-1', address: ACCOUNT }, singlePlan(), {
      chainId: 8453,
      receiptClient: receiptClient(8453),
      idempotencyKeys: null as never,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
      if (result.error instanceof ValidationError) {
        expect(result.error.field).toBe('idempotencyKeys');
      }
    }
    expect(state.sendTransaction).not.toHaveBeenCalled();
  });
});

/** The first step of `twoStepPlan`, as viem reads it from a block. */
const FIRST_STEP_MINED = { from: ACCOUNT, to: TARGET, input: '0x1234', value: 0n } as const;

/**
 * Models viem naming a replacement: it reads the block that mined it through
 * the client it was given, `onReplaced` fires, then the wait resolves with the
 * replacement's receipt. `mined` is what that block holds under the
 * replacement's hash; by default the first step at another fee.
 */
function replaceFirstReceipt(
  reason: string | undefined,
  replacementHash: Hex,
  mined: Omit<MinedTransactionFixture, 'hash'> = FIRST_STEP_MINED,
): void {
  actions.waitForTransactionReceipt.mockImplementationOnce(async (client, input) => {
    if (reason !== undefined) {
      await readReplacementBlock(client, actions.getBlock, { hash: replacementHash, ...mined });
      input.onReplaced?.({ reason });
    }
    return {
      status: 'success',
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

describe('Privy transaction replacement', () => {
  beforeEach(resetReceipts);

  const options = {
    chainId: 8453,
    receiptClient: receiptClient(8453),
    idempotencyKeys: { swap: 'key-swap', 'swap-two': 'key-swap-two' },
  } as const;
  const wallet = { id: 'wallet-1', address: ACCOUNT } satisfies PrivyWallet;

  it('records a repriced replacement and continues with the next step', async () => {
    const state = makePrivy();
    replaceFirstReceipt('repriced', hash(99));

    const result = await sendWith(state.privy, wallet, twoStepPlan(), options);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: hash(1),
        hash: hash(99),
        replacement: { reason: 'repriced', originalHash: hash(1), replacementHash: hash(99) },
      });
    }
    expect(state.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2])(
    'fails closed when viem names a repricing of other calldata with %i confirmations',
    async (confirmations) => {
      const state = makePrivy();
      replaceFirstReceipt('repriced', hash(99), { ...FIRST_STEP_MINED, input: '0xdead' });

      const result = await sendWith(state.privy, wallet, twoStepPlan(), {
        ...options,
        confirmations,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.message).toBe(
          `Transaction ${hash(1)} was replaced and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({ stage: 'replacement', hash: hash(1) });
        }
      }
      expect(state.sendTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts an unexplained substitution that is the same transaction at another fee', async () => {
    const state = makePrivy();
    substituteFirstReceipt(hash(99), { from: ACCOUNT, to: TARGET, input: '0x1234', value: 0n });

    const result = await sendWith(state.privy, wallet, twoStepPlan(), {
      ...options,
      confirmations: 2,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: hash(1),
        hash: hash(99),
        replacement: { reason: 'repriced', originalHash: hash(1), replacementHash: hash(99) },
      });
    }
    expect(state.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('fails closed when an unexplained substitution carries other calldata', async () => {
    const state = makePrivy();
    substituteFirstReceipt(hash(99), { from: ACCOUNT, to: TARGET, input: '0xdead', value: 0n });

    const result = await sendWith(state.privy, wallet, twoStepPlan(), {
      ...options,
      confirmations: 2,
    });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfirmationError);
    expect(state.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'replaced', undefined] as const)(
    'fails at the replacement stage and sends nothing further when the reason is %s',
    async (reason) => {
      const state = makePrivy();
      replaceFirstReceipt(reason, hash(99));

      const result = await sendWith(state.privy, wallet, twoStepPlan(), options);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.message).toBe(
          `Transaction ${hash(1)} was ${reason ?? 'replaced'} and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({
            stepId: 'swap',
            stage: 'replacement',
            hash: hash(1),
            completed: [],
          });
        }
      }
      expect(state.sendTransaction).toHaveBeenCalledTimes(1);
    },
  );
});
