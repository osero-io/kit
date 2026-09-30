import { defineChain, type Address, type Chain as ViemChain } from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';

/**
 * Chains with local sUSDS action capabilities in `@osero/client`.
 *
 * This is intentionally not the hosted API chain list. `OseroApiClient`
 * accepts API asset refs and response chains independently of these local
 * contract capabilities.
 */
export const SUPPORTED_CHAIN_IDS = [1, 10, 130, 8453, 42161] as const;
export type OseroChainId = (typeof SUPPORTED_CHAIN_IDS)[number];
export type TokenSymbol = 'USDC' | 'USDS' | 'sUSDS';
export type ProtocolKind = 'ethereum-lite-psm' | 'psm3';
export type SwapMode = 'exact-in' | 'exact-out';
export type ReferralCapability = 'none' | 'uint16' | 'uint256';

// viem versions at the supported peer-dependency floor predate the built-in
// `unichain` export. Keep the definition at the capability source of truth.
const unichain = defineChain({
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

export type Token = {
  readonly chainId: OseroChainId;
  readonly address: Address;
  readonly symbol: TokenSymbol;
  readonly decimals: number;
  readonly name: string;
};

export type RouteCapability = {
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  readonly exactIn: boolean;
  readonly exactOut: boolean;
  readonly exactInReferral: ReferralCapability;
  readonly exactOutReferral: ReferralCapability;
};

export type SsrSource = {
  readonly address: Address;
  readonly functionName: 'ssr' | 'getSSR';
};

export type ChainCapability = {
  readonly chainId: OseroChainId;
  readonly name: string;
  readonly shortName: string;
  readonly viemChain: ViemChain;
  readonly explorerUrl: string;
  readonly protocol: ProtocolKind;
  readonly tokens: Readonly<Record<TokenSymbol, Token>>;
  readonly contracts: {
    readonly psm: Address;
    readonly litePsm?: Address;
  };
  readonly ssr: SsrSource;
  readonly routes: readonly RouteCapability[];
};

const token = (
  chainId: OseroChainId,
  symbol: TokenSymbol,
  address: Address,
  decimals: number,
  name: string,
): Token => ({ chainId, symbol, address, decimals, name });

const L2_ROUTES: readonly RouteCapability[] = [
  ['USDC', 'USDS'],
  ['USDC', 'sUSDS'],
  ['USDS', 'USDC'],
  ['USDS', 'sUSDS'],
  ['sUSDS', 'USDC'],
  ['sUSDS', 'USDS'],
].map(([assetIn, assetOut]) => ({
  assetIn: assetIn as TokenSymbol,
  assetOut: assetOut as TokenSymbol,
  exactIn: true,
  exactOut: true,
  exactInReferral: 'uint256' as const,
  exactOutReferral: 'uint256' as const,
}));

const MAINNET_ROUTES: readonly RouteCapability[] = [
  {
    assetIn: 'USDC',
    assetOut: 'USDS',
    exactIn: true,
    exactOut: false,
    exactInReferral: 'none',
    exactOutReferral: 'none',
  },
  {
    assetIn: 'USDC',
    assetOut: 'sUSDS',
    exactIn: true,
    exactOut: false,
    exactInReferral: 'uint16',
    exactOutReferral: 'none',
  },
  {
    assetIn: 'USDS',
    assetOut: 'USDC',
    exactIn: false,
    exactOut: true,
    exactInReferral: 'none',
    exactOutReferral: 'none',
  },
  {
    assetIn: 'USDS',
    assetOut: 'sUSDS',
    exactIn: true,
    exactOut: true,
    exactInReferral: 'uint16',
    exactOutReferral: 'none',
  },
  {
    assetIn: 'sUSDS',
    assetOut: 'USDC',
    exactIn: true,
    exactOut: false,
    exactInReferral: 'none',
    exactOutReferral: 'none',
  },
  {
    assetIn: 'sUSDS',
    assetOut: 'USDS',
    exactIn: true,
    exactOut: true,
    exactInReferral: 'none',
    exactOutReferral: 'none',
  },
];

export const CHAIN_CAPABILITIES: Readonly<Record<OseroChainId, ChainCapability>> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    shortName: 'eth',
    viemChain: mainnet,
    explorerUrl: 'https://etherscan.io',
    protocol: 'ethereum-lite-psm',
    tokens: {
      USDC: token(1, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USD Coin'),
      USDS: token(1, 'USDS', '0xdC035D45d973E3EC169d2276DDab16f1e407384F', 18, 'USDS Stablecoin'),
      sUSDS: token(1, 'sUSDS', '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', 18, 'Savings USDS'),
    },
    contracts: {
      psm: '0xA188EEC8F81263234dA3622A406892F3D630f98c',
      litePsm: '0xf6e72Db5454dd049d0788e411b06CfAF16853042',
    },
    ssr: {
      address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
      functionName: 'ssr',
    },
    routes: MAINNET_ROUTES,
  },
  10: {
    chainId: 10,
    name: 'OP Mainnet',
    shortName: 'op',
    viemChain: optimism,
    explorerUrl: 'https://optimistic.etherscan.io',
    protocol: 'psm3',
    tokens: {
      USDC: token(10, 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, 'USD Coin'),
      USDS: token(10, 'USDS', '0x4F13a96EC5C4Cf34e442b46Bbd98a0791F20edC3', 18, 'USDS Stablecoin'),
      sUSDS: token(10, 'sUSDS', '0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0', 18, 'Savings USDS'),
    },
    contracts: { psm: '0xe0F9978b907853F354d79188A3dEfbD41978af62' },
    ssr: {
      address: '0x6E53585449142A5E6D5fC918AE6BEa341dC81C68',
      functionName: 'getSSR',
    },
    routes: L2_ROUTES,
  },
  130: {
    chainId: 130,
    name: 'Unichain',
    shortName: 'unichain',
    viemChain: unichain,
    explorerUrl: 'https://uniscan.xyz',
    protocol: 'psm3',
    tokens: {
      USDC: token(130, 'USDC', '0x078D782b760474a361dDA0AF3839290b0EF57AD6', 6, 'USD Coin'),
      USDS: token(130, 'USDS', '0x7E10036Acc4B56d4dFCa3b77810356CE52313F9C', 18, 'USDS Stablecoin'),
      sUSDS: token(130, 'sUSDS', '0xA06b10Db9F390990364A3984C04FaDf1c13691b5', 18, 'Savings USDS'),
    },
    contracts: { psm: '0x7b42Ed932f26509465F7cE3FAF76FfCe1275312f' },
    ssr: {
      address: '0x1566BFA55D95686a823751298533D42651183988',
      functionName: 'getSSR',
    },
    routes: L2_ROUTES,
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    viemChain: base,
    explorerUrl: 'https://basescan.org',
    protocol: 'psm3',
    tokens: {
      USDC: token(8453, 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USD Coin'),
      USDS: token(
        8453,
        'USDS',
        '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc',
        18,
        'USDS Stablecoin',
      ),
      sUSDS: token(8453, 'sUSDS', '0x5875eEE11Cf8398102FdAd704C9E96607675467a', 18, 'Savings USDS'),
    },
    contracts: { psm: '0x1601843c5E9bC251A3272907010AFa41Fa18347E' },
    ssr: {
      address: '0x65d946e533748A998B1f0E430803e39A6388f7a1',
      functionName: 'getSSR',
    },
    routes: L2_ROUTES,
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'arbitrum',
    viemChain: arbitrum,
    explorerUrl: 'https://arbiscan.io',
    protocol: 'psm3',
    tokens: {
      USDC: token(42161, 'USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USD Coin'),
      USDS: token(
        42161,
        'USDS',
        '0x6491c05A82219b8D1479057361ff1654749b876b',
        18,
        'USDS Stablecoin',
      ),
      sUSDS: token(
        42161,
        'sUSDS',
        '0xdDb46999F8891663a8F2828d25298f70416d7610',
        18,
        'Savings USDS',
      ),
    },
    contracts: { psm: '0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266' },
    ssr: {
      address: '0xEE2816c1E1eed14d444552654Ed3027abC033A36',
      functionName: 'getSSR',
    },
    routes: L2_ROUTES,
  },
};
