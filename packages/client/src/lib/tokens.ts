import type { Address } from 'viem';

import type { OseroChainId } from './chains.js';

/**
 * The three tokens that matter to Osero actions:
 *
 * - `USDC`  — Circle USDC. Native (not bridged USDC.e) on every L2.
 * - `USDS`  — Sky stablecoin (1:1 with USD, 18 decimals).
 * - `sUSDS` — ERC-4626 vault on top of USDS, accrues the SSR.
 */
export type TokenSymbol = 'USDC' | 'USDS' | 'sUSDS';

export type Token = {
  readonly chainId: OseroChainId;
  readonly address: Address;
  readonly symbol: TokenSymbol;
  readonly decimals: number;
  readonly name: string;
};

const TOKENS: {
  readonly [K in OseroChainId]: { readonly [S in TokenSymbol]: Token };
} = {
  1: {
    USDC: {
      chainId: 1,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
    },
    USDS: {
      chainId: 1,
      address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
      symbol: 'USDS',
      decimals: 18,
      name: 'USDS Stablecoin',
    },
    sUSDS: {
      chainId: 1,
      address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
      symbol: 'sUSDS',
      decimals: 18,
      name: 'Savings USDS',
    },
  },
  10: {
    USDC: {
      chainId: 10,
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
    },
    USDS: {
      chainId: 10,
      address: '0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3',
      symbol: 'USDS',
      decimals: 18,
      name: 'USDS Stablecoin',
    },
    sUSDS: {
      chainId: 10,
      address: '0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0',
      symbol: 'sUSDS',
      decimals: 18,
      name: 'Savings USDS',
    },
  },
  130: {
    USDC: {
      chainId: 130,
      address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
    },
    USDS: {
      chainId: 130,
      address: '0x7E10036Acc4B56d4dFCa3b77810356CE52313F9C',
      symbol: 'USDS',
      decimals: 18,
      name: 'USDS Stablecoin',
    },
    sUSDS: {
      chainId: 130,
      address: '0xA06b10Db9F390990364A3984C04FaDf1c13691b5',
      symbol: 'sUSDS',
      decimals: 18,
      name: 'Savings USDS',
    },
  },
  8453: {
    USDC: {
      chainId: 8453,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
    },
    USDS: {
      chainId: 8453,
      address: '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc',
      symbol: 'USDS',
      decimals: 18,
      name: 'USDS Stablecoin',
    },
    sUSDS: {
      chainId: 8453,
      address: '0x5875eEE11Cf8398102FdAd704C9E96607675467a',
      symbol: 'sUSDS',
      decimals: 18,
      name: 'Savings USDS',
    },
  },
  42161: {
    USDC: {
      chainId: 42161,
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      decimals: 6,
      name: 'USD Coin',
    },
    USDS: {
      chainId: 42161,
      address: '0x6491c05A82219b8D1479057361ff1654749b876b',
      symbol: 'USDS',
      decimals: 18,
      name: 'USDS Stablecoin',
    },
    sUSDS: {
      chainId: 42161,
      address: '0xdDb46999F8891663a8F2828d25298f70416d7610',
      symbol: 'sUSDS',
      decimals: 18,
      name: 'Savings USDS',
    },
  },
};

/**
 * Look up a canonical token descriptor by chain ID and symbol. Always
 * returns a populated {@link Token}: the registry is keyed statically
 * so every `(chainId, symbol)` pair is guaranteed to exist for
 * supported chains.
 */
export function getToken(chainId: OseroChainId, symbol: TokenSymbol): Token {
  return TOKENS[chainId][symbol];
}

/**
 * Return every token registered for a chain, in a stable order.
 */
export function listTokens(chainId: OseroChainId): readonly Token[] {
  const entries = TOKENS[chainId];
  return [entries.USDC, entries.USDS, entries.sUSDS];
}
