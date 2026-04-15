import {
  CHAINS,
  getChain,
  isSupportedChainId,
  listChains,
  type OseroChainId,
  SUPPORTED_CHAIN_IDS,
} from './chains.js';

describe('chain registry', () => {
  it('supports exactly the five documented chains', () => {
    expect([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b)).toEqual([1, 10, 130, 8453, 42161]);
  });

  it('marks only Ethereum mainnet with isMainnet=true', () => {
    const mainnetOnly = listChains().filter((c) => c.isMainnet);
    expect(mainnetOnly).toHaveLength(1);
    expect(mainnetOnly[0]!.chainId).toBe(1);
  });

  it('returns the correct viem chain for each supported ID', () => {
    expect(CHAINS[1]!.viemChain.id).toBe(1);
    expect(CHAINS[10]!.viemChain.id).toBe(10);
    expect(CHAINS[130]!.viemChain.id).toBe(130);
    expect(CHAINS[8453]!.viemChain.id).toBe(8453);
    expect(CHAINS[42161]!.viemChain.id).toBe(42161);
  });

  it('exposes human-readable short names consistent with chain IDs', () => {
    expect(CHAINS[1]!.shortName).toBe('eth');
    expect(CHAINS[10]!.shortName).toBe('op');
    expect(CHAINS[130]!.shortName).toBe('unichain');
    expect(CHAINS[8453]!.shortName).toBe('base');
    expect(CHAINS[42161]!.shortName).toBe('arbitrum');
  });

  describe('getChain', () => {
    it('returns the chain for every supported ID', () => {
      for (const id of SUPPORTED_CHAIN_IDS) {
        expect(getChain(id)?.chainId).toBe(id);
      }
    });

    it('returns null for an unsupported ID', () => {
      expect(getChain(999_999_999)).toBeNull();
      expect(getChain(-1)).toBeNull();
      expect(getChain(0)).toBeNull();
    });
  });

  describe('isSupportedChainId', () => {
    it('narrows supported IDs to OseroChainId', () => {
      const id: number = 8453;
      if (isSupportedChainId(id)) {
        // type-narrowing check — `id` is now OseroChainId
        const narrowed: OseroChainId = id;
        expect(narrowed).toBe(8453);
      } else {
        // unreachable
        expect.fail('expected 8453 to be supported');
      }
    });

    it('returns false for unknown IDs', () => {
      expect(isSupportedChainId(137)).toBe(false);
      expect(isSupportedChainId(0)).toBe(false);
    });
  });
});
