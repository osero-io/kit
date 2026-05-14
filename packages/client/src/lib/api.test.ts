import { type Address, type Hex } from 'viem';
import { vi } from 'vitest';

import { flattenExecutionPlan, runExecutionPlan, type SingleTxExecutor } from './adapters.js';
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
import { errAsync, okAsync } from './result.js';
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
    expect(txCalls.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'MINT_SUSDS']);
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
      expect(result.value.operations).toEqual(['APPROVE_ERC20', 'MINT_SUSDS']);
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
    expect(txCalls.map((tx) => tx.operation)).toEqual(['APPROVE_ERC20', 'REDEEM_SUSDS_FOR_USDC']);
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
    ['swap', 2, ['APPROVE_ERC20', 'MINT_SUSDS']],
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
});
