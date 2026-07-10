import { isAddress, type Address } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { getChain, type OseroChainId } from './chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import { getToken, type TokenSymbol } from './tokens.js';

export type GetTokenBalanceRequest = {
  readonly chainId: number;
  readonly account: Address;
  /**
   * A canonical Osero token symbol, or the address of any ERC-20 contract
   * on the requested chain. Symbols resolve through the local token
   * registry; addresses are queried as-is.
   */
  readonly token: TokenSymbol | Address;
};

export type GetBalancesRequest = {
  readonly chainId: number;
  readonly account: Address;
};

export type TokenBalances = {
  readonly USDC: bigint;
  readonly USDS: bigint;
  readonly sUSDS: bigint;
};

export type GetTokenBalanceError = UnsupportedChainError | ValidationError | UnexpectedError;

/**
 * Read a wallet's balance for a canonical Osero token, or any ERC-20 by
 * address, on a supported chain.
 */
export function getTokenBalance(
  client: OseroClient,
  request: GetTokenBalanceRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }

  const address = resolveTokenAddress(chain.chainId, request.token);
  if (address.isErr()) {
    return errAsync(address.error);
  }
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: address.value,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [request.account],
    }),
    (cause) => UnexpectedError.from(cause),
  );
}

/**
 * Anything 0x-prefixed is treated as an address (and must be a valid one —
 * lowercase or correct EIP-55 checksum); everything else resolves through
 * the canonical token registry. A 0x-prefixed typo never falls through to
 * a registry lookup.
 */
function resolveTokenAddress(
  chainId: OseroChainId,
  token: TokenSymbol | Address,
): Result<Address, ValidationError> {
  if (token.startsWith('0x')) {
    if (!isAddress(token)) {
      return err(
        ValidationError.forField(
          'token',
          'token must be a canonical token symbol or a valid EVM address',
        ),
      );
    }
    return ok(token);
  }
  return ok(getToken(chainId, token as TokenSymbol).address);
}

/**
 * Read USDC, USDS, and sUSDS balances together for a wallet.
 */
export function getTokenBalances(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<TokenBalances, GetTokenBalanceError> {
  return ResultAsync.combine([
    getTokenBalance(client, { ...request, token: 'USDC' }),
    getTokenBalance(client, { ...request, token: 'USDS' }),
    getTokenBalance(client, { ...request, token: 'sUSDS' }),
  ]).map(([USDC, USDS, sUSDS]) => ({ USDC, USDS, sUSDS }));
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
