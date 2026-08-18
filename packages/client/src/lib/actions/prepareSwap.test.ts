import { decodeFunctionData, type Address } from 'viem';

import { createMockClient, mockFn, type MockPublicClient } from '../_testing.js';
import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { CHAIN_CAPABILITIES, type OseroChainId, type TokenSymbol } from '../capabilities.js';
import { parseSlippage, referral, tokenAmount, UINT256_MAX, type TokenAmount } from '../domain.js';
import { InsufficientAllowanceError, ValidationError } from '../errors.js';
import { applySlippageDown, applySlippageUp, USDC_TO_USDS_SCALE } from '../math.js';
import { OseroClient, type OseroPublicClient } from '../OseroClient.js';
import type { Result } from '../result.js';
import type { PreparedSwapQuote } from '../types.js';
import { prepareSwap, type PrepareSwapRequest } from './prepareSwap.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const RECEIVER = '0x2222222222222222222222222222222222222222' as const;
const BLOCK = 12_345n;

type ReadArgs = {
  readonly functionName: string;
  readonly args?: readonly unknown[];
};

type Setup = {
  readonly client: OseroClient;
  readonly publicClient: MockPublicClient;
  readonly setAllowance: (allowance: bigint) => void;
};

function setup(chainId: OseroChainId, initialAllowance = 0n, tin = 0n): Setup {
  let allowance = initialAllowance;
  const readContract = mockFn(async (args: ReadArgs): Promise<bigint> => {
    switch (args.functionName) {
      case 'allowance':
        return allowance;
      case 'tin':
        return tin;
      case 'tout':
        return 0n;
      case 'previewSwapExactIn':
      case 'previewSwapExactOut':
        return args.args?.[2] as bigint;
      case 'previewDeposit':
      case 'previewMint':
      case 'previewRedeem':
      case 'previewWithdraw':
        return args.args?.[0] as bigint;
      default:
        throw new Error(`Unexpected read ${args.functionName}`);
    }
  });
  const { client, publicClient } = createMockClient(chainId, {
    getBlockNumber: mockFn(async () => BLOCK),
    readContract,
  });
  return {
    client,
    publicClient,
    setAllowance(value) {
      allowance = value;
    },
  };
}

function amount<Symbol extends TokenSymbol>(symbol: Symbol, raw = 1_000_000n): TokenAmount<Symbol> {
  const result = tokenAmount(symbol, raw);
  if (result.isErr()) throw result.error;
  return result.value;
}

function slippage(value = '5') {
  const result = parseSlippage({ bps: value });
  if (result.isErr()) throw result.error;
  return result.value;
}

function referralValue(code = 3000n) {
  const result = referral(code);
  if (result.isErr()) throw result.error;
  return result.value;
}

async function prepare(
  client: OseroClient,
  request: PrepareSwapRequest,
): Promise<Result<PreparedSwapQuote, unknown>> {
  const dynamicPrepare = prepareSwap as unknown as (
    valueClient: OseroClient,
    valueRequest: PrepareSwapRequest,
  ) => PromiseLike<Result<PreparedSwapQuote, unknown>>;
  return dynamicPrepare(client, request);
}

describe('prepareSwap route matrix', () => {
  for (const chainId of [1, 10, 130, 8453, 42161] as const) {
    for (const route of CHAIN_CAPABILITIES[chainId].routes) {
      for (const mode of ['exact-in', 'exact-out'] as const) {
        if (mode === 'exact-in' && !route.exactIn) continue;
        if (mode === 'exact-out' && !route.exactOut) continue;

        it(`prepares ${mode} ${route.assetIn} -> ${route.assetOut} on ${chainId}`, async () => {
          const { client } = setup(chainId);
          const referralCapability =
            mode === 'exact-in' ? route.exactInReferral : route.exactOutReferral;
          const common = {
            chainId,
            account: ACCOUNT,
            receiver: RECEIVER,
            referral: referralCapability === 'none' ? false : referralValue(),
            allowUnprotectedSlippage: true,
          } as const;
          const request: PrepareSwapRequest =
            mode === 'exact-in'
              ? {
                  ...common,
                  mode,
                  amountIn: amount(route.assetIn),
                  assetOut: route.assetOut,
                }
              : {
                  ...common,
                  mode,
                  assetIn: route.assetIn,
                  amountOut: amount(route.assetOut),
                };

          const result = await prepare(client, request);

          expect(result.isOk()).toBe(true);
          if (result.isOk()) {
            expect(result.value.mode).toBe(mode);
            expect(result.value.route).toMatchObject({
              chainId,
              assetIn: route.assetIn,
              assetOut: route.assetOut,
              mode,
            });
            expect(result.value.quotedAt.blockNumber).toBe(BLOCK);
            expect(result.value.plan.steps.length).toBeGreaterThan(0);
            expect(new Set(result.value.plan.steps.map((step) => step.id)).size).toBe(
              result.value.plan.steps.length,
            );
          }
        });
      }
    }
  }
});

describe('PSM3 quote integrity', () => {
  it('encodes fractional slippage exactly into exact-input minimum output', async () => {
    const { client, publicClient } = setup(8453);
    const tolerance = slippage('7.125');
    const input = amount('USDC', 1_000_000n);

    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: input,
      assetOut: 'USDS',
      slippage: tolerance,
      referral: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.minimumAmountOut.raw).toBe(applySlippageDown(input.raw, tolerance));
      const decoded = decodeFunctionData({
        abi: psm3Abi,
        data: result.value.plan.steps.at(-1)!.data,
      });
      expect(decoded.functionName).toBe('swapExactIn');
      expect(decoded.args[3]).toBe(result.value.minimumAmountOut.raw);
      expect(result.value.slippageProtection).toEqual({
        bound: 'minimum-output',
        enforcedBy: 'calldata',
      });
    }
    expect(
      publicClient.readContract.mock.calls.filter(
        ([args]) => (args as ReadArgs).functionName === 'previewSwapExactIn',
      ),
    ).toHaveLength(1);
  });

  it('rounds exact-output maximum input up and encodes the same value', async () => {
    const { client } = setup(8453);
    const tolerance = slippage('7.125');
    const output = amount('sUSDS', 1_000_001n);

    const result = await prepareSwap(client, {
      mode: 'exact-out',
      chainId: 8453,
      account: ACCOUNT,
      assetIn: 'USDS',
      amountOut: output,
      slippage: tolerance,
      referral: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.maximumAmountIn.raw).toBe(applySlippageUp(output.raw, tolerance));
      const decoded = decodeFunctionData({
        abi: psm3Abi,
        data: result.value.plan.steps.at(-1)!.data,
      });
      expect(decoded.functionName).toBe('swapExactOut');
      expect(decoded.args[3]).toBe(result.value.maximumAmountIn.raw);
    }
  });

  it('uses explicit referral precedence and supports opt-out', async () => {
    const base = setup(8453);
    const configured = referralValue(3333n);
    const client = OseroClient.create({
      publicClients: {
        8453: base.publicClient as unknown as OseroPublicClient,
      },
      referral: configured,
    });

    const inherited = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
    });
    const optedOut = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      referral: false,
    });

    expect(inherited.isOk()).toBe(true);
    expect(optedOut.isOk()).toBe(true);
    if (inherited.isOk() && optedOut.isOk()) {
      const inheritedCall = decodeFunctionData({
        abi: psm3Abi,
        data: inherited.value.plan.steps.at(-1)!.data,
      });
      const optedOutCall = decodeFunctionData({
        abi: psm3Abi,
        data: optedOut.value.plan.steps.at(-1)!.data,
      });
      expect(inheritedCall.args[5]).toBe(3333n);
      expect(optedOutCall.args[5]).toBe(0n);
    }
  });
});

describe('approval policy', () => {
  it('adds an exact approval only when allowance is insufficient', async () => {
    const insufficient = setup(8453, 999_999n);
    const sufficient = setup(8453, 1_000_000n);
    const request = {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      referral: false,
    } as const;

    const withApproval = await prepareSwap(insufficient.client, request);
    const withoutApproval = await prepareSwap(sufficient.client, request);

    expect(withApproval.isOk()).toBe(true);
    expect(withoutApproval.isOk()).toBe(true);
    if (withApproval.isOk() && withoutApproval.isOk()) {
      expect(withApproval.value.plan.steps[0]!.authorization?.amount).toBe(1_000_000n);
      expect(withApproval.value.plan.metadata.allowanceSnapshots?.[0]).toMatchObject({
        allowance: 999_999n,
        requiredAmount: 1_000_000n,
        policy: 'exact',
        observedAtBlock: BLOCK,
      });
      expect(withoutApproval.value.plan.steps).toHaveLength(1);
    }
  });

  it('requires explicit max policy and never defaults to unlimited approval', async () => {
    const { client } = setup(8453, 0n);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      approvalPolicy: 'max',
      referral: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.plan.steps[0]!.authorization?.amount).toBe(UINT256_MAX);
    }
  });

  it('returns InsufficientAllowanceError for none policy without adding a transaction', async () => {
    const { client } = setup(8453, 0n);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      approvalPolicy: 'none',
      referral: false,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(InsufficientAllowanceError);
  });

  it('records multiple mainnet intermediate approvals', async () => {
    const { client } = setup(1, 0n);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'sUSDS',
      referral: false,
      allowUnprotectedSlippage: true,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.plan.steps.map((step) => step.operation)).toEqual([
        'APPROVE_ERC20',
        'MINT_USDS',
        'APPROVE_ERC20',
        'DEPOSIT_USDS_FOR_SUSDS',
      ]);
      expect(result.value.plan.requirements.execution).toBe('sequential');
      expect(result.value.plan.metadata.allowanceSnapshots).toHaveLength(2);
    }
  });

  it('builds a 1:1 scaled atomic-batch plan for mainnet USDC to sUSDS', async () => {
    const { client } = setup(1, 0n);
    const input = amount('USDC');
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: input,
      assetOut: 'sUSDS',
      referral: false,
      allowUnprotectedSlippage: true,
      execution: 'atomic-batch',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.plan.requirements.execution).toBe('atomic-batch');
      expect(result.value.plan.steps.map((step) => step.operation)).toEqual([
        'APPROVE_ERC20',
        'MINT_USDS',
        'APPROVE_ERC20',
        'DEPOSIT_USDS_FOR_SUSDS',
      ]);
      const decoded = decodeFunctionData({
        abi: erc4626Abi,
        data: result.value.plan.steps.at(-1)!.data,
      });
      expect(decoded.functionName).toBe('deposit');
      expect(decoded.args[0]).toBe(input.raw * USDC_TO_USDS_SCALE);
    }
  });

  it('rejects atomic-batch USDC to sUSDS when Lite PSM tin is not zero', async () => {
    const { client } = setup(1, 0n, 10n ** 16n);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'sUSDS',
      referral: false,
      allowUnprotectedSlippage: true,
      execution: 'atomic-batch',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
      if (result.error instanceof ValidationError) expect(result.error.field).toBe('execution');
    }
  });

  it('resets an excess allowance to enforce a mainnet exact-output spending cap', async () => {
    const { client } = setup(1, UINT256_MAX);
    const result = await prepareSwap(client, {
      mode: 'exact-out',
      chainId: 1,
      account: ACCOUNT,
      assetIn: 'USDS',
      amountOut: amount('sUSDS'),
      referral: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.plan.steps[0]!.authorization?.amount).toBe(
        result.value.maximumAmountIn.raw,
      );
      expect(result.value.slippageProtection.enforcedBy).toBe('allowance');
    }
  });
});

describe('mainnet direct ERC-4626 routes', () => {
  it.each([
    ['exact-in', 'USDS', 'sUSDS', 'deposit'],
    ['exact-out', 'USDS', 'sUSDS', 'mint'],
    ['exact-in', 'sUSDS', 'USDS', 'redeem'],
    ['exact-out', 'sUSDS', 'USDS', 'withdraw'],
  ] as const)('encodes %s %s -> %s with %s', async (mode, assetIn, assetOut, functionName) => {
    const { client } = setup(1, 0n);
    const common = {
      chainId: 1,
      account: ACCOUNT,
      referral: false,
      allowUnprotectedSlippage: true,
    } as const;
    const request: PrepareSwapRequest =
      mode === 'exact-in'
        ? { ...common, mode, amountIn: amount(assetIn), assetOut }
        : { ...common, mode, assetIn, amountOut: amount(assetOut) };

    const result = await prepare(client, request);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const decoded = decodeFunctionData({
        abi: erc4626Abi,
        data: result.value.plan.steps.at(-1)!.data,
      });
      expect(decoded.functionName).toBe(functionName);
    }
  });
});

describe('deterministic validation', () => {
  it.each([
    ['negative', { bps: '-1' }],
    ['numeric fractional', { bps: 1.5 }],
    ['NaN', { bps: Number.NaN }],
    ['over maximum', { bps: '10000.0001' }],
  ])('rejects malformed %s slippage before RPC', async (_label, malformed) => {
    const { client, publicClient } = setup(8453);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      slippage: malformed as never,
      referral: false,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it.each([
    ['account', '0x1234'],
    ['receiver', '0x1234'],
  ])('rejects invalid %s before RPC', async (field, address) => {
    const { client, publicClient } = setup(8453);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: field === 'account' ? (address as Address) : ACCOUNT,
      receiver: field === 'receiver' ? (address as Address) : RECEIVER,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      referral: false,
    });

    expect(result.isErr()).toBe(true);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it('rejects unknown runtime token symbols and invalid amounts before RPC', async () => {
    const { client, publicClient } = setup(8453);
    const unknown = await prepare(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: { symbol: 'DAI', raw: 1n } as never,
      assetOut: 'USDS',
      referral: false,
    });
    const invalidAmount = await prepare(client, {
      mode: 'exact-in',
      chainId: 8453,
      account: ACCOUNT,
      amountIn: { symbol: 'USDC', raw: -1n },
      assetOut: 'USDS',
      referral: false,
    });

    expect(unknown.isErr()).toBe(true);
    expect(invalidAmount.isErr()).toBe(true);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it('rejects referral on unsupported mainnet routes without RPC', async () => {
    const { client, publicClient } = setup(1);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      referral: referralValue(),
      allowUnprotectedSlippage: true,
    });

    expect(result.isErr()).toBe(true);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it('rejects an invalid execution mode before RPC', async () => {
    const { client, publicClient } = setup(1);
    const result = await prepare(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: amount('USDC'),
      assetOut: 'sUSDS',
      referral: false,
      allowUnprotectedSlippage: true,
      execution: 'parallel' as never,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });

  it('requires explicit acknowledgement for unprotected deployed routes', async () => {
    const { client, publicClient } = setup(1);
    const result = await prepareSwap(client, {
      mode: 'exact-in',
      chainId: 1,
      account: ACCOUNT,
      amountIn: amount('USDS'),
      assetOut: 'sUSDS',
      referral: false,
    });

    expect(result.isErr()).toBe(true);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
  });
});
