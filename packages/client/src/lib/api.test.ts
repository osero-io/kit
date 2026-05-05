import { type Address, type Hex } from 'viem';
import { vi } from 'vitest';

import { flattenExecutionPlan } from './adapters.js';
import {
  OseroApiClient,
  type OseroApiFetch,
  type OseroApiFetchInit,
  type OseroApiFetchResponse,
  type OseroApiSupportedAsset,
  type OseroApiSwapQuoteResponse,
  type OseroApiSwapStatusResponse,
  type OseroApiSupportedAssetsResponse,
} from './api.js';
import { ApiRequestError, UnexpectedError, ValidationError } from './errors.js';
import type { TransactionRequest } from './types.js';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const EXECUTOR: Address = '0x3333333333333333333333333333333333333333';
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAINNET_USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MAINNET_SUSDS: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const SOURCE_HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION_HASH: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEFAULT_API_KEY = 'osero_default-key_123';
const OVERRIDE_API_KEY = 'osero_override-key_123';
const API_KEY = 'osero_test-key_123';
const UNKNOWN_API_KEY = 'osero_unknown-key_123';
const INVALID_API_KEY = 'bad-key';

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
        'MINT_SUSDS',
      ]);
      expect(transactions[1]!.chainId).toBe(8453);
      expect(transactions[1]!.value).toBe(123n);
    }
  });

  it('maps from-sUSDS quotes to a redeem execution operation', async () => {
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
      ).toEqual(['APPROVE_ERC20', 'REDEEM_SUSDS_FOR_USDC']);
    }
  });

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
});
