import { defineChain, type Chain as ViemChain } from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';

/**
 * Unichain (chain ID 130) — Uniswap Labs' L2, added here as an inline
 * definition because older versions of viem do not ship it yet. When we
 * bump the viem peer-dependency minimum we can swap this for the
 * `viem/chains` export.
 *
 * @internal
 */
const unichain: ViemChain = defineChain({
  id: 130,
  name: 'Unichain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.unichain.org'] },
  },
  blockExplorers: {
    default: { name: 'Uniscan', url: 'https://uniscan.xyz' },
  },
});

/**
 * The exhaustive list of chain IDs that the Osero SDK supports.
 *
 * Updating this tuple is the single source of truth — all other typed
 * maps in the SDK pivot around it.
 */
export const SUPPORTED_CHAIN_IDS = [1, 10, 130, 8453, 42161] as const;

export type OseroChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/**
 * Metadata describing a chain that the Osero SDK can talk to.
 *
 * `isMainnet` is a semantic flag rather than a geography flag: it is
 * `true` only for Ethereum L1 (chain ID 1) because that chain uses the
 * Sky/Maker {@link usdsPsmWrapperAbi | UsdsPsmWrapper}, while every L2
 * uses {@link psm3Abi | PSM3}.
 */
export type ChainMetadata = {
  readonly chainId: OseroChainId;
  readonly name: string;
  readonly shortName: string;
  readonly viemChain: ViemChain;
  readonly isMainnet: boolean;
  readonly explorerUrl: string;
};

export const CHAINS: {
  readonly [K in OseroChainId]: ChainMetadata;
} = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    shortName: 'eth',
    viemChain: mainnet,
    isMainnet: true,
    explorerUrl: 'https://etherscan.io',
  },
  10: {
    chainId: 10,
    name: 'OP Mainnet',
    shortName: 'op',
    viemChain: optimism,
    isMainnet: false,
    explorerUrl: 'https://optimistic.etherscan.io',
  },
  130: {
    chainId: 130,
    name: 'Unichain',
    shortName: 'unichain',
    viemChain: unichain,
    isMainnet: false,
    explorerUrl: 'https://uniscan.xyz',
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    viemChain: base,
    isMainnet: false,
    explorerUrl: 'https://basescan.org',
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'arbitrum',
    viemChain: arbitrum,
    isMainnet: false,
    explorerUrl: 'https://arbiscan.io',
  },
};

/**
 * Narrowing type guard that tells TypeScript an arbitrary number is one
 * of the {@link OseroChainId | supported chain IDs}.
 */
export function isSupportedChainId(chainId: number): chainId is OseroChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId);
}

/**
 * Look up a chain by ID. Returns `null` for unsupported chains instead
 * of throwing so it can be used ergonomically from inside Result chains.
 */
export function getChain(chainId: number): ChainMetadata | null {
  if (!isSupportedChainId(chainId)) return null;
  return CHAINS[chainId];
}

/**
 * Return every chain supported by the SDK. The order matches
 * {@link SUPPORTED_CHAIN_IDS}.
 */
export function listChains(): readonly ChainMetadata[] {
  return SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id]);
}
