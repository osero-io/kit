import type { Transport } from 'viem';

import type { OseroChainId } from './chains.js';

/**
 * Configuration options accepted by {@link OseroClient.create}.
 *
 * All fields are optional — an unconfigured client will fall back to
 * viem's built-in public HTTP transports and sensible defaults. You
 * should override `transports` for production usage because the
 * built-in public RPCs are rate-limited and unreliable.
 */
export type ClientConfig = {
  /**
   * Custom viem `Transport`s keyed by chain ID. Any chain without an
   * entry here falls back to viem's default public HTTP transport for
   * that chain.
   *
   * ```ts
   * import { http } from 'viem';
   *
   * const client = OseroClient.create({
   *   transports: {
   *     1:     http('https://eth.llamarpc.com'),
   *     8453:  http('https://mainnet.base.org'),
   *     42161: http('https://arb1.arbitrum.io/rpc'),
   *   },
   * });
   * ```
   */
  readonly transports?: Partial<Record<OseroChainId, Transport>>;

  /**
   * Default slippage tolerance, in basis points, applied by actions
   * that don't receive an explicit `slippageBps` in their request.
   *
   * @defaultValue 5 (= 0.05%)
   */
  readonly defaultSlippageBps?: number;

  /**
   * Number of block confirmations the SDK's viem/ethers adapters wait
   * for after broadcasting a transaction before treating it as final.
   *
   * @defaultValue 1
   */
  readonly confirmations?: number;
};

/**
 * The fully-resolved shape of {@link ClientConfig}. Every optional
 * field has been filled in with its default.
 *
 * @internal
 */
export type ResolvedClientConfig = {
  readonly transports: Partial<Record<OseroChainId, Transport>>;
  readonly defaultSlippageBps: number;
  readonly confirmations: number;
};

/**
 * @internal
 */
export function resolveConfig(config: ClientConfig): ResolvedClientConfig {
  return {
    transports: config.transports ?? {},
    defaultSlippageBps: config.defaultSlippageBps ?? 5,
    confirmations: config.confirmations ?? 1,
  };
}
