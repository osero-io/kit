import { getAddress } from 'viem';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type {
  OseroApiRecoveryContext,
  OseroApiTransferState,
  OseroApiTransferStatus,
} from './api.js';
import { CHAINS, type OseroChainId } from './chains.js';
import { OseroClient, type OseroPublicClient } from './OseroClient.js';
import {
  createExecutionPlan,
  createTransactionRequest,
  deserializeExecutionResumeState,
  executionResumeStateFromError,
  serializeExecutionResumeState,
} from './plan.js';
import { okAsync, type Result } from './result.js';
import type {
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutionProgress,
  ExecutionResumeState,
  SendWithError,
  TransactionResult,
} from './types.js';

export type MockPublicClient = {
  readonly chain: (typeof CHAINS)[OseroChainId]['viemChain'];
  readonly transport: { readonly type: 'mock' };
  readonly getBlockNumber: Mock;
  readonly readContract: Mock;
  readonly multicall: Mock;
  readonly getBalance: Mock;
  readonly estimateFeesPerGas: Mock;
  readonly estimateGas: Mock;
};

type TestProcedure = (...args: never[]) => unknown;

export function mockFn(): Mock;
export function mockFn<T extends TestProcedure>(implementation: T): Mock<T>;
export function mockFn<T extends TestProcedure>(implementation?: T): Mock | Mock<T> {
  if (implementation === undefined) return vi.fn<() => void>();
  return vi.fn<T>(implementation);
}

export const TEST_SOURCE_TRANSACTION_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
export const TEST_DESTINATION_TRANSACTION_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

export function singleTransactionResultForPlan(
  plan: ExecutionPlan,
  hash: `0x${string}`,
): TransactionResult {
  const step = plan.steps[0]!;
  return {
    planId: plan.id,
    transactions: [
      {
        planId: plan.id,
        stepId: step.id,
        stepIndex: 0,
        operation: step.operation,
        submittedHash: hash,
        hash,
        confirmation: {
          status: 'success',
          transactionHash: hash,
          confirmations: 1,
        },
      },
    ],
    txHash: hash,
  };
}

export function createExecutionHandlerFake(): {
  readonly handler: ExecutionPlanHandler;
  readonly calls: ExecutionPlan[];
  readonly results: TransactionResult[];
} {
  const calls: ExecutionPlan[] = [];
  const results: TransactionResult[] = [];
  const handler: ExecutionPlanHandler = (plan) => {
    calls.push(plan);
    const hash = `0x${calls.length.toString(16).padStart(64, '0')}` as `0x${string}`;
    const result = singleTransactionResultForPlan(plan, hash);
    results.push(result);
    return okAsync(result);
  };
  return { handler, calls, results };
}

function transferStatusFixtureBase(state: OseroApiTransferState) {
  return {
    state,
    sourceChainId: 8453,
    destinationChainId: 1,
    bridge: 'future-bridge',
    sourceTransactionHash: TEST_SOURCE_TRANSACTION_HASH,
    destinationTransactionHash: state === 'completed' ? TEST_DESTINATION_TRANSACTION_HASH : null,
    error: state === 'failed' ? 'bridge failed' : null,
    recoveryContext: null,
  } as const;
}

export function ensoTransferStatusFixture(
  state: OseroApiTransferState,
  providerStatus: string = state,
): OseroApiTransferStatus {
  return {
    ...transferStatusFixtureBase(state),
    provider: 'enso',
    providerDetails: {
      provider: 'enso',
      status: providerStatus,
    },
  };
}

export function lifiTransferStatusFixture(
  state: OseroApiTransferState = 'completed',
): OseroApiTransferStatus {
  return {
    ...transferStatusFixtureBase(state),
    provider: 'lifi',
    providerDetails: {
      provider: 'lifi',
      status: state === 'completed' ? 'DONE' : 'PENDING',
      substatus: state === 'completed' ? 'COMPLETED' : null,
    },
  };
}

export function zeroXTransferStatusFixture(
  state: OseroApiTransferState = 'completed',
  recoveryContext: OseroApiRecoveryContext | null = null,
): OseroApiTransferStatus {
  return {
    ...transferStatusFixtureBase(state),
    provider: '0x',
    bridge: 'across_v4',
    recoveryContext,
    providerDetails: {
      provider: '0x',
      status: state === 'completed' ? 'bridge_filled' : 'origin_pending',
      failureReason: state === 'failed' ? 'internal' : null,
      recoveryStatus: recoveryContext === null ? null : 'manual_action_required',
    },
  };
}

export function zeroXRecoveryContextFixture(
  overrides: Partial<OseroApiRecoveryContext> = {},
): OseroApiRecoveryContext {
  return {
    state: 'action-required',
    reason: 'provider-failure',
    chainId: 8453,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '997500',
    settledAmount: null,
    estimatedTimeSeconds: null,
    deadline: '2030-01-02T00:00:00.000Z',
    action: {
      transaction: {
        chainId: 8453,
        recipient: '0x0000000000000000000000000000000000000004',
        calldata: '0x9abc',
        value: '0',
        gasLimit: '200000',
      },
    },
    ...overrides,
  };
}

function unexpected(operation: string) {
  return mockFn(() => Promise.reject(new Error(`Unexpected ${operation} call`)));
}

export function createMockClient(
  chainId: OseroChainId,
  overrides: Partial<MockPublicClient> = {},
): { readonly client: OseroClient; readonly publicClient: MockPublicClient } {
  const publicClient: MockPublicClient = {
    chain: CHAINS[chainId].viemChain,
    transport: { type: 'mock' },
    getBlockNumber: unexpected('getBlockNumber'),
    readContract: unexpected('readContract'),
    multicall: unexpected('multicall'),
    getBalance: unexpected('getBalance'),
    estimateFeesPerGas: unexpected('estimateFeesPerGas'),
    estimateGas: unexpected('estimateGas'),
    ...overrides,
  };
  return {
    client: OseroClient.create({
      publicClients: { [chainId]: publicClient as unknown as OseroPublicClient },
    }),
    publicClient,
  };
}

/**
 * A failure the shared adapter contract can ask a harness to inject. `step` is
 * the 1-based position of the transaction within one `execute` call.
 */
export type AdapterFault =
  | { readonly stage: 'estimate' }
  | { readonly stage: 'send'; readonly kind: 'cancel' | 'broadcast' }
  | {
      readonly stage: 'receipt';
      readonly kind: 'timeout' | 'revert' | 'cancelled' | 'replaced' | 'repriced';
    }
  | { readonly stage: 'resume-receipt'; readonly kind: 'reverted' | 'unavailable' };

export type AdapterContractHarness = {
  readonly broadcast: unknown;
  /** Spy on the receipt lookup used to verify a resume proof. */
  readonly resumeReceiptLookup?: unknown;
  /** Receipt lookups one resumed step costs. Defaults to 1. */
  readonly resumeReceiptLookupsPerStep?: number;
  /** Stages this adapter performs itself; a contract test for an absent stage is skipped. */
  readonly performs?: { readonly estimate: boolean };
  execute(
    plan: ExecutionPlan,
    form: 'direct' | 'curried',
    confirmations?: number,
    extra?: {
      readonly resume?: ExecutionResumeState;
      readonly onProgress?: (progress: ExecutionProgress) => void;
    },
  ): PromiseLike<Result<TransactionResult, SendWithError>>;
  /** Injects one failure. Harnesses without fault injection skip the failure-stage contract. */
  fail?(fault: AdapterFault, step?: number): void;
};

export type AdapterContractFactory = (configuration?: {
  readonly account?: `0x${string}`;
  readonly chainId?: number;
}) => AdapterContractHarness;

const CONTRACT_ACCOUNT_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const CONTRACT_ACCOUNT = getAddress(CONTRACT_ACCOUNT_LOWER);
const CONTRACT_TARGET = '0x2222222222222222222222222222222222222222' as const;

function contractPlan(quoteExpiresAt?: string): ExecutionPlan {
  const steps = ['one', 'two'].map((id) => {
    const result = createTransactionRequest({
      id,
      chainId: 8453,
      from: CONTRACT_ACCOUNT,
      to: CONTRACT_TARGET,
      data: '0x1234',
      operation: 'SWAP_EXACT_IN',
    });
    if (result.isErr()) throw result.error;
    return result.value;
  });
  const result = createExecutionPlan({
    steps,
    ...(quoteExpiresAt === undefined ? {} : { quoteExpiresAt }),
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

export function defineAdapterContract(name: string, factory: AdapterContractFactory): void {
  const supportsFaults = (): boolean =>
    factory({ account: CONTRACT_ACCOUNT, chainId: 8453 }).fail !== undefined;
  const harnessWithFault = (fault: AdapterFault, step = 1) => {
    const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
    harness.fail?.(fault, step);
    return harness;
  };

  async function failedAfterFirstStep() {
    const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
    if (harness.fail === undefined) return undefined;
    // A mined, reverted second step proves that step took no effect, so the
    // failure can be turned into resume state without further checks.
    harness.fail({ stage: 'receipt', kind: 'revert' }, 2);
    const valuePlan = contractPlan();
    const result = await harness.execute(valuePlan, 'direct');
    if (result.isOk()) throw new Error('expected the injected revert to fail');
    return { valuePlan, error: result.error };
  }

  describe(`${name} adapter contract`, () => {
    afterEach(() => vi.useRealTimers());

    it.each(['direct', 'curried'] as const)(
      'executes matching plans with %s invocation and preserves every hash',
      async (form) => {
        const harness = factory({ account: CONTRACT_ACCOUNT_LOWER, chainId: 8453 });
        const result = await harness.execute(contractPlan(), form, 2);

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.transactions).toHaveLength(2);
          expect(result.value.transactions.map((transaction) => transaction.stepId)).toEqual([
            'one',
            'two',
          ]);
          expect(
            result.value.transactions.every(
              (transaction) => transaction.confirmation.confirmations === 2,
            ),
          ).toBe(true);
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(2);
      },
    );

    it('rejects account and chain mismatches before broadcasting', async () => {
      const wrongAccount = factory({
        account: '0x3333333333333333333333333333333333333333',
        chainId: 8453,
      });
      const wrongChain = factory({ account: CONTRACT_ACCOUNT, chainId: 1 });

      const accountResult = await wrongAccount.execute(contractPlan(), 'direct');
      const chainResult = await wrongChain.execute(contractPlan(), 'direct');

      expect(accountResult.isErr()).toBe(true);
      if (accountResult.isErr()) expect(accountResult.error.code).toBe('ACCOUNT_MISMATCH');
      expect(chainResult.isErr()).toBe(true);
      if (chainResult.isErr()) expect(chainResult.error.code).toBe('CHAIN_MISMATCH');
      expect(wrongAccount.broadcast).not.toHaveBeenCalled();
      expect(wrongChain.broadcast).not.toHaveBeenCalled();
    });

    it('preflights every later step before broadcasting', async () => {
      const malformedHarness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const mixedAccountHarness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const mixedChainHarness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const valid = contractPlan();
      const malformed = {
        ...valid,
        steps: [valid.steps[0]!, { ...valid.steps[1]!, data: '0x123' }],
      } as ExecutionPlan;
      const mixedAccount = {
        ...valid,
        steps: [
          valid.steps[0]!,
          { ...valid.steps[1]!, from: '0x3333333333333333333333333333333333333333' },
        ],
      } as ExecutionPlan;
      const mixedChain = {
        ...valid,
        steps: [valid.steps[0]!, { ...valid.steps[1]!, chainId: 10 }],
      } as ExecutionPlan;

      const malformedResult = await malformedHarness.execute(malformed, 'direct');
      const accountResult = await mixedAccountHarness.execute(mixedAccount, 'direct');
      const chainResult = await mixedChainHarness.execute(mixedChain, 'direct');

      expect(malformedResult.isErr()).toBe(true);
      expect(accountResult.isErr()).toBe(true);
      expect(chainResult.isErr()).toBe(true);
      expect(malformedHarness.broadcast).not.toHaveBeenCalled();
      expect(mixedAccountHarness.broadcast).not.toHaveBeenCalled();
      expect(mixedChainHarness.broadcast).not.toHaveBeenCalled();
    });

    it.each(['direct', 'curried'] as const)(
      'rejects account and chain mismatches identically with %s invocation',
      async (form) => {
        const wrongAccount = factory({
          account: '0x3333333333333333333333333333333333333333',
          chainId: 8453,
        });
        const wrongChain = factory({ account: CONTRACT_ACCOUNT, chainId: 1 });

        const accountResult = await wrongAccount.execute(contractPlan(), form);
        const chainResult = await wrongChain.execute(contractPlan(), form);

        expect(accountResult.isErr()).toBe(true);
        if (accountResult.isErr()) {
          expect(accountResult.error.code).toBe('ACCOUNT_MISMATCH');
          if (accountResult.error.code === 'ACCOUNT_MISMATCH') {
            expect(accountResult.error.expectedAccount).toBe(CONTRACT_ACCOUNT);
            expect(accountResult.error.actualAccount).toBe(
              '0x3333333333333333333333333333333333333333',
            );
          }
        }
        expect(chainResult.isErr()).toBe(true);
        if (chainResult.isErr()) {
          expect(chainResult.error.code).toBe('CHAIN_MISMATCH');
          if (chainResult.error.code === 'CHAIN_MISMATCH') {
            expect(chainResult.error.expectedChainId).toBe(8453);
            expect(chainResult.error.actualChainId).toBe(1);
          }
        }
        expect(wrongAccount.broadcast).not.toHaveBeenCalled();
        expect(wrongChain.broadcast).not.toHaveBeenCalled();
      },
    );

    it.each(['direct', 'curried'] as const)(
      'rejects a malformed later step before broadcasting with %s invocation',
      async (form) => {
        const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const valid = contractPlan();
        const malformed = {
          ...valid,
          steps: [valid.steps[0]!, { ...valid.steps[1]!, data: '0x123' }],
        } as ExecutionPlan;

        const result = await harness.execute(malformed, form);

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('VALIDATION_ERROR');
          if (result.error.code === 'VALIDATION_ERROR') {
            expect(result.error.field).toBe('plan.steps[1].data');
          }
        }
        expect(harness.broadcast).not.toHaveBeenCalled();
      },
    );

    it.each(['direct', 'curried'] as const)(
      'rejects a plan requiring chain transitions before broadcasting with %s invocation',
      async (form) => {
        const sameChain = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const mixedChain = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const valuePlan = contractPlan();
        const requirements = { ...valuePlan.requirements, chainTransitions: true };
        const declared = createExecutionPlan({ steps: valuePlan.steps, requirements });
        const transitioning = createExecutionPlan({
          steps: [valuePlan.steps[0]!, { ...valuePlan.steps[1]!, chainId: 10 }],
          requirements,
        });
        if (declared.isErr()) throw declared.error;
        if (transitioning.isErr()) throw transitioning.error;

        const declaredResult = await sameChain.execute(declared.value, form);
        const transitioningResult = await mixedChain.execute(transitioning.value, form);

        for (const result of [declaredResult, transitioningResult]) {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.code).toBe('UNSUPPORTED_CAPABILITY');
            if (result.error.code === 'UNSUPPORTED_CAPABILITY') {
              expect(result.error.capability).toBe('chain-transitions');
            }
          }
        }
        expect(sameChain.broadcast).not.toHaveBeenCalled();
        expect(mixedChain.broadcast).not.toHaveBeenCalled();
      },
    );

    it.each(['direct', 'curried'] as const)(
      'rejects invalid confirmations before broadcasting with %s invocation',
      async (form) => {
        const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const result = await harness.execute(contractPlan(), form, 0);

        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(harness.broadcast).not.toHaveBeenCalled();
      },
    );

    it('negotiates unsupported batch capability before broadcasting', async () => {
      const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const valuePlan = contractPlan();
      const batch = createExecutionPlan({
        steps: valuePlan.steps,
        requirements: { ...valuePlan.requirements, execution: 'atomic-batch' },
      });
      if (batch.isErr()) throw batch.error;

      const result = await harness.execute(batch.value, 'direct');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(harness.broadcast).not.toHaveBeenCalled();
    });

    it.each([
      ['sponsored transactions', { sponsored: true }, 'sponsored-transactions'],
      ['permit authorization', { authorization: 'permit' }, 'permit-authorization'],
      ['chain transitions', { chainTransitions: true }, 'chain-transitions'],
    ] as const)(
      'rejects a plan requiring %s before any wallet interaction',
      async (_name, requirement, capability) => {
        const direct = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const curried = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const valuePlan = contractPlan();
        const required = createExecutionPlan({
          steps: valuePlan.steps,
          requirements: { ...valuePlan.requirements, ...requirement },
        });
        if (required.isErr()) throw required.error;

        const directResult = await direct.execute(required.value, 'direct');
        const curriedResult = await curried.execute(required.value, 'curried');

        for (const result of [directResult, curriedResult]) {
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.code).toBe('UNSUPPORTED_CAPABILITY');
            if (result.error.code === 'UNSUPPORTED_CAPABILITY') {
              expect(result.error.capability).toBe(capability);
              // A preflight rejection happened before execution: there is no execution context.
              expect(result.error.execution).toBeUndefined();
            }
          }
        }
        expect(direct.broadcast).not.toHaveBeenCalled();
        expect(curried.broadcast).not.toHaveBeenCalled();
      },
    );

    it('rejects a hosted plan at quote expiry before broadcasting', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-22T20:00:00Z'));
      const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const valuePlan = contractPlan('2026-07-22T20:00:00Z');

      const result = await harness.execute(valuePlan, 'direct');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('QUOTE_EXPIRED');
        if (result.error.code === 'QUOTE_EXPIRED') {
          expect(result.error.plan).toEqual(valuePlan);
          expect(result.error.quoteExpiresAt).toBe('2026-07-22T20:00:00Z');
        }
      }
      expect(harness.broadcast).not.toHaveBeenCalled();
    });

    it('executes a plan before its quote expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-22T19:59:59Z'));
      const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });

      const result = await harness.execute(contractPlan('2026-07-22T20:00:00Z'), 'direct');

      expect(result.isOk()).toBe(true);
      expect(harness.broadcast).toHaveBeenCalledTimes(2);
    });

    describe('failure stages', () => {
      it('classifies a failed gas estimate as a simulation error and sends nothing', async () => {
        const harness = harnessWithFault({ stage: 'estimate' });
        if (harness.fail === undefined || harness.performs?.estimate !== true) return;

        const result = await harness.execute(contractPlan(), 'direct');

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('SIMULATION_FAILED');
          if (result.error.code === 'SIMULATION_FAILED') {
            expect(result.error.execution).toMatchObject({
              stage: 'simulation',
              stepId: 'one',
              completed: [],
            });
          }
        }
        expect(harness.broadcast).not.toHaveBeenCalled();
      });

      it('classifies a wallet rejection as cancellation at the signing stage', async () => {
        if (!supportsFaults()) return;
        const harness = harnessWithFault({ stage: 'send', kind: 'cancel' });

        const result = await harness.execute(contractPlan(), 'direct');

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('CANCELLED');
          if (result.error.code === 'CANCELLED') {
            expect(result.error.execution).toMatchObject({ stage: 'signing', stepId: 'one' });
            expect(result.error.execution?.hash).toBeUndefined();
          }
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(1);
      });

      it('classifies a failed submission as a broadcast error', async () => {
        if (!supportsFaults()) return;
        const harness = harnessWithFault({ stage: 'send', kind: 'broadcast' });

        const result = await harness.execute(contractPlan(), 'direct');

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('BROADCAST_FAILED');
          if (result.error.code === 'BROADCAST_FAILED') {
            expect(result.error.execution).toMatchObject({ stage: 'broadcast', stepId: 'one' });
          }
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(1);
      });

      it('preserves the submitted hash and the confirmed prefix on a receipt timeout', async () => {
        if (!supportsFaults()) return;
        const harness = harnessWithFault({ stage: 'receipt', kind: 'timeout' }, 2);
        const progress: ExecutionProgress[] = [];

        const result = await harness.execute(contractPlan(), 'direct', undefined, {
          onProgress: (event) => void progress.push(event),
        });

        expect(result.isErr()).toBe(true);
        const submitted = progress.filter((event) => event.type === 'step-submitted');
        expect(submitted).toHaveLength(2);
        if (result.isErr()) {
          expect(result.error.code).toBe('CONFIRMATION_FAILED');
          if (result.error.code === 'CONFIRMATION_FAILED') {
            expect(result.error.execution).toMatchObject({
              stage: 'confirmation',
              stepId: 'two',
              stepIndex: 1,
            });
            expect(result.error.execution?.hash).toBe(
              submitted[1]?.type === 'step-submitted' ? submitted[1].hash : undefined,
            );
            expect(result.error.execution?.completed).toHaveLength(1);
            expect(result.error.execution?.completed[0]).toMatchObject({
              stepId: 'one',
              stepIndex: 0,
              confirmation: { status: 'success' },
            });
          }
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(2);
      });

      it('classifies a reverted receipt as a transaction error with its hash', async () => {
        if (!supportsFaults()) return;
        const harness = harnessWithFault({ stage: 'receipt', kind: 'revert' });

        const result = await harness.execute(contractPlan(), 'direct');

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('TRANSACTION_REVERTED');
          if (result.error.code === 'TRANSACTION_REVERTED') {
            expect(result.error.txHash).toMatch(/^0x[0-9a-f]{64}$/);
            expect(result.error.execution).toMatchObject({
              stage: 'revert',
              stepId: 'one',
              hash: result.error.txHash,
            });
          }
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(1);
      });

      it.each(['cancelled', 'replaced'] as const)(
        'stops at the replacement stage when a step is %s',
        async (kind) => {
          if (!supportsFaults()) return;
          const harness = harnessWithFault({ stage: 'receipt', kind });

          const result = await harness.execute(contractPlan(), 'direct');

          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.code).toBe('CONFIRMATION_FAILED');
            if (result.error.code === 'CONFIRMATION_FAILED') {
              expect(result.error.execution).toMatchObject({
                stage: 'replacement',
                stepId: 'one',
                completed: [],
              });
              expect(result.error.execution?.hash).toMatch(/^0x[0-9a-f]{64}$/);
            }
          }
          expect(harness.broadcast).toHaveBeenCalledTimes(1);
        },
      );

      it('accepts a repriced step and records both hashes', async () => {
        if (!supportsFaults()) return;
        const harness = harnessWithFault({ stage: 'receipt', kind: 'repriced' });

        const result = await harness.execute(contractPlan(), 'direct');

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          const first = result.value.transactions[0]!;
          expect(first.hash).not.toBe(first.submittedHash);
          expect(first.replacement).toEqual({
            reason: 'repriced',
            originalHash: first.submittedHash,
            replacementHash: first.hash,
          });
          expect(first.confirmation.transactionHash).toBe(first.hash);
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(2);
      });
    });

    describe('resume', () => {
      it.each(['direct', 'curried'] as const)(
        'resumes from a failure-derived state, re-verifies the prefix, and sends only the rest with %s invocation',
        async (form) => {
          const failed = await failedAfterFirstStep();
          if (failed === undefined) return;
          const derived = executionResumeStateFromError(failed.valuePlan, failed.error);
          if (derived.isErr()) throw derived.error;
          expect(derived.value.confirmed).toHaveLength(1);
          // The state survives the canonical serializer, as it would across a restart.
          const serialized = serializeExecutionResumeState(derived.value);
          if (serialized.isErr()) throw serialized.error;
          const restored = deserializeExecutionResumeState(serialized.value);
          if (restored.isErr()) throw restored.error;
          expect(restored.value).toEqual(derived.value);

          const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
          const progress: ExecutionProgress[] = [];
          const result = await harness.execute(failed.valuePlan, form, undefined, {
            resume: restored.value,
            onProgress: (event) => void progress.push(event),
          });

          expect(result.isOk()).toBe(true);
          if (result.isOk()) {
            expect(result.value.transactions.map((transaction) => transaction.stepId)).toEqual([
              'one',
              'two',
            ]);
            // The confirmed prefix is carried over untouched, not re-executed.
            expect(result.value.transactions[0]).toEqual(restored.value.confirmed[0]);
          }
          expect(harness.broadcast).toHaveBeenCalledTimes(1);
          expect(harness.resumeReceiptLookup).toHaveBeenCalledTimes(
            harness.resumeReceiptLookupsPerStep ?? 1,
          );
          expect(progress[0]).toMatchObject({ type: 'preflight-complete', resumedSteps: 1 });
          expect(
            progress
              .filter((event) => event.type === 'step-started')
              .map((event) => (event.type === 'step-started' ? event.stepId : '')),
          ).toEqual(['two']);
        },
      );

      it('refuses to derive resume state from a receipt timeout until the caller resolves the step', async () => {
        const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        if (harness.fail === undefined) return;
        harness.fail({ stage: 'receipt', kind: 'timeout' }, 2);
        const valuePlan = contractPlan();
        const result = await harness.execute(valuePlan, 'direct');
        if (result.isOk()) throw new Error('expected the injected receipt timeout to fail');
        const hash =
          result.error.code === 'CONFIRMATION_FAILED' ? result.error.execution?.hash : undefined;

        const refused = executionResumeStateFromError(valuePlan, result.error);
        const acknowledged = executionResumeStateFromError(valuePlan, result.error, {
          unresolvedStep: 'assume-not-executed',
        });

        // Step two was submitted and may still confirm: resuming would send it again.
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(refused.isErr()).toBe(true);
        if (refused.isErr()) {
          expect(refused.error.field).toBe('error.execution.stage');
          expect(refused.error.details).toMatchObject({
            stage: 'confirmation',
            stepId: 'two',
            hash,
          });
        }
        expect(acknowledged.isOk()).toBe(true);
        if (acknowledged.isOk()) {
          expect(acknowledged.value.confirmed.map((step) => step.stepId)).toEqual(['one']);
        }
      });

      it('keeps the failure context loggable with JSON.stringify', async () => {
        const failed = await failedAfterFirstStep();
        if (failed === undefined) return;
        if (!('execution' in failed.error) || failed.error.execution === undefined) {
          throw new Error('expected an execution context');
        }
        const execution = failed.error.execution;

        // The live context keeps bigint receipt fields; logging it must not throw.
        expect(typeof execution.completed[0]?.confirmation?.gasUsed).toBe('bigint');
        const logged = JSON.parse(JSON.stringify(execution)) as {
          completed: { stepId: string; confirmation: Record<string, unknown> }[];
        };
        expect(logged.completed[0]?.stepId).toBe('one');
        expect(logged.completed[0]?.confirmation).toMatchObject({ status: 'success' });
        expect(typeof logged.completed[0]?.confirmation.gasUsed).toBe('string');
        expect(() => JSON.stringify(failed.error)).not.toThrow();
      });

      it.each(['reverted', 'unavailable'] as const)(
        'sends nothing when the resume proof receipt is %s',
        async (kind) => {
          const failed = await failedAfterFirstStep();
          if (failed === undefined) return;
          const derived = executionResumeStateFromError(failed.valuePlan, failed.error);
          if (derived.isErr()) throw derived.error;
          const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
          harness.fail?.({ stage: 'resume-receipt', kind });

          const result = await harness.execute(failed.valuePlan, 'direct', undefined, {
            resume: derived.value,
          });

          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.code).toBe('CONFIRMATION_FAILED');
            if (result.error.code === 'CONFIRMATION_FAILED') {
              expect(result.error.execution).toMatchObject({
                stage: 'confirmation',
                stepId: 'one',
                hash: derived.value.confirmed[0]?.hash,
                completed: [],
              });
            }
          }
          expect(harness.broadcast).not.toHaveBeenCalled();
        },
      );

      it('rejects resume state that claims a step the plan does not have before sending', async () => {
        const failed = await failedAfterFirstStep();
        if (failed === undefined) return;
        const derived = executionResumeStateFromError(failed.valuePlan, failed.error);
        if (derived.isErr()) throw derived.error;
        const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const tampered: ExecutionResumeState = {
          planId: derived.value.planId,
          confirmed: [{ ...derived.value.confirmed[0]!, stepId: 'two' }],
        };

        const result = await harness.execute(failed.valuePlan, 'direct', undefined, {
          resume: tampered,
        });

        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(harness.broadcast).not.toHaveBeenCalled();
        expect(harness.resumeReceiptLookup).not.toHaveBeenCalled();
      });

      it('reports the confirmed prefix when the quote expires before a later step', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-22T19:59:59Z'));
        const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
        const valuePlan = contractPlan('2026-07-22T20:00:00Z');
        const result = await harness.execute(valuePlan, 'direct', undefined, {
          onProgress: (event) => {
            // The quote expires once the first step has confirmed.
            if (event.type === 'step-confirmed') vi.setSystemTime(new Date('2026-07-22T20:00:00Z'));
          },
        });

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe('QUOTE_EXPIRED');
          if (result.error.code === 'QUOTE_EXPIRED') {
            expect(result.error.execution).toMatchObject({ stepId: 'two', stepIndex: 1 });
            expect(result.error.execution?.completed).toHaveLength(1);
            const derived = executionResumeStateFromError(valuePlan, result.error);
            expect(derived.isOk()).toBe(true);
            if (derived.isOk()) expect(derived.value.confirmed[0]?.stepId).toBe('one');
          }
        }
        expect(harness.broadcast).toHaveBeenCalledTimes(1);
      });
    });

    it('rejects a constrained plan with detached quote expiry before broadcasting', async () => {
      const harness = factory({ account: CONTRACT_ACCOUNT, chainId: 8453 });
      const valuePlan = contractPlan('2026-07-22T20:00:00Z');
      const detached = { ...valuePlan, quoteExpiresAt: undefined } as unknown as ExecutionPlan;

      const result = await harness.execute(detached, 'direct');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(harness.broadcast).not.toHaveBeenCalled();
    });
  });
}
