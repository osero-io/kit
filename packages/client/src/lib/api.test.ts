import { type Address, type Hex } from 'viem';
import { vi } from 'vitest';

import { flattenExecutionPlan, runExecutionPlan, type SingleTxExecutor } from './adapters.js';
import {
  OSERO_API_ASSET_IDS,
  OSERO_API_ASSETS,
  OSERO_API_CHAIN_IDS,
  OSERO_API_CHAINS,
  OSERO_API_INPUT_ASSET_IDS,
  OSERO_API_INPUT_ASSETS,
  OSERO_API_OUTPUT_ASSET_IDS,
  OSERO_API_OUTPUT_ASSETS,
  OSERO_API_SOURCE_CHAIN_IDS,
  OSERO_API_SUSDS_ASSET_ID,
  OSERO_API_SWAP_ASSETS,
  OSERO_API_USDS_ASSET_ID,
  OseroApiClient,
  type OseroApiFetch,
  type OseroApiFetchInit,
  type OseroApiFetchResponse,
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
const MAINNET_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MAINNET_USDS: Address = '0xdC035D45d973E3EC169d2276DDab16f1e407384F';
const MAINNET_SUSDS: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const MAINNET_USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const PLASMA_USDE: Address = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34';
const SOURCE_HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION_HASH: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEFAULT_API_KEY = 'osero_default-key_123';
const OVERRIDE_API_KEY = 'osero_override-key_123';
const API_KEY = 'osero_test-key_123';
const UNKNOWN_API_KEY = 'osero_unknown-key_123';
const INVALID_API_KEY = 'bad-key';
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

// A cross-chain quote for a newly integrated swap asset (Ethena USDe on
// Plasma, an 18-decimal token on a chain absent from the original five). The
// `satisfies` check doubles as a compile-time assertion that the new asset id,
// chain id, chain key, symbol, and decimals are all wired into the types.
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

  it('returns UnexpectedError when a successful response has an invalid shape', async () => {
    const { fetch } = makeFetch(jsonResponse({ assets: [{ assetId: 'base:usdc' }] }));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });

  it('validates request input before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 0n,
      slippage: '5.01',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects same-asset quote requests before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(usdsToUsdcQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: OSERO_API_USDS_ASSET_ID,
      toAssetId: OSERO_API_USDS_ASSET_ID,
      amount: '1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts every registered asset in both directions with USDS before fetching quotes', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(usdtToUsdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });
    const assetsIntoUsds = OSERO_API_INPUT_ASSET_IDS.filter(
      (assetId) => assetId !== OSERO_API_USDS_ASSET_ID,
    );
    const assetsFromUsds = OSERO_API_OUTPUT_ASSET_IDS.filter(
      (assetId) => assetId !== OSERO_API_USDS_ASSET_ID,
    );

    for (const assetId of assetsIntoUsds) {
      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: assetId,
        toAssetId: OSERO_API_USDS_ASSET_ID,
        amount: '1',
      });

      expect(result.isOk()).toBe(true);
    }

    for (const assetId of assetsFromUsds) {
      const result = await client.getSwapQuote({
        fromAddress: WALLET,
        fromAssetId: OSERO_API_USDS_ASSET_ID,
        toAssetId: assetId,
        amount: '1',
      });

      expect(result.isOk()).toBe(true);
    }

    expect(calls).toHaveLength(assetsIntoUsds.length + assetsFromUsds.length);
    expect(
      calls.map((call) => {
        const body = JSON.parse(call.init.body ?? '{}') as {
          readonly fromAssetId?: string;
          readonly toAssetId?: string;
        };
        return `${body.fromAssetId ?? ''}->${body.toAssetId ?? ''}`;
      }),
    ).toEqual([
      ...assetsIntoUsds.map((assetId) => `${assetId}->${OSERO_API_USDS_ASSET_ID}`),
      ...assetsFromUsds.map((assetId) => `${OSERO_API_USDS_ASSET_ID}->${assetId}`),
    ]);
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

  it('validates API key candidates before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(supportedAssetsResponse));
    const client = OseroApiClient.create({ apiKey: INVALID_API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('validates quote referral codes before making an HTTP call', async () => {
    const { fetch, calls } = makeFetch(jsonResponse(toSusdsQuoteResponse));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSwapQuote({
      fromAddress: WALLET,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: 1_000_000n,
      referralCode: 2999,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
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

  it('rejects quote responses where required=true but bridge metadata is null', async () => {
    const { fetch } = makeFetch(
      jsonResponse({
        ...toSusdsQuoteResponse,
        bridge: { required: true, protocol: null, statusRequest: null },
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

  it('rejects quote responses where required=false but bridge metadata is set', async () => {
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

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });

  it.each([
    [
      'same asset pair',
      {
        pair: {
          ...toSusdsQuoteResponse.pair,
          to: toSusdsQuoteResponse.pair.from,
        },
      },
    ],
    [
      'unknown direction',
      {
        pair: {
          ...toSusdsQuoteResponse.pair,
          direction: 'mint',
        },
      },
    ],
    [
      'approval token',
      {
        approval: {
          ...toSusdsQuoteResponse.approval,
          token: toSusdsQuoteResponse.pair.to,
        },
      },
    ],
    [
      'approval transaction target',
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
      'approval transaction value',
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
      'execution source chain',
      {
        execution: {
          ...toSusdsQuoteResponse.execution,
          sourceChainId: 1,
        },
      },
    ],
    [
      'same-chain execution over different chains',
      {
        execution: {
          ...toSusdsQuoteResponse.execution,
          kind: 'same-chain',
        },
        bridge: {
          required: false,
          protocol: null,
          statusRequest: null,
        },
      },
    ],
    [
      'bridge requirement',
      {
        execution: {
          ...toSusdsQuoteResponse.execution,
          kind: 'same-chain',
        },
      },
    ],
    [
      'bridge status request source chain',
      {
        bridge: {
          ...toSusdsQuoteResponse.bridge,
          statusRequest: {
            sourceChainId: 1,
            bridgeProtocol: 'stargate',
          },
        },
      },
    ],
  ] as const)('rejects a quote response with inconsistent %s', async (_name, override) => {
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

  it.each([
    ['unknown chain key', { chainKey: 'fantom' }],
    ['unknown asset symbol', { symbol: 'NOTUSD' }],
    ['unsupported chain id', { chainId: 12_345 }],
    ['unsupported decimals', { decimals: 8 }],
    ['unknown asset id', { assetId: 'fantom:usdc' }],
    ['chain key that does not match the asset id', { chainKey: 'base' }],
    ['chain id that does not match the asset id', { chainId: 1 }],
    ['symbol that does not match the asset id', { symbol: 'USDC' }],
    ['registered decimals that do not match the asset id', { decimals: 6 }],
    ['kind that does not match the asset id', { kind: 'vault' }],
  ] as const)('rejects a supported-assets response containing an %s', async (_name, override) => {
    const asset = {
      assetId: 'plasma:usde',
      chainId: 9745,
      chainKey: 'plasma',
      chainName: 'Plasma',
      chainShortName: 'Plasma',
      symbol: 'USDe',
      decimals: 18,
      address: PLASMA_USDE,
      label: 'USDe · Plasma',
      kind: 'counter',
      ...override,
    };
    const { fetch } = makeFetch(jsonResponse({ assets: [asset] }));
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });
});

describe('OSERO API asset registry', () => {
  it('derives asset id lists from the capability registry, originals first', () => {
    expect(OSERO_API_ASSET_IDS).toEqual(OSERO_API_ASSETS.map((asset) => asset.assetId));
    expect(OSERO_API_ASSET_IDS.slice(0, 5)).toEqual([
      'base:usdc',
      'arbitrum:usdc',
      'optimism:usdc',
      'linea:usdc',
      'ethereum:usdc',
    ]);
    expect(OSERO_API_ASSET_IDS).toHaveLength(33);
    expect(OSERO_API_INPUT_ASSET_IDS).toEqual(OSERO_API_INPUT_ASSETS.map((asset) => asset.assetId));
    expect(OSERO_API_OUTPUT_ASSET_IDS).toEqual(
      OSERO_API_OUTPUT_ASSETS.map((asset) => asset.assetId),
    );
  });

  it('includes every newly integrated swap asset', () => {
    for (const assetId of [
      'avalanche_c:usdc',
      'hyperevm:usdc',
      'monad:usdc',
      'polygon:usdc',
      'unichain:usdc',
      'berachain:usdce',
      'ethereum:usde',
      'plasma:usde',
      'ethereum:ausd',
      'ethereum:gho',
      'ethereum:pyusd',
      'arbitrum:pyusd',
      'ethereum:rlusd',
      'ethereum:usdd',
      'ethereum:usdg',
      'ethereum:usdt',
      'ethereum:usdtb',
      'ethereum:frxusd',
      OSERO_API_USDS_ASSET_ID,
      OSERO_API_SUSDS_ASSET_ID,
    ]) {
      expect(OSERO_API_ASSET_IDS).toContain(assetId);
      expect(OSERO_API_INPUT_ASSET_IDS).toContain(assetId);
      expect(OSERO_API_OUTPUT_ASSET_IDS).toContain(assetId);
    }
  });

  it('excludes pairs Enso cannot serve while keeping reachable ones', () => {
    // No native Circle USDC on BNB; BNB stays reachable via USDe.
    expect(OSERO_API_ASSET_IDS).not.toContain('bnb:usdc');
    expect(OSERO_API_ASSET_IDS).toContain('bnb:usde');
    expect(OSERO_API_SOURCE_CHAIN_IDS).toContain(56);
    // World Chain and Ink have no usable Enso bridge route for the swap flow,
    // so neither the assets nor their (now orphaned) chains are registered.
    expect(OSERO_API_ASSET_IDS).not.toContain('worldchain:usdc');
    expect(OSERO_API_ASSET_IDS).not.toContain('ink:usdc');
    expect(OSERO_API_SOURCE_CHAIN_IDS).not.toContain(480);
    expect(OSERO_API_SOURCE_CHAIN_IDS).not.toContain(57073);
  });

  it('registers USDS and sUSDS as first-class input and output assets', () => {
    expect(OSERO_API_USDS_ASSET_ID).toBe('ethereum:usds');
    expect(OSERO_API_SUSDS_ASSET_ID).toBe('ethereum:susds');
    expect(OSERO_API_INPUT_ASSET_IDS).toContain(OSERO_API_USDS_ASSET_ID);
    expect(OSERO_API_OUTPUT_ASSET_IDS).toContain(OSERO_API_USDS_ASSET_ID);
    expect(OSERO_API_INPUT_ASSET_IDS).toContain(OSERO_API_SUSDS_ASSET_ID);
    expect(OSERO_API_OUTPUT_ASSET_IDS).toContain(OSERO_API_SUSDS_ASSET_ID);
  });

  it('supports every registered non-USDS asset in both directions with USDS', () => {
    const assetsExcludingUsds = OSERO_API_ASSET_IDS.filter(
      (assetId) => assetId !== OSERO_API_USDS_ASSET_ID,
    );

    expect(assetsExcludingUsds).toEqual(
      expect.arrayContaining(['ethereum:usdc', 'ethereum:susds', 'ethereum:usde', 'ethereum:usdt']),
    );

    for (const assetId of assetsExcludingUsds) {
      expect(OSERO_API_INPUT_ASSET_IDS).toContain(assetId);
      expect(OSERO_API_OUTPUT_ASSET_IDS).toContain(assetId);
    }

    expect(OSERO_API_INPUT_ASSET_IDS).toContain(OSERO_API_USDS_ASSET_ID);
    expect(OSERO_API_OUTPUT_ASSET_IDS).toContain(OSERO_API_USDS_ASSET_ID);
  });

  it('keeps asset ids, source chain ids, and chain keys unique', () => {
    expect(new Set(OSERO_API_ASSET_IDS).size).toBe(OSERO_API_ASSET_IDS.length);
    expect(new Set(OSERO_API_SOURCE_CHAIN_IDS).size).toBe(OSERO_API_SOURCE_CHAIN_IDS.length);
    const chainKeys = OSERO_API_CHAINS.map((chain) => chain.chainKey);
    expect(new Set(chainKeys).size).toBe(chainKeys.length);
  });

  it('registers all 13 source chains including the newly added ones', () => {
    expect(OSERO_API_SOURCE_CHAIN_IDS).toEqual(OSERO_API_CHAIN_IDS);
    expect(OSERO_API_SOURCE_CHAIN_IDS.slice(0, 5)).toEqual([1, 8453, 42161, 10, 59144]);
    for (const chainId of [56, 130, 137, 143, 999, 9745, 43114, 80094]) {
      expect(OSERO_API_SOURCE_CHAIN_IDS).toContain(chainId);
    }
    expect(OSERO_API_CHAINS).toHaveLength(13);
    expect(OSERO_API_SOURCE_CHAIN_IDS).toHaveLength(13);
  });

  it('binds every asset to a registered chain key (no orphan assets)', () => {
    const chainKeys = new Set<string>(OSERO_API_CHAINS.map((chain) => chain.chainKey));
    for (const { assetId } of OSERO_API_SWAP_ASSETS) {
      expect(chainKeys.has(assetId.split(':')[0]!)).toBe(true);
    }
  });

  it('backs every registered chain with at least one asset (no orphan chains)', () => {
    const usedChainKeys = new Set<string>(
      OSERO_API_SWAP_ASSETS.map((asset) => asset.assetId.split(':')[0]!),
    );
    for (const { chainKey } of OSERO_API_CHAINS) {
      expect(usedChainKeys.has(chainKey)).toBe(true);
    }
  });

  it('uses only 6- or 18-decimal tokens', () => {
    for (const asset of OSERO_API_SWAP_ASSETS) {
      expect([6, 18]).toContain(asset.decimals);
    }
  });
});
