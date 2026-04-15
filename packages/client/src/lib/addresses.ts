import type { Address } from 'viem';

import type { OseroChainId } from './chains.js';

/**
 * The Osero SDK only needs one entry-point contract per chain, though
 * on Ethereum mainnet we additionally track the underlying Lite PSM
 * address because it is the source of truth for `tin` / `tout`.
 */
export type PsmAddresses = {
  /**
   * On L2s this is the Spark `PSM3` address — the atomic USDC ⇄ USDS
   * ⇄ sUSDS router.
   *
   * On Ethereum mainnet this is the Spark `UsdsPsmWrapper` that sits
   * in front of the Sky Lite PSM and exposes USDC ⇄ USDS to end users.
   */
  readonly psm: Address;
  /**
   * On Ethereum mainnet, the underlying Sky/Maker Lite PSM
   * (`MCD_LITE_PSM_USDC_A`). Exposed solely so that callers can read
   * `tin()` / `tout()` directly if they want to audit the fee. The SDK
   * never routes funds through it — transfers always go via the
   * wrapper.
   *
   * Undefined on every L2.
   */
  readonly litePsm?: Address;
};

export const PSM_ADDRESSES: { readonly [K in OseroChainId]: PsmAddresses } = {
  1: {
    psm: '0xA188EEC8F81263234dA3622A406892F3D630f98c',
    litePsm: '0xf6e72Db5454dd049d0788e411b06CfAF16853042',
  },
  10: {
    psm: '0xe0F9978b907853F354d79188A3dEfbD41978af62',
  },
  130: {
    psm: '0x7b42Ed932f26509465F7cE3FAF76FfCe1275312f',
  },
  8453: {
    psm: '0x1601843c5E9bC251A3272907010AFa41Fa18347E',
  },
  42161: {
    psm: '0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266',
  },
};
