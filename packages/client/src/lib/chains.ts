import {
  CHAIN_CAPABILITIES,
  type OseroChainId,
  type ProtocolKind,
  SUPPORTED_CHAIN_IDS,
} from './capabilities.js';

export { type OseroChainId, SUPPORTED_CHAIN_IDS } from './capabilities.js';

export type ChainMetadata = {
  readonly chainId: OseroChainId;
  readonly name: string;
  readonly shortName: string;
  readonly viemChain: (typeof CHAIN_CAPABILITIES)[OseroChainId]['viemChain'];
  readonly protocol: ProtocolKind;
  readonly explorerUrl: string;
};

export const CHAINS: Readonly<Record<OseroChainId, ChainMetadata>> = Object.fromEntries(
  SUPPORTED_CHAIN_IDS.map((chainId) => {
    const capability = CHAIN_CAPABILITIES[chainId];
    return [
      chainId,
      {
        chainId,
        name: capability.name,
        shortName: capability.shortName,
        viemChain: capability.viemChain,
        protocol: capability.protocol,
        explorerUrl: capability.explorerUrl,
      },
    ];
  }),
) as Readonly<Record<OseroChainId, ChainMetadata>>;

export function isSupportedChainId(chainId: number): chainId is OseroChainId {
  return (
    Number.isSafeInteger(chainId) && (SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId)
  );
}

export function getChain(chainId: number): ChainMetadata | null {
  return isSupportedChainId(chainId) ? CHAINS[chainId] : null;
}

export function listChains(): readonly ChainMetadata[] {
  return SUPPORTED_CHAIN_IDS.map((chainId) => CHAINS[chainId]);
}
