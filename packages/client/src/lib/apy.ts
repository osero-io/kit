import type { Address } from 'viem';

import { ssrAbi } from './abis/ssr.js';
import { getChain, type OseroChainId } from './chains.js';
import { UnexpectedError, UnsupportedChainError } from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { errAsync, ResultAsync } from './result.js';

/**
 * RAY — the 1e27 fixed-point scale Sky uses for the per-second savings
 * rate. `ssr / RAY` is the (approximate) `1 + r_per_sec` factor.
 */
export const RAY = 1_000_000_000_000_000_000_000_000_000n;

/**
 * Seconds in a 365-day year, matching the convention Sky and Spark use
 * when quoting sUSDS APY.
 */
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Per-chain source for the savings rate read.
 *
 * On Ethereum mainnet sUSDS exposes `ssr()` directly, so we read it
 * straight off the vault. On every L2 the canonical rate lives in
 * Spark's `SSRAuthOracle` — the same oracle PSM3 reads to price
 * sUSDS — and is exposed via `getSSR()`.
 *
 * @internal
 */
type SsrSource = {
  readonly address: Address;
  readonly functionName: 'ssr' | 'getSSR';
};

const SSR_SOURCES: { readonly [K in OseroChainId]: SsrSource } = {
  1: {
    address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
    functionName: 'ssr',
  },
  10: {
    address: '0x6E53585449142A5E6D5fC918AE6BEa341dC81C68',
    functionName: 'getSSR',
  },
  130: {
    address: '0x1566BFA55D95686a823751298533D42651183988',
    functionName: 'getSSR',
  },
  8453: {
    address: '0x65d946e533748A998B1f0E430803e39A6388f7a1',
    functionName: 'getSSR',
  },
  42161: {
    address: '0xEE2816c1E1eed14d444552654Ed3027abC033A36',
    functionName: 'getSSR',
  },
};

export type GetSsrRequest = {
  readonly chainId: number;
};

export type GetSsrError = UnsupportedChainError | UnexpectedError;

/**
 * Convert a RAY-scaled per-second savings rate into an annualised
 * percentage yield.
 *
 * `ssr / 1e27` is the per-second growth factor (`1 + r_per_sec`), so
 * the APY is `(1 + r_per_sec) ^ secondsPerYear - 1`. The result is a
 * decimal fraction — multiply by 100 to display as a percentage.
 *
 * Note: this goes through `Number`, which loses precision past ~16
 * significant digits. That is fine for displaying APY but not for
 * on-chain math — keep the raw `bigint` if you need exact compounding.
 */
export function ssrToApy(ssr: bigint): number {
  return (Number(ssr) / 1e27) ** SECONDS_PER_YEAR - 1;
}

/**
 * Read the current per-second sUSDS savings rate (RAY-scaled). On
 * mainnet this calls `ssr()` on the sUSDS vault; on L2s it calls
 * `getSSR()` on Spark's `SSRAuthOracle`.
 */
export function getSsr(
  client: OseroClient,
  request: GetSsrRequest,
): ResultAsync<bigint, GetSsrError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }

  const source = SSR_SOURCES[chain.chainId];
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: source.address,
      abi: ssrAbi,
      functionName: source.functionName,
    }),
    (err) => UnexpectedError.from(err),
  );
}

/**
 * Read the current sUSDS APY as a decimal fraction (e.g. `0.045` for
 * 4.5%). Combines {@link getSsr} and {@link ssrToApy}.
 */
export function getSUsdsApy(
  client: OseroClient,
  request: GetSsrRequest,
): ResultAsync<number, GetSsrError> {
  return getSsr(client, request).map(ssrToApy);
}
