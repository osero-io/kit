import {
  CHAIN_CAPABILITIES,
  slippageEnforcementFor,
  type OseroChainId,
  type ProtocolKind,
  type ReferralCapability,
  type SwapMode,
  type TokenSymbol,
} from './capabilities.js';
import { isSupportedChainId } from './chains.js';
import type { SwapSlippageProtection } from './types.js';

/** One mode a local swap route supports, with the guarantees that mode carries. */
export type SupportedSwapRouteMode = {
  readonly mode: SwapMode;
  /**
   * The bound a quote for this mode carries and how the deployed contracts
   * enforce it. `enforcedBy: 'none'` means the route cannot enforce its quoted
   * bound, and `prepareSwap` requires `allowUnprotectedSlippage: true`.
   * `enforcedBy: 'allowance'` means the spend is capped by an allowance of
   * exactly the maximum input: `prepareSwap` sets the allowance to that amount
   * under `approvalPolicy: 'exact'`, fails under `'none'` unless it already
   * equals it, and rejects `'max'`.
   */
  readonly slippageProtection: SwapSlippageProtection;
  /**
   * Referral attribution for this mode: `'none'` when the route cannot carry a
   * referral code, otherwise the widest code it accepts.
   */
  readonly referral: ReferralCapability;
};

/** A local swap pair `quoteSwap` and `prepareSwap` support on one chain. */
export type SupportedSwapRoute = {
  readonly chainId: OseroChainId;
  readonly protocol: ProtocolKind;
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  /** Never empty: a pair with no supported mode is not listed. */
  readonly modes: readonly SupportedSwapRouteMode[];
};

const routesByChain = new Map<OseroChainId, readonly SupportedSwapRoute[]>();

function describeRoutes(chainId: OseroChainId): readonly SupportedSwapRoute[] {
  const capability = CHAIN_CAPABILITIES[chainId];
  const routes: SupportedSwapRoute[] = [];
  for (const route of capability.routes) {
    const modes: SupportedSwapRouteMode[] = [];
    for (const mode of ['exact-in', 'exact-out'] as const) {
      if (mode === 'exact-in' ? !route.exactIn : !route.exactOut) continue;
      modes.push(
        Object.freeze({
          mode,
          slippageProtection: Object.freeze({
            bound: mode === 'exact-in' ? 'minimum-output' : 'maximum-input',
            enforcedBy: slippageEnforcementFor(
              capability.protocol,
              route.assetIn,
              route.assetOut,
              mode,
            ),
          }),
          referral: mode === 'exact-in' ? route.exactInReferral : route.exactOutReferral,
        }),
      );
    }
    if (modes.length === 0) continue;
    routes.push(
      Object.freeze({
        chainId,
        protocol: capability.protocol,
        assetIn: route.assetIn,
        assetOut: route.assetOut,
        modes: Object.freeze(modes),
      }),
    );
  }
  return Object.freeze(routes);
}

/**
 * Lists the local swap routes available on a chain: each supported asset pair
 * with its modes, slippage enforcement, and referral capability. The result is
 * derived from the same capability matrix `quoteSwap` and `prepareSwap` use, so
 * a listed route and mode is one they accept.
 *
 * This is a synchronous, read-only lookup. It makes no network call and says
 * nothing about current liquidity. A chain without local routes returns an
 * empty list. Hosted API pairs are not listed here; ask the API with
 * `OseroApiClient.getSupportedAssets()`.
 */
export function listSwapRoutes(chainId: number): readonly SupportedSwapRoute[] {
  if (!isSupportedChainId(chainId)) return [];
  let routes = routesByChain.get(chainId);
  if (routes === undefined) {
    routes = describeRoutes(chainId);
    routesByChain.set(chainId, routes);
  }
  return routes;
}
