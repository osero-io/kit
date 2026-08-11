import { getAddress, type Address, type Transport } from 'viem';

import type { PsmAddressOverrides } from './addresses.js';
import type { OseroChainId } from './chains.js';
import { DEFAULT_REFERRAL_CODE } from './referrals.js';
import type { TokenAddressOverrides, TokenSymbol } from './tokens.js';

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
   * Optional PSM contract address overrides keyed by chain ID. Use this
   * when a chain migrates to a new PSM deployment before the SDK's
   * built-in address table has been updated.
   *
   * Omitted fields fall back to the SDK defaults, so callers can
   * override only the address that changed. Addresses are validated
   * and checksummed when the client is created.
   */
  readonly addressOverrides?: PsmAddressOverrides;

  /**
   * Optional USDC / USDS / sUSDS address overrides keyed by chain ID.
   * This is an escape hatch for contract migrations before the SDK's
   * built-in token registry has been updated.
   *
   * Omitted symbols fall back to the SDK defaults. Addresses are
   * validated and checksummed when the client is created.
   */
  readonly tokenOverrides?: TokenAddressOverrides;

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
 * The resolved shape of {@link ClientConfig}. Values returned by
 * {@link resolveConfig} include normalized override maps; those maps
 * stay optional in the exported type so adding them does not break
 * callers that type their own resolved config objects.
 *
 * @internal
 */
export type ResolvedClientConfig = {
  readonly transports: Partial<Record<OseroChainId, Transport>>;
  readonly addressOverrides?: PsmAddressOverrides;
  readonly tokenOverrides?: TokenAddressOverrides;
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
    addressOverrides: normalizePsmAddressOverrides(config.addressOverrides),
    tokenOverrides: normalizeTokenAddressOverrides(config.tokenOverrides),
    defaultSlippageBps: config.defaultSlippageBps ?? 5,
    confirmations: config.confirmations ?? 1,
    defaultReferralCode,
  };
}

function normalizeAddress(address: Address): Address {
  return getAddress(address) as Address;
}

function normalizePsmAddressOverrides(
  overrides: PsmAddressOverrides | undefined,
): PsmAddressOverrides {
  const resolved: Partial<Record<OseroChainId, NonNullable<PsmAddressOverrides[OseroChainId]>>> =
    {};

  for (const [rawChainId, chainOverrides] of Object.entries(overrides ?? {})) {
    const chainId = Number(rawChainId) as OseroChainId;
    const normalized: { psm?: Address; litePsm?: Address } = {};

    if (chainOverrides.psm !== undefined) {
      normalized.psm = normalizeAddress(chainOverrides.psm);
    }
    if (chainOverrides.litePsm !== undefined) {
      normalized.litePsm = normalizeAddress(chainOverrides.litePsm);
    }

    resolved[chainId] = normalized;
  }

  return resolved;
}

const TOKEN_SYMBOLS = ['USDC', 'USDS', 'sUSDS'] as const satisfies readonly TokenSymbol[];

function normalizeTokenAddressOverrides(
  overrides: TokenAddressOverrides | undefined,
): TokenAddressOverrides {
  const resolved: Partial<Record<OseroChainId, NonNullable<TokenAddressOverrides[OseroChainId]>>> =
    {};

  for (const [rawChainId, chainOverrides] of Object.entries(overrides ?? {})) {
    const chainId = Number(rawChainId) as OseroChainId;
    const normalized: NonNullable<TokenAddressOverrides[OseroChainId]> = {};

    for (const symbol of TOKEN_SYMBOLS) {
      const address = chainOverrides[symbol];
      if (address !== undefined) {
        normalized[symbol] = normalizeAddress(address);
      }
    }

    resolved[chainId] = normalized;
  }

  return resolved;
}
