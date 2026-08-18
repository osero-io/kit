import { createMockClient, mockFn, type MockPublicClient } from '../_testing.js';
import { CHAIN_CAPABILITIES, type OseroChainId, type TokenSymbol } from '../capabilities.js';
import { parseSlippage, tokenAmount, type TokenAmount } from '../domain.js';
import { RpcError, ValidationError } from '../errors.js';
import { applySlippageDown } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import type { Result } from '../result.js';
import type { SwapQuote } from '../types.js';
import { quoteSwap, type SwapQuoteRequest } from './quoteSwap.js';

const BLOCK = 12_345n;

type ReadArgs = {
  readonly functionName: string;
  readonly args?: readonly unknown[];
};

type Setup = {
  readonly client: OseroClient;
  readonly publicClient: MockPublicClient;
};

function setup(chainId: OseroChainId): Setup {
  const readContract = mockFn(async (args: ReadArgs): Promise<bigint> => {
    switch (args.functionName) {
      case 'tin':
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
        throw new Error(`Unexpected quote read ${args.functionName}`);
    }
  });
  return createMockClient(chainId, {
    getBlockNumber: mockFn(async () => BLOCK),
    readContract,
  });
}

function amount<Symbol extends TokenSymbol>(symbol: Symbol, raw = 1_000_000n): TokenAmount<Symbol> {
  const result = tokenAmount(symbol, raw);
  if (result.isErr()) throw result.error;
  return result.value;
}

async function quote(
  client: OseroClient,
  request: SwapQuoteRequest,
): Promise<Result<SwapQuote, unknown>> {
  return quoteSwap(client, request);
}

describe('quoteSwap route matrix', () => {
  for (const chainId of [1, 10, 130, 8453, 42161] as const) {
    for (const route of CHAIN_CAPABILITIES[chainId].routes) {
      for (const mode of ['exact-in', 'exact-out'] as const) {
        if (mode === 'exact-in' && !route.exactIn) continue;
        if (mode === 'exact-out' && !route.exactOut) continue;

        it(`quotes ${mode} ${route.assetIn} -> ${route.assetOut} on ${chainId} without an account`, async () => {
          const { client, publicClient } = setup(chainId);
          const request: SwapQuoteRequest =
            mode === 'exact-in'
              ? {
                  chainId,
                  mode,
                  amountIn: amount(route.assetIn),
                  assetOut: route.assetOut,
                }
              : {
                  chainId,
                  mode,
                  assetIn: route.assetIn,
                  amountOut: amount(route.assetOut),
                };

          const result = await quote(client, request);

          expect(result.isOk()).toBe(true);
          if (result.isOk()) {
            expect(result.value.mode).toBe(mode);
            expect(result.value.route).toEqual({
              chainId,
              protocol: CHAIN_CAPABILITIES[chainId].protocol,
              assetIn: route.assetIn,
              assetOut: route.assetOut,
              mode,
            });
            expect(result.value.quotedAt.blockNumber).toBe(BLOCK);
            expect(result.value).not.toHaveProperty('plan');
            expect(result.value.route).not.toHaveProperty('steps');
          }
          expect(
            publicClient.readContract.mock.calls.map(([args]) => args.functionName),
          ).not.toContain('allowance');
        });
      }
    }
  }
});

describe('quoteSwap economics', () => {
  it('applies explicitly-unitized fractional bps without preparing execution', async () => {
    const { client } = setup(8453);
    const slippage = parseSlippage({ bps: '7.125' });
    if (slippage.isErr()) throw slippage.error;

    const result = await quoteSwap(client, {
      chainId: 8453,
      mode: 'exact-in',
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      slippage: slippage.value,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.expectedAmountOut.raw).toBe(1_000_000n);
      expect(result.value.minimumAmountOut.raw).toBe(applySlippageDown(1_000_000n, slippage.value));
      expect(result.value.slippage.bps).toBe('7.125');
    }
  });

  it('returns unprotected-route economics without requiring execution consent', async () => {
    const { client } = setup(1);

    const result = await quoteSwap(client, {
      chainId: 1,
      mode: 'exact-in',
      amountIn: amount('USDS'),
      assetOut: 'sUSDS',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.slippageProtection).toEqual({
        bound: 'minimum-output',
        enforcedBy: 'none',
      });
    }
  });

  it('rejects malformed slippage before reading a block', async () => {
    const { client, publicClient } = setup(8453);

    const result = await quoteSwap(client, {
      chainId: 8453,
      mode: 'exact-in',
      amountIn: amount('USDC'),
      assetOut: 'USDS',
      slippage: { bps: '1e2' } as never,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it('returns RPC failures with operation and contract context', async () => {
    const psm = CHAIN_CAPABILITIES[8453].contracts.psm;
    const { client } = createMockClient(8453, {
      getBlockNumber: mockFn(async () => BLOCK),
      readContract: mockFn(async () => {
        throw new Error('rpc timeout');
      }),
    });

    const result = await quoteSwap(client, {
      chainId: 8453,
      mode: 'exact-in',
      amountIn: amount('USDC'),
      assetOut: 'USDS',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(RpcError);
      if (result.error instanceof RpcError) {
        expect(result.error.operation).toBe('readContract');
        expect(result.error.contract).toBe(psm);
        expect(result.error.functionName).toBe('previewSwapExactIn');
      }
    }
  });
});
