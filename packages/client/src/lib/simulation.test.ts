import { createMockClient, mockFn, type MockPublicClient } from './_testing.js';
import { RpcError, SimulationError, UnsupportedCapabilityError } from './errors.js';
import {
  createApprovalTransaction,
  createExecutionPlan,
  createTransactionRequest,
} from './plan.js';
import { simulateExecutionPlan } from './simulation.js';
import type { ExecutionPlan } from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const SPENDER = '0x4444444444444444444444444444444444444444' as const;
const TARGET = '0x5555555555555555555555555555555555555555' as const;

function executionPlan(): ExecutionPlan {
  const approval = createApprovalTransaction({
    id: 'approve',
    chainId: 8453,
    owner: ACCOUNT,
    token: TOKEN,
    spender: SPENDER,
    amount: 10n,
  });
  const swap = createTransactionRequest({
    id: 'swap',
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
  });
  if (approval.isErr() || swap.isErr()) throw new Error('test transaction failed');
  const plan = createExecutionPlan({
    steps: [approval.value, swap.value],
    metadata: {
      source: 'local',
      allowanceSnapshots: [
        {
          token: TOKEN,
          owner: ACCOUNT,
          spender: SPENDER,
          allowance: 0n,
          requiredAmount: 10n,
          approvalAmount: 10n,
          policy: 'exact',
          observedAtBlock: 100n,
        },
      ],
    },
  });
  if (plan.isErr()) throw plan.error;
  return plan.value;
}

function simulationClient(overrides: Partial<MockPublicClient> = {}) {
  const readContract = mockFn(async (request: { functionName: string }) =>
    request.functionName === 'allowance' ? 7n : 99n,
  );
  return createMockClient(8453, {
    getBlockNumber: mockFn(async () => 123n),
    getBalance: mockFn(async () => 1_000_000n),
    estimateFeesPerGas: mockFn(async () => ({ maxFeePerGas: 4n, gasPrice: 2n })),
    estimateGas: mockFn(async () => 100n),
    readContract,
    ...overrides,
  });
}

describe('simulateExecutionPlan', () => {
  it('reports pinned provenance, live balances, allowances, fees, and independent-step scope', async () => {
    const { client, publicClient } = simulationClient();

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toMatchObject({
        account: ACCOUNT,
        chainId: 8453,
        blockNumber: 123n,
        scope: 'independent-steps',
        nativeBalance: 1_000_000n,
        feeData: { gasPrice: 4n, source: 'rpc' },
        provenance: { transportType: 'mock', chainName: 'Base' },
      });
      expect(result.value.allowances).toEqual([
        { token: TOKEN, owner: ACCOUNT, spender: SPENDER, allowance: 7n },
      ]);
      expect(result.value.tokenBalances).toEqual([
        { token: TOKEN, account: ACCOUNT, balance: 99n },
      ]);
      expect(result.value.steps).toEqual([
        expect.objectContaining({
          stepId: 'approve',
          conditionalOnPriorSteps: false,
          result: { status: 'success', estimatedGas: 100n, estimatedNativeFee: 400n },
        }),
        expect.objectContaining({
          stepId: 'swap',
          conditionalOnPriorSteps: true,
          result: { status: 'success', estimatedGas: 100n, estimatedNativeFee: 400n },
        }),
      ]);
    }
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
    expect(publicClient.estimateGas).toHaveBeenCalledTimes(2);
  });

  it('keeps a step simulation failure inside an otherwise useful report', async () => {
    const estimateGas = mockFn()
      .mockResolvedValueOnce(90n)
      .mockRejectedValueOnce(new Error('swap would revert'));
    const { client } = simulationClient({ estimateGas });

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.steps[0]?.result.status).toBe('success');
      const failed = result.value.steps[1]?.result;
      expect(failed?.status).toBe('failed');
      if (failed?.status === 'failed') {
        expect(failed.error).toBeInstanceOf(SimulationError);
        expect(failed.error.execution).toMatchObject({
          planId: result.value.planId,
          stepId: 'swap',
          stage: 'simulation',
        });
      }
    }
  });

  it('uses legacy gas price when EIP-1559 maxFeePerGas is absent', async () => {
    const { client } = simulationClient({
      estimateFeesPerGas: mockFn(async () => ({ gasPrice: 3n })),
    });

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.feeData.gasPrice).toBe(3n);
      expect(result.value.steps[0]?.result).toMatchObject({ estimatedNativeFee: 300n });
    }
  });

  it('preflights account binding before making RPC calls', async () => {
    const { client, publicClient } = simulationClient();

    const result = await simulateExecutionPlan(client, executionPlan(), OTHER_ACCOUNT);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('ACCOUNT_MISMATCH');
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns unsupported-capability before observation reads', async () => {
    const { client, publicClient } = simulationClient({ estimateGas: undefined as never });

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it.each([
    ['getBlockNumber', { getBlockNumber: mockFn(async () => Promise.reject(new Error('block'))) }],
    ['getBalance', { getBalance: mockFn(async () => Promise.reject(new Error('balance'))) }],
    [
      'estimateFeesPerGas',
      { estimateFeesPerGas: mockFn(async () => Promise.reject(new Error('fees'))) },
    ],
    ['readContract', { readContract: mockFn(async () => Promise.reject(new Error('read'))) }],
  ] as const)('returns %s RPC failure with operation context', async (operation, overrides) => {
    const { client } = simulationClient(overrides);

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(RpcError);
      if (result.error instanceof RpcError) expect(result.error.operation).toBe(operation);
    }
  });

  it('rejects a structurally empty plan as a validation result', async () => {
    const { client } = simulationClient();
    const empty = { ...executionPlan(), steps: [] } as unknown as ExecutionPlan;

    const result = await simulateExecutionPlan(client, empty, ACCOUNT);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
  });
});
