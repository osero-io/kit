import { ssrAbi } from './abis/ssr.js';
import { CHAIN_CAPABILITIES } from './capabilities.js';
import { getChain } from './chains.js';
import {
  RpcError,
  UnsupportedChainError,
  ValidationError,
  type ConfigurationError,
  type UnexpectedError,
} from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';

export const RAY = 1_000_000_000_000_000_000_000_000_000n;
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export type GetSsrRequest = {
  readonly chainId: number;
};

export type GetSsrError = UnsupportedChainError | ConfigurationError | UnexpectedError | RpcError;

export function ssrToApy(ssr: bigint): Result<number, ValidationError> {
  if (typeof ssr !== 'bigint') {
    return err(ValidationError.forField('ssr', 'ssr must be a RAY-scaled bigint'));
  }
  if (ssr < RAY) {
    return err(ValidationError.forField('ssr', 'ssr must be greater than or equal to RAY'));
  }
  if (ssr === RAY) return ok(0);

  const perSecondRate = Number(ssr - RAY) / 1e27;
  if (!Number.isFinite(perSecondRate)) {
    return err(ValidationError.forField('ssr', 'ssr is too large to represent safely'));
  }
  const annualExponent = SECONDS_PER_YEAR * Math.log1p(perSecondRate);
  if (!Number.isFinite(annualExponent) || annualExponent > Math.log(Number.MAX_VALUE)) {
    return err(ValidationError.forField('ssr', 'ssr produces an APY outside the number range'));
  }
  return ok(Math.expm1(annualExponent));
}

export function getSsr(
  client: OseroClient,
  request: GetSsrRequest,
): ResultAsync<bigint, GetSsrError> {
  const chain = getChain(request.chainId);
  if (chain === null) return errAsync(new UnsupportedChainError(request.chainId));
  const publicClient = client.getPublicClient(chain.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);
  const source = CHAIN_CAPABILITIES[chain.chainId].ssr;

  return ResultAsync.fromPromise(
    publicClient.value.readContract({
      address: source.address,
      abi: ssrAbi,
      functionName: source.functionName,
    }),
    (cause) =>
      RpcError.from({
        cause,
        operation: 'readContract',
        chainId: chain.chainId,
        contract: source.address,
        functionName: source.functionName,
      }),
  );
}

export function getSUsdsApy(
  client: OseroClient,
  request: GetSsrRequest,
): ResultAsync<number, GetSsrError | ValidationError> {
  return getSsr(client, request).andThen(ssrToApy);
}
