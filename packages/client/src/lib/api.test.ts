import { type Address, type Hex } from 'viem';
import { vi } from 'vitest';

import { flattenExecutionPlan, runExecutionPlan, type SingleTxExecutor } from './adapters.js';
import {
  matchOseroApiAsset,
  OseroApiClient,
  OSERO_API_KNOWN_ASSET_IDS,
  OSERO_API_KNOWN_ASSETS,
  OSERO_API_KNOWN_BRIDGE_PROTOCOLS,
  OSERO_API_KNOWN_CHAIN_IDS,
  OSERO_API_KNOWN_CHAINS,
  OSERO_API_SUSDS_ASSET_ID,
  OSERO_API_USDS_ASSET_ID,
  type OseroApiAssetRef,
  type OseroApiFetch,
  type OseroApiFetchInit,
  type OseroApiFetchResponse,
  type OseroApiIntegerString,
  type OseroApiSupportedAsset,
  type OseroApiSupportedAssetsResponse,
  type OseroApiSwapQuoteResponse,
  type OseroApiSwapStatusResponse,
} from './api.js';
import { ApiRequestError, UnexpectedError, ValidationError } from './errors.js';
import { errAsync, okAsync } from './result.js';
import type { TransactionRequest } from './types.js';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const EXECUTOR: Address = '0x3333333333333333333333333333333333333333';
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDC_UPPERCASE_HEX: Address = '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913';
const BASE_USDC_BAD_CHECKSUM: Address = '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAINNET_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MAINNET_USDS: Address = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const MAINNET_SUSDS: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const MAINNET_USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const PLASMA_USDE: Address = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34';
const SONIC_USDX: Address = '0x4444444444444444444444444444444444444444';
const SONIC_USDY: Address = '0x5555555555555555555555555555555555555555';
const SOURCE_HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION_HASH: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEFAULT_API_KEY = 'osero_default-key_123';
const OVERRIDE_API_KEY = 'osero_override-key_123';
const API_KEY = 'osero_test-key_123';
const UNKNOWN_API_KEY = 'osero_unknown-key_123';
const UNPREFIXED_API_KEY = `legacy!${'x'.repeat(256)}`;
const LARGE_HEX_TRANSACTION_VALUE = '0x1000000000000000A';
const LARGE_HEX_TRANSACTION_VALUE_DECIMAL = BigInt(LARGE_HEX_TRANSACTION_VALUE).toString();
const UINT256_OVERFLOW_DECIMAL = (2n ** 256n).toString();
const UINT256_OVERFLOW_HEX = `0x1${'0'.repeat(64)}`;

type FetchCall = {
  readonly url: string;
  readonly init: OseroApiFetchInit;
};

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = status === 200 ? 'OK' : 'Error',
): OseroApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  };
}

function makeFetch(response: OseroApiFetchResponse): {
  readonly fetch: OseroApiFetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch = vi.fn<OseroApiFetch>(async (url: string, init: OseroApiFetchInit) => {
    calls.push({ url, init });
    return response;
  });
  return { fetch, calls };
}

function transactionHash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, '0')}` as Hex;
}

function makeRecordingExecutor(calls: TransactionRequest[], failAt?: number): SingleTxExecutor {
  return vi.fn<SingleTxExecutor>((tx) => {
    calls.push(tx);
    if (calls.length === failAt) {
      return errAsync(UnexpectedError.from(new Error(`transaction ${calls.length} failed`)));
    }
    return okAsync(transactionHash(calls.length));
  });
}

const supportedAssetsResponse = {
  assets: [
    {
      assetId: 'base:usdc',
      chainId: 8453,
      chainKey: 'base',
      chainName: 'Base',
      chainShortName: 'Base',
      symbol: 'USDC',
      decimals: 6,
      address: BASE_USDC,
      label: 'USDC - Base',
      kind: 'counter',
    },
    {
      assetId: 'ethereum:usds',
      chainId: 1,
      chainKey: 'ethereum',
      chainName: 'Ethereum',
      chainShortName: 'Mainnet',
      symbol: 'USDS',
      decimals: 18,
      address: MAINNET_USDS,
      label: 'USDS - Mainnet',
      kind: 'counter',
    },
    {
      assetId: 'ethereum:susds',
      chainId: 1,
      chainKey: 'ethereum',
      chainName: 'Ethereum',
      chainShortName: 'Mainnet',
      symbol: 'sUSDS',
      decimals: 18,
      address: MAINNET_SUSDS,
      label: 'sUSDS - Mainnet',
      kind: 'vault',
    },
  ],
} satisfies OseroApiSupportedAssetsResponse;

const toSusdsQuoteResponse = {
  pair: {
    direction: 'to-susds',
    from: {
      assetId: 'base:usdc',
      chainId: 8453,
      chainKey: 'base',
      chainName: 'Base',
      chainShortName: 'Base',
      symbol: 'USDC',
      decimals: 6,
      address: BASE_USDC,
      label: 'USDC - Base',
    },
    to: {
      assetId: 'ethereum:susds',
      chainId: 1,
      chainKey: 'ethereum',
      chainName: 'Ethereum',
      chainShortName: 'Mainnet',
      symbol: 'sUSDS',
      decimals: 18,
      address: MAINNET_SUSDS,
      label: 'sUSDS - Mainnet',
    },
  },
  quote: {
    amountIn: { raw: '1000000', formatted: '1' },
    amountOut: { raw: '1001000000000000000', formatted: '1.001' },
    previewUnavailable: false,
    slippage: { bps: '50', percent: '0.5' },
    gas: '500000',
    priceImpactBps: 15,
    createdAt: 1_712_345_680,
  },
  approval: {
    token: {
      assetId: 'base:usdc',
      chainId: 8453,
      chainKey: 'base',
      chainName: 'Base',
      chainShortName: 'Base',
      symbol: 'USDC',
      decimals: 6,
      address: BASE_USDC,
      label: 'USDC - Base',
    },
    spender: SPENDER,
    amount: { raw: '1000000', formatted: '1' },
    gas: '21000',
    transaction: {
      to: BASE_USDC,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    kind: 'cross-chain',
    sourceChainId: 8453,
    destinationChainId: 1,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0x1234',
      value: '123',
    },
    route: [
      {
        protocol: 'stargate',
        action: 'bridge',
        chainId: 8453,
        sourceChainId: 8453,
        destinationChainId: 1,
      },
    ],
  },
  bridge: {
    required: true,
    protocol: 'stargate',
    statusRequest: {
      sourceChainId: 8453,
      bridgeProtocol: 'stargate',
    },
  },
} satisfies OseroApiSwapQuoteResponse;

const fromSusdsQuoteResponse = {
  ...toSusdsQuoteResponse,
  pair: {
    direction: 'from-susds',
    from: toSusdsQuoteResponse.pair.to,
    to: {
      ...toSusdsQuoteResponse.pair.from,
      assetId: 'ethereum:usdc',
      chainId: 1,
      chainKey: 'ethereum',
      chainName: 'Ethereum',
      chainShortName: 'Mainnet',
      address: MAINNET_USDC,
      label: 'USDC - Mainnet',
    },
  },
  approval: {
    ...toSusdsQuoteResponse.approval,
    token: toSusdsQuoteResponse.pair.to,
    transaction: {
      to: MAINNET_SUSDS,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    ...toSusdsQuoteResponse.execution,
    kind: 'same-chain',
    sourceChainId: 1,
    destinationChainId: 1,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0x5678',
      value: '0',
    },
    route: [
      {
        protocol: 'enso',
        action: 'route',
        chainId: 1,
        sourceChainId: null,
        destinationChainId: null,
      },
    ],
  },
  bridge: {
    required: false,
    protocol: null,
    statusRequest: null,
  },
} satisfies OseroApiSwapQuoteResponse;

const mainnetUsdsAsset = {
  ...fromSusdsQuoteResponse.pair.to,
  assetId: 'ethereum:usds',
  symbol: 'USDS',
  decimals: 18,
  address: MAINNET_USDS,
  label: 'USDS - Mainnet',
} as const;

const mainnetUsdtAsset = {
  ...fromSusdsQuoteResponse.pair.to,
  assetId: 'ethereum:usdt',
  symbol: 'USDT',
  decimals: 6,
  address: MAINNET_USDT,
  label: 'USDT - Mainnet',
} as const;

const usdsToUsdcQuoteResponse = {
  ...fromSusdsQuoteResponse,
  pair: {
    direction: 'swap',
    from: mainnetUsdsAsset,
    to: fromSusdsQuoteResponse.pair.to,
  },
  quote: {
    ...fromSusdsQuoteResponse.quote,
    amountIn: { raw: '1000000000000000000', formatted: '1' },
    amountOut: { raw: '999000', formatted: '0.999' },
  },
  approval: {
    ...fromSusdsQuoteResponse.approval,
    token: mainnetUsdsAsset,
    amount: { raw: '1000000000000000000', formatted: '1' },
    transaction: {
      to: MAINNET_USDS,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    ...fromSusdsQuoteResponse.execution,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0xabcd',
      value: '0',
    },
  },
} satisfies OseroApiSwapQuoteResponse;

const usdtToUsdsQuoteResponse = {
  ...fromSusdsQuoteResponse,
  pair: {
    direction: 'swap',
    from: mainnetUsdtAsset,
    to: mainnetUsdsAsset,
  },
  quote: {
    ...fromSusdsQuoteResponse.quote,
    amountIn: { raw: '1000000', formatted: '1' },
    amountOut: { raw: '999000000000000000', formatted: '0.999' },
  },
  approval: {
    ...fromSusdsQuoteResponse.approval,
    token: mainnetUsdtAsset,
    amount: { raw: '1000000', formatted: '1' },
    transaction: {
      to: MAINNET_USDT,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    ...fromSusdsQuoteResponse.execution,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0xef01',
      value: '0',
    },
  },
} satisfies OseroApiSwapQuoteResponse;

// A cross-chain quote for a known-snapshot asset beyond the original chains
// (Ethena USDe on Plasma, an 18-decimal token on chain 9745).
const plasmaUsdeToSusdsQuote = {
  pair: {
    direction: 'to-susds',
    from: {
      assetId: 'plasma:usde',
      chainId: 9745,
      chainKey: 'plasma',
      chainName: 'Plasma',
      chainShortName: 'Plasma',
      symbol: 'USDe',
      decimals: 18,
      address: PLASMA_USDE,
      label: 'USDe · Plasma',
    },
    to: toSusdsQuoteResponse.pair.to,
  },
  quote: {
    amountIn: { raw: '1000000000000000000', formatted: '1' },
    amountOut: { raw: '999000000000000000', formatted: '0.999' },
    previewUnavailable: false,
    slippage: { bps: '50', percent: '0.5' },
    gas: '500000',
    priceImpactBps: 12,
    createdAt: 1_712_345_680,
  },
  approval: {
    token: {
      assetId: 'plasma:usde',
      chainId: 9745,
      chainKey: 'plasma',
      chainName: 'Plasma',
      chainShortName: 'Plasma',
      symbol: 'USDe',
      decimals: 18,
      address: PLASMA_USDE,
      label: 'USDe · Plasma',
    },
    spender: SPENDER,
    amount: { raw: '1000000000000000000', formatted: '1' },
    gas: '21000',
    transaction: {
      to: PLASMA_USDE,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    kind: 'cross-chain',
    sourceChainId: 9745,
    destinationChainId: 1,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0x1234',
      value: '0',
    },
    route: [
      {
        protocol: 'stargate',
        action: 'bridge',
        chainId: 9745,
        sourceChainId: 9745,
        destinationChainId: 1,
      },
    ],
  },
  bridge: {
    required: true,
    protocol: 'stargate',
    statusRequest: {
      sourceChainId: 9745,
      bridgeProtocol: 'stargate',
    },
  },
} satisfies OseroApiSwapQuoteResponse;

// An asset entirely unknown to this SDK release: a fictional chain (Sonic,
// chain id 64165) serving an 8-decimal token. The `satisfies` checks below
// double as compile-time proof that the widened response types represent
// vocabulary the SDK has never seen.
const sonicUsdxAsset = {
  assetId: 'sonic:usdx',
  chainId: 64_165,
  chainKey: 'sonic',
  chainName: 'Sonic',
  chainShortName: 'Sonic',
  symbol: 'USDX',
  decimals: 8,
  address: SONIC_USDX,
  label: 'USDX · Sonic',
} as const;

const unknownAssetQuoteResponse = {
  pair: {
    direction: 'rebalance',
    from: sonicUsdxAsset,
    to: {
      ...sonicUsdxAsset,
      assetId: 'sonic:usdy',
      symbol: 'USDY',
      address: SONIC_USDY,
      label: 'USDY · Sonic',
    },
  },
  quote: {
    amountIn: { raw: '100000000', formatted: '1' },
    amountOut: { raw: '99000000', formatted: '0.99' },
    previewUnavailable: false,
    slippage: { bps: '50', percent: '0.5' },
    gas: '500000',
    priceImpactBps: 3,
    createdAt: 1_712_345_680,
  },
  approval: {
    token: sonicUsdxAsset,
    spender: SPENDER,
    amount: { raw: '100000000', formatted: '1' },
    gas: '21000',
    transaction: {
      to: SONIC_USDX,
      from: WALLET,
      data: '0x095ea7b3',
      value: '0',
    },
  },
  execution: {
    kind: 'same-chain',
    sourceChainId: 64_165,
    destinationChainId: 64_165,
    transaction: {
      to: EXECUTOR,
      from: WALLET,
      data: '0x9abc',
      value: '0',
    },
    route: [
      {
        protocol: 'enso',
        action: 'route',
        chainId: 64_165,
        sourceChainId: null,
        destinationChainId: null,
      },
    ],
  },
  bridge: {
    required: false,
    protocol: null,
    statusRequest: null,
  },
} satisfies OseroApiSwapQuoteResponse;

describe('OseroApiClient', () => {
  it('lists supported assets with a request-level API key override', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(supportedAssetsResponse));
    const client = OseroApiClient.create({
      apiKey: DEFAULT_API_KEY,
      baseUrl: 'http://localhost:3000/v1',
      fetch,
    });

    const result = await client.getSupportedAssets({ apiKey: OVERRIDE_API_KEY });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:3000/v1/swap/assets');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers['x-api-key']).toBe(OVERRIDE_API_KEY);
    if (result.isOk()) {
      expect(result.value.assets.map((asset: OseroApiSupportedAsset) => asset.assetId)).toEqual([
        'base:usdc',
        'ethereum:usds',
        'ethereum:susds',
      ]);
    }
  });

  it('fetches a quote and adds an execution plan compatible with wallet adapters', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://api.example.test/v1/',
      fetch,
    });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
      slippage: '0.5',
      referralCode: 3002,
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/swap/quote');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toEqual({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: '1000000',
      slippage: '0.5',
      referralCode: 3002,
    });

    if (result.isOk()) {
      const plan = result.value.executionPlan;
      const transactions = flattenExecutionPlan(plan);
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals[0]!.token).toBe(BASE_USDC);
      expect(plan.approvals[0]!.spender).toBe(SPENDER);
      expect(plan.approvals[0]!.amount).toBe(1_000_000n);
      expect(transactions.map((tx: TransactionRequest) => tx.operation)).toEqual([
        'APPROVE_ERC20',
        'SWAP',
      ]);
      expect(transactions[1]!.chainId).toBe(8453);
      expect(transactions[1]!.value).toBe(123n);
    }
  });

  it('pipes a cross-chain API quote execution plan into the web3 transaction handler', async () => {
    const { fetch } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });
    const txCalls: TransactionRequest[] = [];
    const executor = makeRecordingExecutor(txCalls);

    const result = await client
      .getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: 'base:usdc',
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
      })
      .andThen((quote) => runExecutionPlan(quote.executionPlan, executor));

    expect(result.isOk()).toBe(true);
    expect(txCalls).toHaveLength(2);
    expect(txCalls.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
    expect(txCalls[0]).toMatchObject({
      chainId: 8453,
      from: WALLET,
      to: BASE_USDC,
      data: '0x095ea7b3',
      value: 0n,
    });
    expect(txCalls[1]).toMatchObject({
      chainId: 8453,
      from: WALLET,
      to: EXECUTOR,
      data: '0x1234',
      value: 123n,
    });
    if (result.isOk()) {
      expect(result.value.txHash).toBe(transactionHash(2));
      expect(result.value.operations).toEqual(['APPROVE_ERC20', 'SWAP']);
    }
  });

  it('normalizes JSON numbers and mixed-case hex transaction values', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...toSusdsQuoteResponse,
        approval: {
          ...toSusdsQuoteResponse.approval,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            value: 0,
          },
        },
        execution: {
          ...toSusdsQuoteResponse.execution,
          transaction: {
            ...toSusdsQuoteResponse.execution.transaction,
            value: LARGE_HEX_TRANSACTION_VALUE,
          },
        },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const txCalls: TransactionRequest[] = [];
      const executionResult = await runExecutionPlan(
        result.value.executionPlan,
        makeRecordingExecutor(txCalls),
      );
      const transactions = flattenExecutionPlan(result.value.executionPlan);
      expect(result.value.approval.transaction.value).toBe('0');
      expect(result.value.execution.transaction.value).toBe(LARGE_HEX_TRANSACTION_VALUE_DECIMAL);
      expect(transactions[0]!.value).toBe(0n);
      expect(transactions[1]!.value).toBe(BigInt(LARGE_HEX_TRANSACTION_VALUE));
      expect(executionResult.isOk()).toBe(true);
      expect(txCalls.map((tx) => tx.value)).toEqual([0n, BigInt(LARGE_HEX_TRANSACTION_VALUE)]);
    }
  });

  it('maps from-sUSDS quotes to a generic swap execution operation', async () => {
    const { fetch } = makeFetch(jsonResponse(fromSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'ethereum:susds',
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(
        flattenExecutionPlan(result.value.executionPlan).map(
          (tx: TransactionRequest) => tx.operation,
        ),
      ).toEqual(['APPROVE_ERC20', 'SWAP']);
    }
  });

  it('accepts USDS as a swap input for USDS to USDC quotes', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(usdsToUsdcQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: OSERO_API_USDS_ASSET_ID,
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });

    expect(result.isOk()).toBe(true);
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({
      fromAssetId: 'ethereum:usds',
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });
    if (result.isOk()) {
      const transactions = flattenExecutionPlan(result.value.executionPlan);
      expect(result.value.pair.from.symbol).toBe('USDS');
      expect(result.value.pair.to.symbol).toBe('USDC');
      expect(result.value.approval.token.address).toBe(MAINNET_USDS);
      expect(transactions.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
      expect(transactions[0]!.to).toBe(MAINNET_USDS);
      expect(transactions[1]!.data).toBe('0xabcd');
    }
  });

  it('accepts USDS as a swap output for USDT to USDS quotes', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(usdtToUsdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'ethereum:usdt',
      toAssetId: OSERO_API_USDS_ASSET_ID,
      amount: 1_000_000n,
    });

    expect(result.isOk()).toBe(true);
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({
      fromAssetId: 'ethereum:usdt',
      toAssetId: 'ethereum:usds',
      amount: '1000000',
    });
    if (result.isOk()) {
      const transactions = flattenExecutionPlan(result.value.executionPlan);
      expect(result.value.pair.from.symbol).toBe('USDT');
      expect(result.value.pair.from.decimals).toBe(6);
      expect(result.value.pair.to.symbol).toBe('USDS');
      expect(result.value.pair.to.decimals).toBe(18);
      expect(result.value.approval.token.address).toBe(MAINNET_USDT);
      expect(transactions.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
      expect(transactions[0]!.to).toBe(MAINNET_USDT);
      expect(transactions[1]!.data).toBe('0xef01');
    }
  });

  it('pipes a same-chain from-sUSDS API quote execution plan into the web3 handler', async () => {
    const { fetch } = makeFetch(jsonResponse(fromSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });
    const txCalls: TransactionRequest[] = [];

    const result = await client
      .getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: 'ethereum:susds',
        toAssetId: 'ethereum:usdc',
        amount: '1000000000000000000',
      })
      .andThen((quote) => runExecutionPlan(quote.executionPlan, makeRecordingExecutor(txCalls)));

    expect(result.isOk()).toBe(true);
    expect(txCalls).toHaveLength(2);
    expect(txCalls.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
    expect(txCalls.map((tx) => tx.chainId)).toEqual([1, 1]);
    expect(txCalls[0]).toMatchObject({
      from: WALLET,
      to: MAINNET_SUSDS,
      data: '0x095ea7b3',
      value: 0n,
    });
    expect(txCalls[1]).toMatchObject({
      from: WALLET,
      to: EXECUTOR,
      data: '0x5678',
      value: 0n,
    });
    if (result.isOk()) {
      expect(result.value.txHash).toBe(transactionHash(2));
    }
  });

  it.each([
    ['negative number', -1],
    ['unsafe number', Number.MAX_SAFE_INTEGER + 1],
    ['float', 1.5],
    ['empty hex', '0x'],
    ['uppercase hex prefix', '0X7b'],
    ['invalid hex', '0xZZ'],
    ['garbage string', 'abc'],
    ['leading zero decimal', '01'],
    ['negative string', '-1'],
    ['decimal string float', '1.0'],
    ['uint256 decimal overflow', UINT256_OVERFLOW_DECIMAL],
    ['uint256 hex overflow', UINT256_OVERFLOW_HEX],
  ] as const)(
    'does not call the web3 transaction handler when transaction.value is %s',
    async (_name, value) => {
      const { fetch } = makeFetch(
        jsonResponse({
          ...toSusdsQuoteResponse,
          approval: {
            ...toSusdsQuoteResponse.approval,
            transaction: {
              ...toSusdsQuoteResponse.approval.transaction,
              value,
            },
          },
        }),
      );
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });
      const txCalls: TransactionRequest[] = [];
      const executor = makeRecordingExecutor(txCalls);

      const result = await client
        .getSwapQuote({
          fromAddress: WALLET,
          fromAssetId: 'base:usdc',
          toAssetId: 'ethereum:susds',
          amount: 1_000_000n,
        })
        .andThen((quote) => runExecutionPlan(quote.executionPlan, executor));

      expect(result.isErr()).toBe(true);
      expect(txCalls).toHaveLength(0);
      expect(executor).not.toHaveBeenCalled();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
      }
    },
  );

  it.each([
    ['approval', 1, ['APPROVE_ERC20']],
    ['swap', 2, ['APPROVE_ERC20', 'SWAP']],
  ] as const)(
    'short-circuits API quote execution when the %s transaction fails',
    async (_failedStep, failAt, expectedOperations) => {
      const { fetch } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });
      const txCalls: TransactionRequest[] = [];

      const result = await client
        .getSwapQuote({
          fromAddress: WALLET,
          fromAssetId: 'base:usdc',
          toAssetId: 'ethereum:susds',
          amount: 1_000_000n,
        })
        .andThen((quote) =>
          runExecutionPlan(quote.executionPlan, makeRecordingExecutor(txCalls, failAt)),
        );

      expect(result.isErr()).toBe(true);
      expect(txCalls).toHaveLength(failAt);
      expect(txCalls.map((tx) => tx.operation)).toEqual(expectedOperations);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
      }
    },
  );

  it('fetches bridge status with query params', async () => {
    const statusResponse = {
      bridge: {
        protocol: 'stargate',
        state: 'completed',
        providerStatus: 'delivered',
        sourceChainId: 8453,
        destinationChainId: 1,
        sourceTxHash: SOURCE_HASH,
        destinationTxHash: DESTINATION_HASH,
        error: null,
      },
    } satisfies OseroApiSwapStatusResponse;
    const { fetch, calls } = makeFetch(jsonResponse(statusResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatus({
      txHash: SOURCE_HASH,
      sourceChainId: 8453,
      bridgeProtocol: 'stargate',
    });

    expect(result.isOk()).toBe(true);
    expect(calls[0]!.url).toBe(
      'https://api.osero.org/v1/swap/status/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?sourceChainId=8453&bridgeProtocol=stargate',
    );
  });

  it('encodes status requests for chains and bridge protocols unknown to this SDK release', async () => {
    const statusResponse = {
      bridge: {
        protocol: 'across',
        state: 'pending',
        providerStatus: 'inflight',
        sourceChainId: 999_999,
        destinationChainId: null,
        sourceTxHash: SOURCE_HASH,
        destinationTxHash: null,
        error: null,
      },
    } satisfies OseroApiSwapStatusResponse;
    const { fetch, calls } = makeFetch(jsonResponse(statusResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatus({
      txHash: SOURCE_HASH,
      sourceChainId: 999_999,
      bridgeProtocol: 'across',
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api.osero.org/v1/swap/status/${SOURCE_HASH}?sourceChainId=999999&bridgeProtocol=across`,
    );
  });

  it('rejects malformed status request tx hashes before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse({}));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatus({
      txHash: '0x1234',
      sourceChainId: 8453,
      bridgeProtocol: 'stargate',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a zero sourceChainId', { sourceChainId: 0, bridgeProtocol: 'stargate' }],
    ['a negative sourceChainId', { sourceChainId: -1, bridgeProtocol: 'stargate' }],
    ['a fractional sourceChainId', { sourceChainId: 1.5, bridgeProtocol: 'stargate' }],
    ['an empty bridgeProtocol', { sourceChainId: 8453, bridgeProtocol: '' }],
    ['a whitespace-only bridgeProtocol', { sourceChainId: 8453, bridgeProtocol: '   ' }],
  ] as const)(
    'rejects status requests with %s before making an HTTP call',
    async (_name, fields) => {
      const { fetch, calls } = makeFetch(jsonResponse({}));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapStatus({
        txHash: SOURCE_HASH,
        ...fields,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it('returns ApiRequestError for non-2xx API responses', async () => {
    const { fetch } = makeFetch(
      jsonResponse(
        {
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid API key.',
          correlationId: 'abc-123',
        },
        401,
        'Unauthorized',
      ),
    );
    const client = OseroApiClient.create({ apiKey: UNKNOWN_API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      expect(error).toBeInstanceOf(ApiRequestError);
      if (error instanceof ApiRequestError) {
        expect(error.statusCode).toBe(401);
        expect(error.code).toBe('UNAUTHORIZED');
        expect(error.correlationId).toBe('abc-123');
      }
    }
  });

  it('extracts the stable API error code from non-2xx quote responses', async () => {
    const { fetch } = makeFetch(
      jsonResponse(
        {
          statusCode: 400,
          code: 'SWAP_PAIR_NOT_SUPPORTED',
          message: 'The requested swap pair is not supported.',
        },
        400,
        'Bad Request',
      ),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'base:usdc',
      amount: 1_000_000n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      expect(error).toBeInstanceOf(ApiRequestError);
      if (error instanceof ApiRequestError) {
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe('SWAP_PAIR_NOT_SUPPORTED');
      }
    }
  });

  it('returns UnexpectedError when a successful response has an invalid shape', async () => {
    const { fetch } = makeFetch(jsonResponse({ assets: [{ assetId: 'base:usdc' }] }));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });

  it.each([
    ['a truncated hex string', '0x123'],
    ['a bad-checksum mixed-case address', BASE_USDC_BAD_CHECKSUM],
  ] as const)(
    'rejects %s as fromAddress before making an HTTP call',
    async (_name, fromAddress) => {
      const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapQuote({
        fromAddress,
        fromAssetId: 'base:usdc',
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ['zero', 0n],
    ['negative bigint', -1n],
    ['negative integer string', '-1'],
    ['leading-zero integer string', '01'],
    ['decimal string', '1.5'],
    ['garbage string', 'abc'],
  ])('rejects %s amounts before making an HTTP call', async (_name, amount) => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: amount as bigint | OseroApiIntegerString,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('sends asset ids unknown to this SDK release to the API unchanged', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'sonic:usdx',
      toAssetId: 'ethereum:notacoin',
      amount: 1_000_000n,
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({
      fromAssetId: 'sonic:usdx',
      toAssetId: 'ethereum:notacoin',
    });
  });

  it('passes same-asset quote requests through to the API', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(usdsToUsdcQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: OSERO_API_USDS_ASSET_ID,
      toAssetId: OSERO_API_USDS_ASSET_ID,
      amount: '1',
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({
      fromAssetId: OSERO_API_USDS_ASSET_ID,
      toAssetId: OSERO_API_USDS_ASSET_ID,
    });
  });

  it('rejects quote request amount overflows before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 2n ** 256n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-containing string', 'osero_bad key'],
    ['a control-character string', 'osero_bad\nkey'],
    ['a non-ASCII string', 'osero_clé'],
  ] as const)('rejects %s as an API key before making an HTTP call', async (_name, apiKey) => {
    const { fetch, calls } = makeFetch(jsonResponse(supportedAssetsResponse));
    const client = OseroApiClient.create({ apiKey, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts visible-ASCII API keys outside the advisory prefix and length conventions', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(supportedAssetsResponse));
    const client = OseroApiClient.create({ apiKey: UNPREFIXED_API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers['x-api-key']).toBe(UNPREFIXED_API_KEY);
  });

  it.each([42, 1.5, 9999] as const)(
    'passes the finite referral code %d through to the API',
    async (referralCode) => {
      const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: 'base:usdc',
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
        referralCode,
      });

      expect(result.isOk()).toBe(true);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({ referralCode });
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const)(
    'rejects the non-finite referral code %s before making an HTTP call',
    async (_name, referralCode) => {
      const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: 'base:usdc',
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
        referralCode,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it('passes slippage strings through to the API verbatim', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
      slippage: '7.123',
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body ?? '{}') as unknown).toMatchObject({
      slippage: '7.123',
    });
  });

  it('uses bridge.statusRequest to call getSwapStatus from a cross-chain quote', async () => {
    const statusResponse = {
      bridge: {
        protocol: 'stargate',
        state: 'pending',
        providerStatus: 'inflight',
        sourceChainId: 8453,
        destinationChainId: 1,
        sourceTxHash: SOURCE_HASH,
        destinationTxHash: null,
        error: null,
      },
    } satisfies OseroApiSwapStatusResponse;
    const { fetch, calls } = makeFetch(jsonResponse(statusResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatusForQuote(toSusdsQuoteResponse, SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api.osero.org/v1/swap/status/${SOURCE_HASH}?sourceChainId=8453&bridgeProtocol=stargate`,
    );
  });

  it('returns a ValidationError when getSwapStatusForQuote is called with a same-chain quote', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(supportedAssetsResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatusForQuote(fromSusdsQuoteResponse, SOURCE_HASH);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    [
      'protocol and statusRequest are null',
      { required: true, protocol: null, statusRequest: null },
    ],
    [
      'protocol is null',
      {
        required: true,
        protocol: null,
        statusRequest: { sourceChainId: 8453, bridgeProtocol: 'stargate' },
      },
    ],
    ['statusRequest is null', { required: true, protocol: 'stargate', statusRequest: null }],
  ] as const)(
    'rejects quote responses where bridge.required is true but %s',
    async (_name, bridge) => {
      const { fetch } = makeFetch(jsonResponse({ ...toSusdsQuoteResponse, bridge }));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: 'base:usdc',
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
      }
    },
  );

  it('rejects quote responses with uint256-sized amount overflows', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...toSusdsQuoteResponse,
        quote: {
          ...toSusdsQuoteResponse.quote,
          amountIn: {
            ...toSusdsQuoteResponse.quote.amountIn,
            raw: UINT256_OVERFLOW_DECIMAL,
          },
        },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });

  it('fetches and decodes a quote for a newly added swap asset on a new chain', async () => {
    const { fetch } = makeFetch(jsonResponse(plasmaUsdeToSusdsQuote));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'plasma:usde',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000_000_000_000_000n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.pair.from.assetId).toBe('plasma:usde');
      expect(result.value.pair.from.chainId).toBe(9745);
      expect(result.value.pair.from.symbol).toBe('USDe');
      expect(result.value.pair.from.decimals).toBe(18);
      expect(result.value.execution.sourceChainId).toBe(9745);
      const transactions = flattenExecutionPlan(result.value.executionPlan);
      expect(transactions.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
      expect(transactions.every((tx) => tx.chainId === 9745)).toBe(true);
    }
  });

  it('decodes supported assets spanning new chains, a bridged variant, and 18-decimal tokens', async () => {
    const response = {
      assets: [
        {
          assetId: 'berachain:usdce',
          chainId: 80094,
          chainKey: 'berachain',
          chainName: 'Berachain',
          chainShortName: 'Berachain',
          symbol: 'USDC.e',
          decimals: 6,
          address: '0x549943e04f40284185054145c6E4e9568C1D3241',
          label: 'USDC.e · Berachain',
          kind: 'counter',
        },
        {
          assetId: 'ethereum:gho',
          chainId: 1,
          chainKey: 'ethereum',
          chainName: 'Ethereum',
          chainShortName: 'Mainnet',
          symbol: 'GHO',
          decimals: 18,
          address: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
          label: 'GHO · Mainnet',
          kind: 'counter',
        },
        {
          assetId: 'ethereum:susds',
          chainId: 1,
          chainKey: 'ethereum',
          chainName: 'Ethereum',
          chainShortName: 'Mainnet',
          symbol: 'sUSDS',
          decimals: 18,
          address: MAINNET_SUSDS,
          label: 'sUSDS · Mainnet',
          kind: 'vault',
        },
      ],
    } satisfies OseroApiSupportedAssetsResponse;
    const { fetch } = makeFetch(jsonResponse(response));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.assets.map((asset) => asset.assetId)).toEqual([
        'berachain:usdce',
        'ethereum:gho',
        'ethereum:susds',
      ]);
      expect(result.value.assets.map((asset) => asset.symbol)).toEqual(['USDC.e', 'GHO', 'sUSDS']);
      expect(result.value.assets.map((asset) => asset.chainId)).toEqual([80094, 1, 1]);
      expect(result.value.assets.map((asset) => asset.decimals)).toEqual([6, 18, 18]);
    }
  });
});

describe('forward compatibility', () => {
  it('decodes a supported-assets response listing an asset unknown to this SDK release', async () => {
    const response = {
      assets: [
        {
          ...sonicUsdxAsset,
          kind: 'yield',
        },
      ],
    } satisfies OseroApiSupportedAssetsResponse;
    const { fetch } = makeFetch(jsonResponse(response));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.assets).toEqual([
        {
          assetId: 'sonic:usdx',
          chainId: 64_165,
          chainKey: 'sonic',
          chainName: 'Sonic',
          chainShortName: 'Sonic',
          symbol: 'USDX',
          decimals: 8,
          address: SONIC_USDX,
          label: 'USDX · Sonic',
          kind: 'yield',
        },
      ]);
    }
  });

  it('decodes a quote between unknown 8-decimal assets with unknown pair vocabulary', async () => {
    const { fetch } = makeFetch(jsonResponse(unknownAssetQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'sonic:usdx',
      toAssetId: 'sonic:usdy',
      amount: 100_000_000n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.pair.direction).toBe('rebalance');
      expect(result.value.pair.from.assetId).toBe('sonic:usdx');
      expect(result.value.pair.from.decimals).toBe(8);
      expect(result.value.pair.to.assetId).toBe('sonic:usdy');
      expect(result.value.execution.kind).toBe('same-chain');
      const plan = result.value.executionPlan;
      const transactions = flattenExecutionPlan(plan);
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals[0]!.token).toBe(SONIC_USDX);
      expect(transactions.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'SWAP']);
      expect(transactions.every((tx) => tx.chainId === 64_165)).toBe(true);
    }
  });

  it('decodes a quote with an unknown execution kind and still builds the execution plan', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...unknownAssetQuoteResponse,
        execution: {
          ...unknownAssetQuoteResponse.execution,
          kind: 'batched',
        },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'sonic:usdx',
      toAssetId: 'sonic:usdy',
      amount: 100_000_000n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.execution.kind).toBe('batched');
      expect(flattenExecutionPlan(result.value.executionPlan).map((tx) => tx.operation)).toEqual([
        'APPROVE_ERC20',
        'SWAP',
      ]);
    }
  });

  it('round-trips an unknown bridge protocol from quote decoding into status polling', async () => {
    const acrossQuoteResponse = {
      ...toSusdsQuoteResponse,
      bridge: {
        required: true,
        protocol: 'across',
        statusRequest: {
          sourceChainId: 8453,
          bridgeProtocol: 'across',
        },
      },
    } satisfies OseroApiSwapQuoteResponse;
    const quoteFetch = makeFetch(jsonResponse(acrossQuoteResponse));
    const quoteClient = OseroApiClient.create({ apiKey: API_KEY, fetch: quoteFetch.fetch });

    const quoteResult = await quoteClient.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(quoteResult.isOk()).toBe(true);
    if (quoteResult.isOk()) {
      const statusResponse = {
        bridge: {
          protocol: 'across',
          state: 'pending',
          providerStatus: 'inflight',
          sourceChainId: 8453,
          destinationChainId: 1,
          sourceTxHash: SOURCE_HASH,
          destinationTxHash: null,
          error: null,
        },
      } satisfies OseroApiSwapStatusResponse;
      const statusFetch = makeFetch(jsonResponse(statusResponse));
      const statusClient = OseroApiClient.create({ apiKey: API_KEY, fetch: statusFetch.fetch });

      const statusResult = await statusClient.getSwapStatusForQuote(quoteResult.value, SOURCE_HASH);

      expect(statusResult.isOk()).toBe(true);
      expect(statusFetch.calls).toHaveLength(1);
      expect(statusFetch.calls[0]!.url).toBe(
        `https://api.osero.org/v1/swap/status/${SOURCE_HASH}?sourceChainId=8453&bridgeProtocol=across`,
      );
    }
  });

  it('decodes status responses with unknown state and provider-status vocabulary', async () => {
    const statusResponse = {
      bridge: {
        protocol: 'across',
        state: 'reorged',
        providerStatus: 'requeued',
        sourceChainId: 8453,
        destinationChainId: null,
        sourceTxHash: SOURCE_HASH,
        destinationTxHash: null,
        error: null,
      },
    } satisfies OseroApiSwapStatusResponse;
    const { fetch } = makeFetch(jsonResponse(statusResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapStatus({
      txHash: SOURCE_HASH,
      sourceChainId: 8453,
      bridgeProtocol: 'across',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.bridge.state).toBe('reorged');
      expect(result.value.bridge.providerStatus).toBe('requeued');
    }
  });

  it('tolerates non-null bridge metadata when bridge.required is false', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...fromSusdsQuoteResponse,
        bridge: {
          required: false,
          protocol: 'stargate',
          statusRequest: { sourceChainId: 1, bridgeProtocol: 'stargate' },
        },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'ethereum:susds',
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.bridge.required).toBe(false);
      expect(result.value.bridge.protocol).toBe('stargate');
      expect(result.value.bridge.statusRequest).toEqual({
        sourceChainId: 1,
        bridgeProtocol: 'stargate',
      });
    }
  });

  it('tolerates absent bridge metadata keys when bridge.required is false', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...fromSusdsQuoteResponse,
        bridge: { required: false },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'ethereum:susds',
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.bridge).toEqual({
        required: false,
        protocol: null,
        statusRequest: null,
      });
    }
  });

  it('still rejects absent bridge metadata keys when bridge.required is true', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...fromSusdsQuoteResponse,
        bridge: { required: true },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'ethereum:susds',
      toAssetId: 'ethereum:usdc',
      amount: '1000000000000000000',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });
});

describe('dropped correlations', () => {
  it('decodes quotes whose approval token and execution chains diverge from the display pair', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...toSusdsQuoteResponse,
        approval: {
          ...toSusdsQuoteResponse.approval,
          token: toSusdsQuoteResponse.pair.to,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            to: MAINNET_SUSDS,
          },
        },
        execution: {
          ...toSusdsQuoteResponse.execution,
          sourceChainId: 1,
        },
        bridge: {
          ...toSusdsQuoteResponse.bridge,
          statusRequest: {
            ...toSusdsQuoteResponse.bridge.statusRequest,
            sourceChainId: 1,
          },
        },
      }),
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.approval.token.assetId).not.toBe(result.value.pair.from.assetId);
      expect(result.value.execution.sourceChainId).not.toBe(result.value.pair.from.chainId);
      const transactions = flattenExecutionPlan(result.value.executionPlan);
      expect(transactions[0]!.to).toBe(MAINNET_SUSDS);
      expect(transactions.map((tx) => tx.chainId)).toEqual([1, 1]);
    }
  });

  it.each([
    [
      'approval transaction targets a contract other than the approval token',
      {
        approval: {
          ...toSusdsQuoteResponse.approval,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            to: MAINNET_SUSDS,
          },
        },
      },
    ],
    [
      'approval token belongs to a chain other than the execution source',
      {
        approval: {
          ...toSusdsQuoteResponse.approval,
          token: toSusdsQuoteResponse.pair.to,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            to: MAINNET_SUSDS,
          },
        },
      },
    ],
    [
      'approval transaction carries a non-zero value',
      {
        approval: {
          ...toSusdsQuoteResponse.approval,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            value: '1',
          },
        },
      },
    ],
    [
      'approval and execution transactions have different signers',
      {
        approval: {
          ...toSusdsQuoteResponse.approval,
          transaction: {
            ...toSusdsQuoteResponse.approval.transaction,
            from: SPENDER,
          },
        },
      },
    ],
    [
      'bridge status request targets a chain other than the execution source',
      {
        bridge: {
          ...toSusdsQuoteResponse.bridge,
          statusRequest: {
            ...toSusdsQuoteResponse.bridge.statusRequest,
            sourceChainId: 1,
          },
        },
      },
    ],
  ] as const)('still rejects a quote response whose %s', async (_name, override) => {
    const { fetch } = makeFetch(jsonResponse({ ...toSusdsQuoteResponse, ...override }));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });
});

describe('asset locators', () => {
  it('serializes locators as lowercased chain-scoped address refs', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: { chainId: 8453, address: BASE_USDC },
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init.body ?? '{}') as { readonly fromAssetId?: string };
    expect(body.fromAssetId).toBe('8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it.each([0, -1, 1.5] as const)(
    'rejects locators with chain id %d before making an HTTP call',
    async (chainId) => {
      const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: { chainId, address: BASE_USDC },
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ['a bad-checksum mixed-case address', BASE_USDC_BAD_CHECKSUM],
    ['a garbage address', '0xnotanaddress'],
  ] as const)('rejects locators with %s before making an HTTP call', async (_name, address) => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: { chainId: 8453, address },
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ] as const)('rejects %s as an asset ref before making an HTTP call', async (_name, assetRef) => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: assetRef,
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 8453],
  ] as const)(
    'returns a ValidationError instead of throwing when the asset ref is %s',
    async (_name, assetRef) => {
      const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

      // JS callers (or unsound casts) can pass non-ref values; the client
      // must keep its ResultAsync contract and never throw synchronously.
      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: assetRef as unknown as OseroApiAssetRef,
        toAssetId: 'ethereum:susds',
        amount: 1_000_000n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
      expect(calls).toHaveLength(0);
    },
  );
});

describe('matchOseroApiAsset', () => {
  const assets = supportedAssetsResponse.assets;

  it('matches canonical asset ids', () => {
    expect(matchOseroApiAsset(assets, 'ethereum:usds')?.address).toBe(MAINNET_USDS);
  });

  it('matches chain-scoped address string refs case-insensitively', () => {
    const match = matchOseroApiAsset(assets, `8453:${BASE_USDC_UPPERCASE_HEX}`);
    expect(match?.assetId).toBe('base:usdc');
  });

  it('matches structured locators regardless of address casing', () => {
    const match = matchOseroApiAsset(assets, {
      chainId: 8453,
      address: BASE_USDC_UPPERCASE_HEX,
    });
    expect(match?.assetId).toBe('base:usdc');
  });

  it('returns undefined when no listed asset matches', () => {
    expect(matchOseroApiAsset(assets, 'sonic:usdx')).toBeUndefined();
    expect(matchOseroApiAsset(assets, { chainId: 999, address: BASE_USDC })).toBeUndefined();
  });

  it.each([
    ['a colon-less string', 'nocolon'],
    ['a non-hex address tail', '8453:nothex'],
  ] as const)('returns undefined for %s ref instead of throwing', (_name, ref) => {
    expect(matchOseroApiAsset(assets, ref)).toBeUndefined();
  });
});

describe('advisory known registries', () => {
  it('keeps known asset ids unique', () => {
    expect(new Set(OSERO_API_KNOWN_ASSET_IDS).size).toBe(OSERO_API_KNOWN_ASSET_IDS.length);
  });

  it('keeps known chain ids and chain keys unique', () => {
    expect(new Set(OSERO_API_KNOWN_CHAIN_IDS).size).toBe(OSERO_API_KNOWN_CHAIN_IDS.length);
    const chainKeys = OSERO_API_KNOWN_CHAINS.map((chain) => chain.chainKey);
    expect(new Set(chainKeys).size).toBe(chainKeys.length);
  });

  it('lists the USDS and sUSDS hub assets', () => {
    expect(OSERO_API_KNOWN_ASSET_IDS).toContain(OSERO_API_USDS_ASSET_ID);
    expect(OSERO_API_KNOWN_ASSET_IDS).toContain(OSERO_API_SUSDS_ASSET_ID);
  });

  it('prefixes every known asset id with a known chain key', () => {
    const chainKeys = new Set<string>(OSERO_API_KNOWN_CHAINS.map((chain) => chain.chainKey));
    for (const { assetId } of OSERO_API_KNOWN_ASSETS) {
      expect(chainKeys.has(assetId.split(':')[0]!)).toBe(true);
    }
  });

  it('snapshots the bridge protocols known at this SDK release', () => {
    expect(OSERO_API_KNOWN_BRIDGE_PROTOCOLS).toEqual(['ccip', 'layerzero', 'relay', 'stargate']);
  });
});
