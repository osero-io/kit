import { getAddress } from 'viem';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { OseroApiTransferState, OseroApiTransferStatus } from './api.js';
import { CHAINS, type OseroChainId } from './chains.js';
import { OseroClient, type OseroPublicClient } from './OseroClient.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import type { Result } from './result.js';
import type { ExecutionPlan, SendWithError, TransactionResult } from './types.js';

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

function transferStatusFixtureBase(state: OseroApiTransferState) {
  return {
    state,
    sourceChainId: 8453,
    destinationChainId: 1,
    bridge: 'future-bridge',
    sourceTransactionHash: TEST_SOURCE_TRANSACTION_HASH,
    destinationTransactionHash: state === 'completed' ? TEST_DESTINATION_TRANSACTION_HASH : null,
    error: state === 'failed' ? 'bridge failed' : null,
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

export function createMockClient(
  chainId: OseroChainId,
  overrides: Partial<MockPublicClient> = {},
): { readonly client: OseroClient; readonly publicClient: MockPublicClient } {
  const unexpected = (operation: string) =>
    mockFn(() => Promise.reject(new Error(`Unexpected ${operation} call`)));
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

export type AdapterContractHarness = {
  readonly broadcast: unknown;
  execute(
    plan: ExecutionPlan,
    form: 'direct' | 'curried',
    confirmations?: number,
  ): PromiseLike<Result<TransactionResult, SendWithError>>;
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
