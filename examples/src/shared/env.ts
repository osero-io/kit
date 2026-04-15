import type { Hex } from 'viem';

/**
 * Look up an environment variable and fail loudly if it is missing.
 * Used for `PRIVATE_KEY` where a fallback would silently sign the
 * wrong account.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required env var ${name}. Copy examples/.env.example to examples/.env and fill it in.`,
    );
  }
  return value;
}

/**
 * Load the signing key from `PRIVATE_KEY`. Normalises the `0x`
 * prefix so the same value works with both viem's
 * `privateKeyToAccount` and ethers' `Wallet` constructor.
 */
export function loadPrivateKey(): Hex {
  const raw = requireEnv('PRIVATE_KEY').trim();
  const normalised = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (normalised.length !== 66) {
    throw new Error(
      `PRIVATE_KEY should be a 32-byte hex string (with or without 0x prefix). Got ${normalised.length} chars.`,
    );
  }
  return normalised;
}

/**
 * Per-chain RPC URLs keyed by the env var name documented in
 * `.env.example`. Missing entries fall back to the chain default
 * resolved by the caller.
 */
export const RPC_ENV_BY_CHAIN_ID: Record<number, string> = {
  1: 'RPC_URL_MAINNET',
  10: 'RPC_URL_OPTIMISM',
  130: 'RPC_URL_UNICHAIN',
  8453: 'RPC_URL_BASE',
  42161: 'RPC_URL_ARBITRUM',
};

/**
 * Resolve the RPC URL for `chainId`. Returns `undefined` if the user
 * has not set one — callers then fall back to viem's public HTTP
 * default.
 */
export function optionalRpcUrl(chainId: number): string | undefined {
  const envVar = RPC_ENV_BY_CHAIN_ID[chainId];
  if (!envVar) return undefined;
  const value = process.env[envVar];
  return value && value.length > 0 ? value : undefined;
}
