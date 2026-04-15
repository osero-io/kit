import { getAddress } from 'viem';

import { SUPPORTED_CHAIN_IDS } from './chains.js';
import { getToken, listTokens, type TokenSymbol } from './tokens.js';

const ALL_SYMBOLS: TokenSymbol[] = ['USDC', 'USDS', 'sUSDS'];

describe('token registry', () => {
  it('has every symbol on every supported chain', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const symbol of ALL_SYMBOLS) {
        const token = getToken(chainId, symbol);
        expect(token.symbol).toBe(symbol);
        expect(token.chainId).toBe(chainId);
      }
    }
  });

  it('uses the correct decimals — 6 for USDC, 18 for USDS/sUSDS', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      expect(getToken(chainId, 'USDC').decimals).toBe(6);
      expect(getToken(chainId, 'USDS').decimals).toBe(18);
      expect(getToken(chainId, 'sUSDS').decimals).toBe(18);
    }
  });

  it('uses valid EIP-55 checksummed addresses', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const symbol of ALL_SYMBOLS) {
        const token = getToken(chainId, symbol);
        // getAddress throws if the address is invalid or the casing
        // doesn't match the checksum — exactly what we want to assert.
        expect(getAddress(token.address)).toBe(token.address);
      }
    }
  });

  it('lists every token per chain in USDC/USDS/sUSDS order', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const tokens = listTokens(chainId);
      expect(tokens).toHaveLength(3);
      expect(tokens.map((t) => t.symbol)).toEqual(ALL_SYMBOLS);
    }
  });

  it('matches the mainnet canonical addresses from the PSM guide', () => {
    expect(getToken(1, 'USDC').address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(getToken(1, 'USDS').address).toBe('0xdC035D45d973E3EC169d2276DDab16f1e407384F');
    expect(getToken(1, 'sUSDS').address).toBe('0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD');
  });

  it('matches the Base canonical addresses from the PSM guide', () => {
    expect(getToken(8453, 'USDC').address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(getToken(8453, 'USDS').address).toBe('0x820C137fa70C8691f0e44Dc420a5e53c168921Dc');
    expect(getToken(8453, 'sUSDS').address).toBe('0x5875eEE11Cf8398102FdAd704C9E96607675467a');
  });
});
