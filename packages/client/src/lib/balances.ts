import type { Address } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { getChain, type OseroChainId } from './chains.js';
import {
  RpcError,
  UnsupportedChainError,
  ValidationError,
  type ConfigurationError,
  type UnexpectedError,
} from './errors.js';
import type { OseroClient, OseroPublicClient } from './OseroClient.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import { getToken, isTokenSymbol, type TokenSymbol } from './tokens.js';
import { validateAddress } from './validation.js';

export type GetTokenBalanceRequest = {
  readonly chainId: number;
  readonly account: Address;
  readonly token: TokenSymbol | Address;
};

export type GetBalancesRequest = {
  readonly chainId: number;
  readonly account: Address;
  readonly multicall?: 'prefer' | 'require' | 'never';
};

export type TokenBalances = {
  readonly USDC: bigint;
  readonly USDS: bigint;
  readonly sUSDS: bigint;
};

export type GetTokenBalanceError =
  | UnsupportedChainError
  | ValidationError
  | ConfigurationError
  | UnexpectedError
  | RpcError;

export function getTokenBalance(
  client: OseroClient,
  request: GetTokenBalanceRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  const chain = getChain(request.chainId);
  if (chain === null) return errAsync(new UnsupportedChainError(request.chainId));
  const account = validateAddress(request.account, 'account');
  if (account.isErr()) return errAsync(account.error);
  const token = resolveTokenAddress(chain.chainId, request.token);
  if (token.isErr()) return errAsync(token.error);
  const publicClient = client.getPublicClient(chain.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);

  return readBalance(publicClient.value, chain.chainId, token.value, account.value);
}

function resolveTokenAddress(
  chainId: OseroChainId,
  token: TokenSymbol | Address,
): Result<Address, ValidationError> {
  if (typeof token !== 'string') {
    return err(
      ValidationError.forField('token', 'token must be a canonical symbol or EVM address'),
    );
  }
  if (token.startsWith('0x')) return validateAddress(token, 'token');
  if (!isTokenSymbol(token)) {
    return err(
      ValidationError.forField(
        'token',
        `unknown token symbol ${token}; use USDC, USDS, sUSDS, or an ERC-20 address`,
      ),
    );
  }
  return ok(getToken(chainId, token).address);
}

function readBalance(
  publicClient: OseroPublicClient,
  chainId: number,
  token: Address,
  account: Address,
): ResultAsync<bigint, RpcError> {
  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    (cause) =>
      RpcError.from({
        cause,
        operation: 'readContract',
        chainId,
        contract: token,
        functionName: 'balanceOf',
      }),
  );
}

export function getTokenBalances(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<TokenBalances, GetTokenBalanceError> {
  const chain = getChain(request.chainId);
  if (chain === null) return errAsync(new UnsupportedChainError(request.chainId));
  const account = validateAddress(request.account, 'account');
  if (account.isErr()) return errAsync(account.error);
  if (
    request.multicall !== undefined &&
    request.multicall !== 'prefer' &&
    request.multicall !== 'require' &&
    request.multicall !== 'never'
  ) {
    return errAsync(
      ValidationError.forField('multicall', 'multicall must be prefer, require, or never'),
    );
  }
  const publicClient = client.getPublicClient(chain.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);
  const tokens = [
    getToken(chain.chainId, 'USDC'),
    getToken(chain.chainId, 'USDS'),
    getToken(chain.chainId, 'sUSDS'),
  ] as const;
  const fallback = (): ResultAsync<TokenBalances, RpcError> =>
    ResultAsync.combine(
      tokens.map((token) =>
        readBalance(publicClient.value, chain.chainId, token.address, account.value),
      ),
    ).map(([USDC, USDS, sUSDS]) => ({ USDC, USDS, sUSDS }));

  if (request.multicall === 'never' || typeof publicClient.value.multicall !== 'function') {
    if (request.multicall === 'require') {
      return errAsync(
        RpcError.from({
          cause: new Error('Public client does not support multicall'),
          operation: 'multicall',
          chainId: chain.chainId,
        }),
      );
    }
    return fallback();
  }

  const aggregate = async (): Promise<Result<TokenBalances, RpcError>> => {
    const results = await ResultAsync.fromPromise(
      publicClient.value.multicall({
        allowFailure: true,
        contracts: tokens.map((token) => ({
          address: token.address,
          abi: erc20Abi,
          functionName: 'balanceOf' as const,
          args: [account.value] as const,
        })),
      }),
      (cause) => RpcError.from({ cause, operation: 'multicall', chainId: chain.chainId }),
    );
    if (results.isErr()) {
      if (request.multicall === 'require') return err(results.error);
      return fallback();
    }
    const values: bigint[] = [];
    for (const [index, result] of results.value.entries()) {
      if (result.status === 'failure') {
        const token = tokens[index]!;
        return err(
          RpcError.from({
            cause: result.error,
            operation: 'multicall',
            chainId: chain.chainId,
            contract: token.address,
            functionName: 'balanceOf',
          }),
        );
      }
      values.push(result.result);
    }
    if (values.length !== 3) {
      return err(
        RpcError.from({
          cause: new Error(`multicall returned ${values.length} balance results`),
          operation: 'multicall',
          chainId: chain.chainId,
        }),
      );
    }
    return ok({ USDC: values[0]!, USDS: values[1]!, sUSDS: values[2]! });
  };
  return new ResultAsync(aggregate());
}

export function getUsdcBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'USDC' });
}

export function getUsdsBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'USDS' });
}

export function getSUsdsBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'sUSDS' });
}
