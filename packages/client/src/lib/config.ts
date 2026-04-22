import type { Transport } from 'viem';

import type { OseroChainId } from './chains.js';
import { DEFAULT_REFERRAL_CODE } from './referrals.js';

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

  /**
   * Default referral code attached to every action unless the request
   * overrides it. Forwarded to PSM3 `Swap` events on L2s and to the
   * sUSDS `deposit` referral overload on mainnet.
   *
   * - Omit to use the SDK's built-in default ({@link DEFAULT_REFERRAL_CODE} = 3000n).
   * - Set to a bigint to use your own code across every call.
   * - Set to `undefined` to opt out at the client level: requests that
   *   do not specify their own `referralCode` will carry no referral.
   *
   * Per-request `referralCode` always wins; pass `undefined` there to
   * opt out for a single call.
   */
  readonly defaultReferralCode?: bigint;
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
  readonly defaultReferralCode: bigint | undefined;
};

/**
 * @internal
 */
export function resolveConfig(config: ClientConfig): ResolvedClientConfig {
  const defaultReferralCode =
    'defaultReferralCode' in config ? config.defaultReferralCode : DEFAULT_REFERRAL_CODE;

  return {
    transports: config.transports ?? {},
    defaultSlippageBps: config.defaultSlippageBps ?? 5,
    confirmations: config.confirmations ?? 1,
    defaultReferralCode,
  };
}
