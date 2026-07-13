import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import type { Mock } from 'vitest';

import { mockFn } from './_testing.js';
import { erc20Abi } from './abis/erc20.js';
import {
  matchOseroApiAsset,
  oseroApiAmount,
  OseroApiClient,
  type OseroApiFetch,
  type OseroApiInputAmount,
  type OseroApiSwapQuoteRequest,
  type OseroApiSwapQuoteResponse,
  type OseroApiSwapStatusResponse,
} from './api.js';
import { parseSlippage, referral, UINT256_MAX } from './domain.js';
import {
  ApiRequestError,
  ApiResponseError,
  ConfigurationError,
  InsufficientAllowanceError,
  TimeoutError,
} from './errors.js';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET: Address = '0x9999999999999999999999999999999999999999';
const TOKEN: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OUTPUT_TOKEN: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const OTHER_SPENDER: Address = '0x7777777777777777777777777777777777777777';
const EXECUTOR: Address = '0x3333333333333333333333333333333333333333';
const SOURCE_HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION_HASH: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const API_KEY = 'osero_test-key';

function amount(raw = 1_000_000n): OseroApiInputAmount {
  const result = oseroApiAmount(raw);
  if (result.isErr()) throw result.error;
  return result.value;
}

function quoteRequest(overrides: Partial<OseroApiSwapQuoteRequest> = {}): OseroApiSwapQuoteRequest {
  return {
    fromAddress: WALLET,
    fromAssetId: 'base:usdc',
    toAssetId: 'ethereum:susds',
    amount: amount(),
    ...overrides,
  };
}

type QuoteFixtureOptions = {
  readonly requestedAmount?: string;
  readonly executionFrom?: Address;
  readonly approvalFrom?: Address;
  readonly approvalTokenChainId?: number;
  readonly approvalTo?: Address;
  readonly approvalSpender?: Address;
  readonly encodedSpender?: Address;
  readonly bridgeSourceChainId?: number;
  readonly bridgeProtocol?: string;
};

function quoteFixture(options: QuoteFixtureOptions = {}): OseroApiSwapQuoteResponse {
  const requestedAmount = options.requestedAmount ?? '1000000';
  const approvalSpender = options.approvalSpender ?? SPENDER;
  const approvalData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [options.encodedSpender ?? approvalSpender, BigInt(requestedAmount)],
  });
  return {
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
        address: TOKEN,
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
        address: OUTPUT_TOKEN,
        label: 'sUSDS - Mainnet',
      },
    },
    quote: {
      amountIn: { raw: requestedAmount as `${bigint}`, formatted: '1' },
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
        chainId: options.approvalTokenChainId ?? 8453,
        chainKey: 'base',
        chainName: 'Base',
        chainShortName: 'Base',
        symbol: 'USDC',
        decimals: 6,
        address: TOKEN,
        label: 'USDC - Base',
      },
      spender: approvalSpender,
      amount: { raw: requestedAmount as `${bigint}`, formatted: '1' },
      gas: '21000',
      transaction: {
        to: options.approvalTo ?? TOKEN,
        from: options.approvalFrom ?? WALLET,
        data: approvalData,
        value: '0',
      },
    },
    execution: {
      kind: 'cross-chain',
      sourceChainId: 8453,
      destinationChainId: 1,
      transaction: {
        to: EXECUTOR,
        from: options.executionFrom ?? WALLET,
        data: '0x1234',
        value: '123',
      },
      route: [
        {
          protocol: options.bridgeProtocol ?? 'stargate',
          action: 'bridge',
          chainId: 8453,
          sourceChainId: 8453,
          destinationChainId: 1,
        },
      ],
    },
    bridge: {
      required: true,
      protocol: options.bridgeProtocol ?? 'stargate',
      statusRequest: {
        sourceChainId: options.bridgeSourceChainId ?? 8453,
        bridgeProtocol: options.bridgeProtocol ?? 'stargate',
      },
    },
  };
}

function statusFixture(state: string, providerStatus = state): OseroApiSwapStatusResponse {
  return {
    bridge: {
      protocol: 'future-bridge',
      state,
      providerStatus,
      sourceChainId: 8453,
      destinationChainId: state === 'completed' ? 1 : null,
      sourceTxHash: SOURCE_HASH,
      destinationTxHash: state === 'completed' ? DESTINATION_HASH : null,
      error: state === 'failed' ? 'bridge failed' : null,
    },
  };
}

type FetchResponse = {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
};

type CapturedRequest = {
  readonly url: string;
  readonly init?: RequestInit;
};

function fetchSequence(...responses: FetchResponse[]): {
  readonly fetch: OseroApiFetch;
  readonly calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let index = 0;
  const fetch = mockFn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input.toString(), init });
      const selected = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (selected === undefined) throw new Error('No mock response configured');
      const status = selected.status ?? 200;
      return new Response(JSON.stringify(selected.body), {
        status,
        statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
        headers: selected.headers,
      });
    },
  );
  return { fetch, calls };
}

function publicClient(
  allowance: bigint,
  chainId = 8453,
): {
  readonly client: PublicClient;
  readonly getBlockNumber: Mock;
  readonly readContract: Mock;
} {
  const getBlockNumber = mockFn(async () => 123n);
  const readContract = mockFn(async () => allowance);
  const client = {
    chain: { ...base, id: chainId },
    getBlockNumber,
    readContract,
  } as unknown as PublicClient;
  return { client, getBlockNumber, readContract };
}

describe('OseroApiClient request boundaries', () => {
  it('rejects malformed constructor configuration before any request', () => {
    expect(() => OseroApiClient.create(null as never)).toThrow(ConfigurationError);
    expect(() => OseroApiClient.create({ apiKey: '' })).toThrow(ConfigurationError);
    expect(() => OseroApiClient.create({ apiKeyProvider: 'key' as never })).toThrow(
      ConfigurationError,
    );
    expect(() => OseroApiClient.create({ publicClientProvider: 1 as never })).toThrow(
      ConfigurationError,
    );
    expect(() => OseroApiClient.create({ baseUrl: '/relative' })).toThrow(ConfigurationError);
    expect(() => OseroApiClient.create({ fetch: 1 as never })).toThrow(ConfigurationError);
  });

  it('brands only positive uint256 hosted amounts', () => {
    const zero = oseroApiAmount(0n);
    const overflow = oseroApiAmount(UINT256_MAX + 1n);

    expect(zero.isErr()).toBe(true);
    expect(overflow.isErr()).toBe(true);
  });

  it('returns a typed result when no API key source is configured', async () => {
    const transport = fetchSequence({ body: { assets: [] } });
    const client = OseroApiClient.create({ fetch: transport.fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(transport.calls).toHaveLength(0);
  });

  it('applies per-request, provider, and static API-key precedence', async () => {
    const transport = fetchSequence(
      { body: { assets: [] } },
      { body: { assets: [] } },
      { body: { assets: [] } },
    );
    const provider = mockFn(async () => 'osero_provider-key');
    const client = OseroApiClient.create({
      apiKey: 'osero_static-key',
      apiKeyProvider: provider,
      fetch: transport.fetch,
    });

    await client.getSupportedAssets({ apiKey: 'osero_request-key' });
    await client.getSupportedAssets();
    const staticOnly = OseroApiClient.create({
      apiKey: 'osero_static-key',
      fetch: transport.fetch,
    });
    await staticOnly.getSupportedAssets();

    expect(new Headers(transport.calls[0]?.init?.headers).get('x-api-key')).toBe(
      'osero_request-key',
    );
    expect(new Headers(transport.calls[1]?.init?.headers).get('x-api-key')).toBe(
      'osero_provider-key',
    );
    expect(new Headers(transport.calls[2]?.init?.headers).get('x-api-key')).toBe(
      'osero_static-key',
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('decodes unknown asset vocabulary and uint8 decimals without a local allowlist', async () => {
    const futureAsset = {
      assetId: 'future:usdq',
      chainId: 999_999,
      chainKey: 'future',
      chainName: 'Future Chain',
      chainShortName: 'Future',
      symbol: 'USDQ',
      decimals: 2,
      address: OTHER_WALLET,
      label: 'USDQ - Future',
      kind: 'future-yield-token',
    };
    const transport = fetchSequence({ body: { assets: [futureAsset] } });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSupportedAssets();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.assets[0]).toEqual(futureAsset);
      expect(matchOseroApiAsset(result.value.assets, 'future:usdq')).toEqual(futureAsset);
      expect(
        matchOseroApiAsset(result.value.assets, {
          chainId: 999_999,
          address: OTHER_WALLET,
        }),
      ).toEqual(futureAsset);
    }
  });

  it('serializes branded amount, slippage, referral, and address-form assets exactly', async () => {
    const slippage = parseSlippage('12.5');
    const referralResult = referral(3001n);
    if (slippage.isErr() || referralResult.isErr()) throw new Error('test input failed');
    const transport = fetchSequence({ body: quoteFixture() });
    const rpc = publicClient(1_000_000n);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: { chainId: 8453, address: TOKEN },
        slippage: slippage.value,
        referral: referralResult.value,
      }),
    );

    expect(result.isOk()).toBe(true);
    const body = JSON.parse(String(transport.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      fromAssetId: `8453:${TOKEN.toLowerCase()}`,
      toAssetId: 'ethereum:susds',
      amount: '1000000',
      slippage: '12.5',
      referralCode: 3001,
    });
  });

  it('preserves authoritative API error code, correlation ID, and retry timing', async () => {
    const transport = fetchSequence({
      body: { code: 'SWAP_ASSET_NOT_SUPPORTED', message: 'unsupported' },
      status: 429,
      headers: { 'x-correlation-id': 'corr-123', 'retry-after': '2' },
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ApiRequestError);
      if (result.error instanceof ApiRequestError) {
        expect(result.error.apiCode).toBe('SWAP_ASSET_NOT_SUPPORTED');
        expect(result.error.correlationId).toBe('corr-123');
        expect(result.error.retryAfterMs).toBe(2_000);
      }
    }
  });

  it('maps caller abort to cancellation instead of a transport error', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const transport = fetchSequence({ body: { assets: [] } });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSupportedAssets({ signal: controller.signal });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    expect(transport.calls).toHaveLength(0);
  });
});

describe('hosted quote verification and preparation', () => {
  it('requires an explicit public-client provider before requesting executable quotes', async () => {
    const transport = fetchSequence({ body: quoteFixture() });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(quoteRequest());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(transport.calls).toHaveLength(0);
  });

  it('returns the rich decoded quote with an allowance-aware, bound execution plan', async () => {
    const transport = fetchSequence({ body: quoteFixture({ bridgeProtocol: 'future-bridge' }) });
    const rpc = publicClient(0n);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(quoteRequest());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.bridge.protocol).toBe('future-bridge');
      expect(result.value.executionPlan.metadata).toMatchObject({ source: 'hosted-api' });
      expect(result.value.executionPlan.steps.map((step) => step.operation)).toEqual([
        'APPROVE_ERC20',
        'SWAP_EXACT_IN',
      ]);
      expect(result.value.executionPlan.metadata.allowanceSnapshots).toEqual([
        expect.objectContaining({
          allowance: 0n,
          requiredAmount: 1_000_000n,
          observedAtBlock: 123n,
        }),
      ]);
      expect(result.value.executionPlan.steps[1]?.estimatedGas).toEqual({
        gas: 500_000n,
        source: 'hosted-api',
      });
    }
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(rpc.readContract).toHaveBeenCalledTimes(1);
  });

  it('omits redundant approval, supports max approval, and enforces policy none', async () => {
    const sufficientTransport = fetchSequence({ body: quoteFixture() });
    const sufficientRpc = publicClient(1_000_000n);
    const sufficient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: sufficientTransport.fetch,
      publicClientProvider: () => sufficientRpc.client,
    });
    const sufficientResult = await sufficient.getSwapQuote(quoteRequest());

    const maxTransport = fetchSequence({ body: quoteFixture() });
    const maxRpc = publicClient(0n);
    const maximum = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: maxTransport.fetch,
      publicClientProvider: () => maxRpc.client,
    });
    const maxResult = await maximum.getSwapQuote(quoteRequest({ approvalPolicy: 'max' }));

    const noneTransport = fetchSequence({ body: quoteFixture() });
    const noneRpc = publicClient(0n);
    const none = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: noneTransport.fetch,
      publicClientProvider: () => noneRpc.client,
    });
    const noneResult = await none.getSwapQuote(quoteRequest({ approvalPolicy: 'none' }));

    expect(sufficientResult.isOk()).toBe(true);
    if (sufficientResult.isOk()) expect(sufficientResult.value.executionPlan.steps).toHaveLength(1);
    expect(maxResult.isOk()).toBe(true);
    if (maxResult.isOk()) {
      const approval = maxResult.value.executionPlan.steps[0];
      if (approval === undefined) throw new Error('approval missing');
      const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
      expect(decoded.args[1]).toBe(UINT256_MAX);
    }
    expect(noneResult.isErr()).toBe(true);
    if (noneResult.isErr()) expect(noneResult.error).toBeInstanceOf(InsufficientAllowanceError);
  });

  it.each([
    ['requested amount', quoteFixture({ requestedAmount: '999999' })],
    ['execution sender', quoteFixture({ executionFrom: OTHER_WALLET })],
    ['approval sender', quoteFixture({ approvalFrom: OTHER_WALLET })],
    ['approval token chain', quoteFixture({ approvalTokenChainId: 1 })],
    ['approval transaction target', quoteFixture({ approvalTo: OTHER_SPENDER })],
    ['approval calldata', quoteFixture({ encodedSpender: OTHER_SPENDER })],
    ['bridge source chain', quoteFixture({ bridgeSourceChainId: 1 })],
  ])('rejects a quote whose %s is not bound to the request', async (_name, fixture) => {
    const transport = fetchSequence({ body: fixture });
    const rpc = publicClient(0n);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(quoteRequest());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
    expect(rpc.getBlockNumber).not.toHaveBeenCalled();
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it('rejects a public client for the wrong source chain', async () => {
    const transport = fetchSequence({ body: quoteFixture() });
    const rpc = publicClient(0n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(quoteRequest());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CONFIGURATION_ERROR');
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
});

describe('bridge completion polling', () => {
  it('polls unknown intermediate vocabulary, de-duplicates callbacks, and returns completion', async () => {
    const pending = statusFixture('future-inflight', 'future-provider-state');
    const completed = statusFixture('completed', 'delivered');
    const transport = fetchSequence({ body: pending }, { body: pending }, { body: completed });
    const onStatus = mockFn();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(quoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      onStatus,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('completed');
      expect(result.value.destinationTxHash).toBe(DESTINATION_HASH);
    }
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(transport.calls).toHaveLength(3);
  });

  it('returns terminal bridge failure as a completed observation, not an SDK exception', async () => {
    const transport = fetchSequence({ body: statusFixture('failed') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(quoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('failed');
      expect(result.value.status.bridge.error).toBe('bridge failed');
    }
  });

  it('supports cancellation during polling and bounded timeout', async () => {
    const controller = new AbortController();
    const cancelTransport = fetchSequence({ body: statusFixture('pending') });
    const cancelClient = OseroApiClient.create({ apiKey: API_KEY, fetch: cancelTransport.fetch });
    const onStatus = mockFn(() => controller.abort('stop'));
    const cancelled = await cancelClient.waitForSwapCompletion(quoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 100,
      signal: controller.signal,
      onStatus,
    });

    const timeoutTransport = fetchSequence({ body: statusFixture('pending') });
    const timeoutClient = OseroApiClient.create({ apiKey: API_KEY, fetch: timeoutTransport.fetch });
    const timedOut = await timeoutClient.waitForSwapCompletion(quoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 5,
    });

    expect(cancelled.isErr()).toBe(true);
    if (cancelled.isErr()) expect(cancelled.error.code).toBe('CANCELLED');
    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isErr()) expect(timedOut.error).toBeInstanceOf(TimeoutError);
  });

  it('returns callback failures and same-chain polling misuse as typed errors', async () => {
    const transport = fetchSequence({ body: statusFixture('pending') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const callback = await client.waitForSwapCompletion(quoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 100,
      onStatus: () => {
        throw new Error('consumer failed');
      },
    });
    const sameChainQuote: OseroApiSwapQuoteResponse = {
      ...quoteFixture(),
      bridge: { required: false, protocol: null, statusRequest: null },
    };
    const sameChain = await client.waitForSwapCompletion(sameChainQuote, SOURCE_HASH);

    expect(callback.isErr()).toBe(true);
    if (callback.isErr()) expect(callback.error.code).toBe('CONFIGURATION_ERROR');
    expect(sameChain.isErr()).toBe(true);
    if (sameChain.isErr()) expect(sameChain.error.code).toBe('VALIDATION_ERROR');
  });
});
