import type { Address } from 'viem';

import { CHAIN_CAPABILITIES, type OseroChainId } from './capabilities.js';

export type PsmAddresses = {
  readonly psm: Address;
  readonly litePsm?: Address;
};

export const PSM_ADDRESSES: Readonly<Record<OseroChainId, PsmAddresses>> = Object.fromEntries(
  Object.entries(CHAIN_CAPABILITIES).map(([chainId, capability]) => [
    Number(chainId),
    capability.contracts,
  ]),
) as Readonly<Record<OseroChainId, PsmAddresses>>;
