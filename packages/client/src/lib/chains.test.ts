import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Address,
  type Hex,
} from 'viem';

import { getTokenBalances } from './balances.js';
import {
  CHAINS,
  getChain,
  isSupportedChainId,
  listChains,
  type OseroChainId,
  SUPPORTED_CHAIN_IDS,
} from './chains.js';
import { OseroClient } from './OseroClient.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

describe('chain registry', () => {
  it('supports exactly the five documented chains', () => {
    expect([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b)).toEqual([1, 10, 130, 8453, 42161]);
  });

  it('models protocol differences explicitly rather than through a mainnet flag', () => {
    expect(CHAINS[1].protocol).toBe('ethereum-lite-psm');
    expect(listChains().filter((chain) => chain.protocol === 'psm3')).toHaveLength(4);
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

describe('Unichain chain definition', () => {
  it('keeps the published metadata and declares only the canonical Multicall3', () => {
    // `extend` is a helper viem attaches to every defined chain, not chain metadata.
    const { extend: _extend, ...definition } = CHAINS[130]
      .viemChain as (typeof CHAINS)[130]['viemChain'] & {
      extend?: unknown;
    };
    expect(definition).toEqual({
      id: 130,
      name: 'Unichain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://mainnet.unichain.org'] } },
      blockExplorers: { default: { name: 'Uniscan', url: 'https://uniscan.xyz' } },
      contracts: { multicall3: { address: MULTICALL3, blockCreated: 0 } },
    });
  });

  it('declares Multicall3 at the canonical address on every supported chain', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      expect(CHAINS[chainId].viemChain.contracts?.multicall3?.address.toLowerCase()).toBe(
        MULTICALL3.toLowerCase(),
      );
    }
  });

  it.each(['require', 'prefer'] as const)(
    'aggregates balances through Multicall3 on chain 130 with multicall: %s',
    async (multicall) => {
      const calls: { readonly method: string; readonly to?: Address }[] = [];
      const transport = custom({
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          const call = (params as readonly [{ to?: Address; data?: Hex }])?.[0];
          calls.push({ method, ...(call?.to === undefined ? {} : { to: call.to }) });
          if (method !== 'eth_call' || call?.data === undefined) {
            throw new Error(`unexpected RPC ${method}`);
          }
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data });
          const requested = decoded.args?.[0] as readonly unknown[];
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            result: requested.map((_entry, index) => ({
              success: true,
              returnData: `0x${(index + 1).toString(16).padStart(64, '0')}` as Hex,
            })),
          });
        },
      });
      const client = OseroClient.create({ transports: { 130: transport } });

      const result = await getTokenBalances(client, {
        chainId: 130,
        account: '0x1111111111111111111111111111111111111111',
        multicall,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value).toEqual({ USDC: 1n, USDS: 2n, sUSDS: 3n });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('eth_call');
      expect(calls[0]?.to?.toLowerCase()).toBe(MULTICALL3.toLowerCase());
    },
  );
});
