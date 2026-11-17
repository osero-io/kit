import { createMockClient, mockFn } from './_testing.js';
import { prepareSwap, type PrepareSwapRequest } from './actions/prepareSwap.js';
import { quoteSwap, type SwapQuoteRequest } from './actions/quoteSwap.js';
import { CHAIN_CAPABILITIES, SUPPORTED_CHAIN_IDS, type OseroChainId } from './capabilities.js';
import { referral, tokenAmount } from './domain.js';
import type { Result } from './result.js';
import { listSwapRoutes, type SupportedSwapRouteMode } from './routes.js';
import { TOKEN_SYMBOLS, type TokenSymbol } from './tokens.js';
import type { PreparedSwapQuote, SwapQuote } from './types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const MODES = ['exact-in', 'exact-out'] as const;

function client(chainId: OseroChainId) {
  const readContract = mockFn(
    async (args: { functionName: string; args?: readonly unknown[] }): Promise<bigint> => {
      switch (args.functionName) {
        case 'allowance':
        case 'tin':
        case 'tout':
          return 0n;
        case 'previewSwapExactIn':
        case 'previewSwapExactOut':
          return args.args?.[2] as bigint;
        default:
          return args.args?.[0] as bigint;
      }
    },
  );
  return createMockClient(chainId, { getBlockNumber: mockFn(async () => 1n), readContract });
}

function quoteRequest(
  chainId: OseroChainId,
  assetIn: TokenSymbol,
  assetOut: TokenSymbol,
  mode: (typeof MODES)[number],
): SwapQuoteRequest {
  const amount = tokenAmount(mode === 'exact-in' ? assetIn : assetOut, 1_000_000n);
  if (amount.isErr()) throw amount.error;
  return (
    mode === 'exact-in'
      ? { chainId, mode, amountIn: amount.value, assetOut }
      : { chainId, mode, amountOut: amount.value, assetIn }
  ) as SwapQuoteRequest;
}

const quote = quoteSwap as unknown as (
  valueClient: ReturnType<typeof client>['client'],
  request: SwapQuoteRequest,
) => PromiseLike<Result<SwapQuote, { readonly code: string; readonly field?: string }>>;
const prepare = prepareSwap as unknown as (
  valueClient: ReturnType<typeof client>['client'],
  request: PrepareSwapRequest,
) => PromiseLike<Result<PreparedSwapQuote, { readonly code: string; readonly field?: string }>>;

describe('listSwapRoutes', () => {
  it('lists six pairs per PSM3 chain with both modes enforced in calldata', () => {
    for (const chainId of [10, 130, 8453, 42161] as const) {
      const routes = listSwapRoutes(chainId);

      expect(routes).toHaveLength(6);
      for (const route of routes) {
        expect(route.chainId).toBe(chainId);
        expect(route.protocol).toBe('psm3');
        expect(route.modes).toEqual([
          {
            mode: 'exact-in',
            slippageProtection: { bound: 'minimum-output', enforcedBy: 'calldata' },
            referral: 'uint256',
          },
          {
            mode: 'exact-out',
            slippageProtection: { bound: 'maximum-input', enforcedBy: 'calldata' },
            referral: 'uint256',
          },
        ]);
      }
    }
  });

  it('describes the mainnet routes with their per-mode guarantees', () => {
    const summary = listSwapRoutes(1).map((route) => ({
      pair: `${route.assetIn}->${route.assetOut}`,
      modes: route.modes.map(
        (mode) => `${mode.mode}:${mode.slippageProtection.enforcedBy}:${mode.referral}`,
      ),
    }));

    expect(summary).toEqual([
      { pair: 'USDC->USDS', modes: ['exact-in:none:none'] },
      { pair: 'USDC->sUSDS', modes: ['exact-in:none:uint16'] },
      { pair: 'USDS->USDC', modes: ['exact-out:allowance:none'] },
      { pair: 'USDS->sUSDS', modes: ['exact-in:none:uint16', 'exact-out:allowance:none'] },
      { pair: 'sUSDS->USDC', modes: ['exact-in:calldata:none'] },
      { pair: 'sUSDS->USDS', modes: ['exact-in:none:none', 'exact-out:none:none'] },
    ]);
  });

  it('exposes a narrow shape without addresses or internal capability data', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const route of listSwapRoutes(chainId)) {
        expect(Object.keys(route).toSorted()).toEqual([
          'assetIn',
          'assetOut',
          'chainId',
          'modes',
          'protocol',
        ]);
        for (const mode of route.modes) {
          expect(Object.keys(mode).toSorted()).toEqual(['mode', 'referral', 'slippageProtection']);
        }
        expect(JSON.stringify(route)).not.toMatch(/0x[0-9a-fA-F]{40}/);
      }
    }
  });

  it('returns an empty list for a chain without local routes and never throws', () => {
    for (const chainId of [56, 0, -1, 1.5, Number.NaN, '1' as never, undefined as never]) {
      expect(listSwapRoutes(chainId)).toEqual([]);
    }
  });

  it('returns read-only data that a caller cannot use to change SDK behaviour', () => {
    const routes = listSwapRoutes(8453);

    expect(listSwapRoutes(8453)).toBe(routes);
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes[0])).toBe(true);
    expect(Object.isFrozen(routes[0]?.modes)).toBe(true);
    expect(Object.isFrozen(routes[0]?.modes[0])).toBe(true);
    expect(Object.isFrozen(routes[0]?.modes[0]?.slippageProtection)).toBe(true);
    expect(() => (routes as unknown[]).push({})).toThrow(TypeError);
    // The internal matrix is a different object graph.
    expect(routes).not.toBe(CHAIN_CAPABILITIES[8453].routes);
  });

  describe.each(SUPPORTED_CHAIN_IDS)(
    'agreement with quoteSwap and prepareSwap on chain %d',
    (chainId) => {
      const listed = new Map<string, SupportedSwapRouteMode>(
        listSwapRoutes(chainId).flatMap((route) =>
          route.modes.map(
            (mode) => [`${route.assetIn}:${route.assetOut}:${mode.mode}`, mode] as const,
          ),
        ),
      );

      for (const assetIn of TOKEN_SYMBOLS) {
        for (const assetOut of TOKEN_SYMBOLS) {
          if (assetIn === assetOut) continue;
          for (const mode of MODES) {
            const key = `${assetIn}:${assetOut}:${mode}`;
            const entry = listed.get(key);

            it(`${entry === undefined ? 'omits' : 'lists'} ${mode} ${assetIn} -> ${assetOut} exactly as the actions treat it`, async () => {
              const { client: valueClient } = client(chainId);
              const request = quoteRequest(chainId, assetIn, assetOut, mode);

              const quoted = await quote(valueClient, request);

              if (entry === undefined) {
                expect(quoted.isErr()).toBe(true);
                if (quoted.isErr()) {
                  expect(quoted.error.code).toBe('VALIDATION_ERROR');
                  expect(quoted.error.field).toBe('route');
                }
                return;
              }
              expect(quoted.isOk()).toBe(true);
              if (quoted.isOk()) {
                expect(quoted.value.slippageProtection).toEqual(entry.slippageProtection);
              }

              // A route that cannot enforce its bound needs the explicit opt-in.
              const unprotected = entry.slippageProtection.enforcedBy === 'none';
              const base = { ...request, account: ACCOUNT, referral: false } as PrepareSwapRequest;
              const withoutOptIn = await prepare(valueClient, base);
              expect(withoutOptIn.isOk()).toBe(!unprotected);
              if (withoutOptIn.isErr())
                expect(withoutOptIn.error.field).toBe('allowUnprotectedSlippage');

              // A referral is accepted exactly when the listing says the mode carries one.
              const code = referral(3000n);
              if (code.isErr()) throw code.error;
              const withReferral = await prepare(valueClient, {
                ...base,
                referral: code.value,
                allowUnprotectedSlippage: true,
              } as PrepareSwapRequest);
              expect(withReferral.isOk()).toBe(entry.referral !== 'none');
              if (withReferral.isErr()) expect(withReferral.error.field).toBe('referral');
            });
          }
        }
      }
    },
  );
});
