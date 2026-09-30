import {
  CHAIN_CAPABILITIES,
  type OseroChainId,
  type Token,
  type TokenSymbol,
} from './capabilities.js';

export { type Token, type TokenSymbol } from './capabilities.js';

export const TOKEN_SYMBOLS = ['USDC', 'USDS', 'sUSDS'] as const satisfies readonly TokenSymbol[];

export function isTokenSymbol(value: string): value is TokenSymbol {
  return (TOKEN_SYMBOLS as readonly string[]).includes(value);
}

export function getToken(chainId: OseroChainId, symbol: TokenSymbol): Token {
  return CHAIN_CAPABILITIES[chainId].tokens[symbol];
}

export function listTokens(chainId: OseroChainId): readonly Token[] {
  const tokens = CHAIN_CAPABILITIES[chainId].tokens;
  return [tokens.USDC, tokens.USDS, tokens.sUSDS];
}
