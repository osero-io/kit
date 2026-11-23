import {
  ContractFunctionRevertedError,
  custom,
  encodeErrorResult,
  ExecutionRevertedError,
  type Hex,
} from 'viem';

import { createMockClient, mockFn, type MockPublicClient } from './_testing.js';
import { parseSlippage } from './domain.js';
import { RpcError, SimulationError, UnsupportedCapabilityError } from './errors.js';
import { OseroClient, type OseroPublicClient } from './OseroClient.js';
import {
  createApprovalTransaction,
  createExecutionPlan,
  createTransactionRequest,
} from './plan.js';
import { simulateExecutionPlan } from './simulation.js';
import type { ExecutionPlan, PreparedSwapQuote } from './types.js';

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

  it('pins its reads to an uncached head', async () => {
    const { client, publicClient } = simulationClient();

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    // viem serves getBlockNumber from a cache unless cacheTime is 0; a cached head can predate
    // the transaction the caller has just sent.
    expect(publicClient.getBlockNumber.mock.calls).toEqual([[{ cacheTime: 0 }]]);
    expect(publicClient.getBalance).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 123n }),
    );
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

// F14: simulation is a read-only preflight. These pin the scope reported for a one-step plan
// and prove the public client is only ever asked to read or estimate.

function singleStepPlan(): ExecutionPlan {
  const swap = createTransactionRequest({
    id: 'swap',
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
  });
  if (swap.isErr()) throw swap.error;
  const plan = createExecutionPlan({ steps: [swap.value] });
  if (plan.isErr()) throw plan.error;
  return plan.value;
}

const READ_ONLY_RPC_SURFACE = [
  'estimateFeesPerGas',
  'estimateGas',
  'getBalance',
  'getBlockNumber',
  'readContract',
] as const;

function signingAndBroadcastSpies() {
  return {
    request: mockFn(async () => Promise.reject(new Error('Unexpected raw request'))),
    sendRawTransaction: mockFn(async () => Promise.reject(new Error('Unexpected broadcast'))),
    sendTransaction: mockFn(async () => Promise.reject(new Error('Unexpected broadcast'))),
    signMessage: mockFn(async () => Promise.reject(new Error('Unexpected signature'))),
    signTransaction: mockFn(async () => Promise.reject(new Error('Unexpected signature'))),
    signTypedData: mockFn(async () => Promise.reject(new Error('Unexpected signature'))),
    simulateContract: mockFn(async () => Promise.reject(new Error('Unexpected simulateContract'))),
    writeContract: mockFn(async () => Promise.reject(new Error('Unexpected broadcast'))),
  };
}

/**
 * A simulation client whose public client also carries send/sign spies, wrapped so every
 * function-valued member that simulation reaches for is recorded by name.
 */
function recordingSimulationClient() {
  const spies = signingAndBroadcastSpies();
  const { publicClient } = simulationClient(spies as Partial<MockPublicClient>);
  const touched = new Set<string>();
  const recording = new Proxy(publicClient, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key === 'string' && (typeof value === 'function' || value === undefined)) {
        touched.add(key);
      }
      return value;
    },
  });
  const client = OseroClient.create({
    publicClients: { 8453: recording as unknown as OseroPublicClient },
  });
  return { client, publicClient, spies, touched };
}

describe('simulateExecutionPlan read-only scope', () => {
  it('reports single-step scope for a one-step plan', async () => {
    const { client, publicClient } = simulationClient();
    const plan = singleStepPlan();

    const result = await simulateExecutionPlan(client, plan, ACCOUNT);

    expect(plan.steps).toHaveLength(1);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.scope).toBe('single-step');
      expect(result.value.planId).toBe(plan.id);
      expect(result.value.steps).toEqual([
        {
          stepId: 'swap',
          stepIndex: 0,
          operation: 'SWAP_EXACT_IN',
          independentlySimulated: true,
          conditionalOnPriorSteps: false,
          result: { status: 'success', estimatedGas: 100n, estimatedNativeFee: 400n },
        },
      ]);
      expect(result.value.allowances).toEqual([]);
      expect(result.value.tokenBalances).toEqual([]);
    }
    expect(publicClient.estimateGas).toHaveBeenCalledOnce();
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it.each([
    ['a single-step plan', singleStepPlan, 'single-step', 1, 0],
    ['a multi-step plan', executionPlan, 'independent-steps', 2, 2],
  ] as const)(
    'only reads and estimates for %s and never signs or broadcasts',
    async (_label, buildPlan, scope, estimates, reads) => {
      const { client, publicClient, spies, touched } = recordingSimulationClient();

      const result = await simulateExecutionPlan(client, buildPlan(), ACCOUNT);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value.scope).toBe(scope);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
      expect(publicClient.multicall).not.toHaveBeenCalled();
      for (const method of touched) expect(READ_ONLY_RPC_SURFACE).toContain(method);
      expect(touched).toContain('estimateGas');
      expect(publicClient.getBlockNumber).toHaveBeenCalledOnce();
      expect(publicClient.getBalance).toHaveBeenCalledOnce();
      expect(publicClient.estimateFeesPerGas).toHaveBeenCalledOnce();
      expect(publicClient.estimateGas).toHaveBeenCalledTimes(estimates);
      expect(publicClient.readContract).toHaveBeenCalledTimes(reads);
    },
  );

  it('does not sign or broadcast when a step simulation fails', async () => {
    const { client, publicClient, spies, touched } = recordingSimulationClient();
    publicClient.estimateGas.mockRejectedValue(new Error('swap would revert'));

    const result = await simulateExecutionPlan(client, singleStepPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.scope).toBe('single-step');
      expect(result.value.steps[0]?.result.status).toBe('failed');
    }
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    for (const method of touched) expect(READ_ONLY_RPC_SURFACE).toContain(method);
  });
});

const ERROR_STRING_ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
] as const;
const PANIC_ABI = [
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;
const CUSTOM_ERROR_DATA =
  '0xdeadbeef000000000000000000000000000000000000000000000000000000000000002a';

function revertData(message: string): Hex {
  return encodeErrorResult({ abi: ERROR_STRING_ABI, errorName: 'Error', args: [message] });
}

async function failedSwapStep(cause: unknown) {
  const estimateGas = mockFn().mockResolvedValueOnce(90n).mockRejectedValueOnce(cause);
  const { client } = simulationClient({ estimateGas });
  const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);
  if (result.isErr()) throw result.error;
  const failed = result.value.steps[1]!.result;
  if (failed.status !== 'failed') throw new Error('expected the swap step to fail');
  return failed;
}

describe('simulation fee basis', () => {
  it('labels an EIP-1559 fee cap and exposes it without changing gasPrice', async () => {
    const { client } = simulationClient();

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.feeData).toEqual({
        gasPrice: 4n,
        source: 'rpc',
        basis: 'max-fee-per-gas',
        maxFeePerGas: 4n,
      });
      expect(result.value.steps[0]?.result).toMatchObject({ estimatedNativeFee: 400n });
    }
  });

  it('labels a legacy gas price and omits the fee cap', async () => {
    const { client } = simulationClient({
      estimateFeesPerGas: mockFn(async () => ({ gasPrice: 3n })),
    });

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.feeData).toEqual({ gasPrice: 3n, source: 'rpc', basis: 'gas-price' });
      expect('maxFeePerGas' in result.value.feeData).toBe(false);
      expect(result.value.steps[0]?.result).toMatchObject({ estimatedNativeFee: 300n });
    }
  });
});

describe('simulation revert details', () => {
  it('reports the reason from a viem contract revert error', async () => {
    const failed = await failedSwapStep(
      new ContractFunctionRevertedError({
        abi: [],
        functionName: 'swapExactIn',
        message: 'PSM3/amountOut-too-low',
      }),
    );

    expect(failed.revert).toEqual({ reason: 'PSM3/amountOut-too-low' });
    expect(failed.error).toBeInstanceOf(SimulationError);
  });

  it('decodes a standard Error(string) from raw revert data deep in the cause chain', async () => {
    const data = revertData('PSM3/zero-liquidity');
    const rpc = Object.assign(new Error('execution reverted'), { code: 3, data });
    const failed = await failedSwapStep(new Error('estimate failed', { cause: rpc }));

    expect(failed.revert).toEqual({ reason: 'PSM3/zero-liquidity', data });
  });

  it('reads revert data nested one level inside an RPC error payload', async () => {
    const data = revertData('nested');
    const failed = await failedSwapStep(
      Object.assign(new Error('rpc error'), { data: { message: 'reverted', data } }),
    );

    expect(failed.revert).toEqual({ reason: 'nested', data });
  });

  it('decodes a Panic code', async () => {
    const data = encodeErrorResult({ abi: PANIC_ABI, errorName: 'Panic', args: [17n] });
    const failed = await failedSwapStep(Object.assign(new Error('reverted'), { data }));

    expect(failed.revert).toEqual({ reason: 'Panic(17)', data });
  });

  it('keeps custom error data raw instead of guessing a reason', async () => {
    const failed = await failedSwapStep(
      Object.assign(new Error('reverted'), { data: CUSTOM_ERROR_DATA }),
    );

    expect(failed.revert).toEqual({ data: CUSTOM_ERROR_DATA });
  });

  it('reads the reason a node reports without revert data', async () => {
    const failed = await failedSwapStep(
      new ExecutionRevertedError({ message: 'execution reverted: SUsds/insufficient-balance' }),
    );

    expect(failed.revert).toEqual({ reason: 'SUsds/insufficient-balance' });
  });

  it.each([
    ['a plain error', new Error('swap would revert')],
    ['empty revert data', Object.assign(new Error('reverted'), { data: '0x' })],
    ['a non-error rejection', 'boom'],
    [
      'a self-referential cause',
      (() => {
        const loop: { cause?: unknown } = {};
        loop.cause = loop;
        return loop;
      })(),
    ],
  ])('reports no revert details for %s', async (_name, cause) => {
    const failed = await failedSwapStep(cause);

    expect('revert' in failed).toBe(false);
    expect(failed.error).toBeInstanceOf(SimulationError);
  });

  it('reports no revert details for empty data nested in an RPC payload or a viem error', async () => {
    const nested = await failedSwapStep(
      Object.assign(new Error('rpc error'), { data: { message: 'reverted', data: '0x' } }),
    );
    const viemError = await failedSwapStep(
      Object.assign(new ContractFunctionRevertedError({ abi: [], functionName: 'swapExactIn' }), {
        raw: '0x',
      }),
    );

    expect('revert' in nested).toBe(false);
    expect(viemError.revert?.data).toBeUndefined();
  });

  it('decodes a revert that travelled through a real viem public client', async () => {
    const data = revertData('PSM3/swap-paused');
    const transport = custom({
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case 'eth_blockNumber':
            return '0x7b';
          case 'eth_getBalance':
            return '0xf4240';
          case 'eth_gasPrice':
            return '0x3';
          case 'eth_maxPriorityFeePerGas':
            return '0x1';
          case 'eth_getBlockByNumber':
            return { baseFeePerGas: '0x1', number: '0x7b', hash: null, transactions: [] };
          case 'eth_call':
            return `0x${'0'.repeat(63)}7`;
          case 'eth_estimateGas':
            throw Object.assign(new Error('execution reverted: PSM3/swap-paused'), {
              code: 3,
              data,
            });
          default:
            throw new Error(`unexpected RPC ${method}`);
        }
      },
    });
    const client = OseroClient.create({ transports: { 8453: transport } });

    const result = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      for (const step of result.value.steps) {
        expect(step.result.status).toBe('failed');
        if (step.result.status === 'failed') {
          expect(step.result.revert?.reason).toBe('PSM3/swap-paused');
        }
      }
    }
  });
});

describe('simulation quote bounds', () => {
  const slippage = parseSlippage({ bps: '5' });
  if (slippage.isErr()) throw slippage.error;
  const common = {
    assetIn: 'USDC',
    assetOut: 'sUSDS',
    slippage: slippage.value,
    route: {
      chainId: 8453,
      protocol: 'psm3',
      assetIn: 'USDC',
      assetOut: 'sUSDS',
      mode: 'exact-in',
      steps: ['APPROVE_ERC20', 'SWAP_EXACT_IN'],
    },
    slippageProtection: { bound: 'minimum-output', enforcedBy: 'calldata' },
    quotedAt: { blockNumber: 120n },
    protocolFee: { kind: 'none' },
  } as const;

  function exactInQuote(plan: ExecutionPlan): PreparedSwapQuote {
    return {
      ...common,
      mode: 'exact-in',
      amountIn: { symbol: 'USDC', raw: 10n },
      expectedAmountOut: { symbol: 'sUSDS', raw: 9_000n },
      minimumAmountOut: { symbol: 'sUSDS', raw: 8_995n },
      plan,
    };
  }

  it('echoes exact-input bounds for the simulated plan', async () => {
    const { client } = simulationClient();
    const plan = executionPlan();

    const result = await simulateExecutionPlan(client, plan, ACCOUNT, {
      quote: exactInQuote(plan),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.quote).toEqual({
        mode: 'exact-in',
        assetIn: 'USDC',
        assetOut: 'sUSDS',
        slippageProtection: { bound: 'minimum-output', enforcedBy: 'calldata' },
        quotedAtBlock: 120n,
        amountIn: { symbol: 'USDC', raw: 10n },
        expectedAmountOut: { symbol: 'sUSDS', raw: 9_000n },
        minimumAmountOut: { symbol: 'sUSDS', raw: 8_995n },
      });
    }
  });

  it('echoes exact-output bounds with the maximum input', async () => {
    const { client } = simulationClient();
    const plan = executionPlan();
    const quote: PreparedSwapQuote = {
      ...common,
      route: { ...common.route, mode: 'exact-out' },
      slippageProtection: { bound: 'maximum-input', enforcedBy: 'calldata' },
      mode: 'exact-out',
      amountOut: { symbol: 'sUSDS', raw: 9_000n },
      expectedAmountIn: { symbol: 'USDC', raw: 10n },
      maximumAmountIn: { symbol: 'USDC', raw: 11n },
      plan,
    };

    const result = await simulateExecutionPlan(client, plan, ACCOUNT, { quote });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.quote).toMatchObject({
        mode: 'exact-out',
        amountOut: { symbol: 'sUSDS', raw: 9_000n },
        expectedAmountIn: { symbol: 'USDC', raw: 10n },
        maximumAmountIn: { symbol: 'USDC', raw: 11n },
        slippageProtection: { bound: 'maximum-input' },
      });
    }
  });

  it('adds no quote field when no quote is supplied', async () => {
    const { client } = simulationClient();

    const bare = await simulateExecutionPlan(client, executionPlan(), ACCOUNT);
    const empty = await simulateExecutionPlan(client, executionPlan(), ACCOUNT, {});

    for (const result of [bare, empty]) {
      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect('quote' in result.value).toBe(false);
    }
  });

  it('rejects a quote for a different plan before any RPC call', async () => {
    const { client, publicClient } = simulationClient();
    const plan = executionPlan();
    const otherStep = createTransactionRequest({
      id: 'swap',
      chainId: 8453,
      from: ACCOUNT,
      to: TARGET,
      data: '0xbeef',
      operation: 'SWAP_EXACT_IN',
    });
    if (otherStep.isErr()) throw otherStep.error;
    const other = createExecutionPlan({ steps: [otherStep.value] });
    if (other.isErr()) throw other.error;

    const result = await simulateExecutionPlan(client, plan, ACCOUNT, {
      quote: exactInQuote(other.value),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      if (result.error.code === 'VALIDATION_ERROR') {
        expect(result.error.field).toBe('options.quote');
      }
    }
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });

  it('rejects a plan that borrows the quoted plan id for different transactions', async () => {
    const { client, publicClient } = simulationClient();
    const quoted = executionPlan();
    const impostor = {
      ...quoted,
      steps: [quoted.steps[0]!, { ...quoted.steps[1]!, data: '0xbeef' as const }],
    };

    const result = await simulateExecutionPlan(client, impostor, ACCOUNT, {
      quote: exactInQuote(quoted),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });

  it.each([
    ['null options', () => null],
    ['a null quote', () => ({ quote: null })],
    ['a quote without a plan', () => ({ quote: {} })],
    ['a quote that is only a plan', (plan: ExecutionPlan) => ({ quote: { plan } })],
    [
      'a quote without its quote block',
      (plan: ExecutionPlan) => ({ quote: { ...exactInQuote(plan), quotedAt: undefined } }),
    ],
    [
      'a quote whose quote block is not a bigint',
      (plan: ExecutionPlan) => ({
        quote: { ...exactInQuote(plan), quotedAt: { blockNumber: 120 } },
      }),
    ],
    [
      'a quote with an unknown mode',
      (plan: ExecutionPlan) => ({ quote: { ...exactInQuote(plan), mode: 'exact-ish' } }),
    ],
    [
      'an exact-input quote without its minimum output',
      (plan: ExecutionPlan) => ({
        quote: { ...exactInQuote(plan), minimumAmountOut: undefined },
      }),
    ],
    [
      'a quote whose amount is not a bigint',
      (plan: ExecutionPlan) => ({
        quote: { ...exactInQuote(plan), expectedAmountOut: { symbol: 'sUSDS', raw: '9000' } },
      }),
    ],
    [
      'a quote without slippage protection',
      (plan: ExecutionPlan) => ({
        quote: { ...exactInQuote(plan), slippageProtection: undefined },
      }),
    ],
  ])('rejects %s as a validation result before any RPC call', async (_name, build) => {
    const { client, publicClient } = simulationClient();
    const plan = executionPlan();

    const pending = simulateExecutionPlan(client, plan, ACCOUNT, build(plan) as never);

    // The failure is a returned Err, never a rejected promise.
    await expect(Promise.resolve(pending)).resolves.toBeDefined();
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.estimateGas).not.toHaveBeenCalled();
  });
});
