import {
  encodeFunctionData,
  erc20Abi as fullErc20Abi,
  formatUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import type { Mock } from 'vitest';

import {
  createExecutionHandlerFake as executionHandler,
  ensoTransferStatusFixture,
  lifiTransferStatusFixture,
  mockFn,
  zeroXRecoveryContextFixture,
  zeroXTransferStatusFixture,
  TEST_DESTINATION_TRANSACTION_HASH as DESTINATION_HASH,
  TEST_SOURCE_TRANSACTION_HASH as SOURCE_HASH,
} from './_testing.js';
import { erc20Abi } from './abis/erc20.js';
import {
  isOseroApiActionableRecovery,
  isOseroApiEnsoProviderDetails,
  isOseroApiEnsoTransferStatusProviderDetails,
  isOseroApiLifiProviderDetails,
  isOseroApiLifiTransferStatusProviderDetails,
  isOseroApiZeroXProviderDetails,
  isOseroApiZeroXStatusContext,
  isOseroApiZeroXTransferStatusProviderDetails,
  matchOseroApiAsset,
  oseroApiAmount,
  OSERO_API_KNOWN_ASSET_IDS,
  OSERO_API_KNOWN_CHAIN_IDS,
  OseroApiClient,
  prepareRecoveryExecutionPlan,
  type OseroApiFetch,
  type OseroApiInputAmount,
  type OseroApiSwapQuoteRequest,
  type OseroApiSwapQuoteResponse,
} from './api.js';
import { parseSlippage, referral, UINT256_MAX } from './domain.js';
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  ApprovalLimitError,
  BroadcastError,
  ConfigurationError,
  ProgressCallbackError,
  QuoteExpiredError,
  QuoteRefreshLimitError,
  RpcError,
  TimeoutError,
} from './errors.js';
import { errAsync } from './result.js';
import type { ExecutionPlanHandler, TransactionResult } from './types.js';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET: Address = '0x9999999999999999999999999999999999999999';
const OUTPUT_TOKEN: Address = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const SPENDER: Address = '0x2222222222222222222222222222222222222222';
const OTHER_SPENDER: Address = '0x7777777777777777777777777777777777777777';
const API_KEY = 'osero_test-key';

const ENSO_SAME_CHAIN_QUOTE = {
  provider: 'enso',
  pair: {
    source: {
      assetId: 'ethereum:usds',
      chainId: 1,
      chainKey: 'ethereum',
      chainName: 'Ethereum',
      chainShortName: 'Mainnet',
      symbol: 'USDS',
      decimals: 18,
      address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
      label: 'USDS - Mainnet',
    },
    destination: {
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
    inputAmount: { raw: '1000000000000000000', formatted: '1' },
    expectedOutput: { raw: '980000000000000000', formatted: '0.98' },
    minimumOutput: null,
    slippage: { bps: '5', percent: '0.05' },
    referralAttribution: { requestedCode: null, status: 'not-requested' },
    quotedAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:01:00.000Z',
  },
  routeSummary: {
    kind: 'same-chain',
    sourceChainId: 1,
    destinationChainId: 1,
    bridge: null,
  },
  executionPlan: {
    approvalSteps: [],
    executionStep: {
      transaction: {
        chainId: 1,
        sender: WALLET,
        recipient: OUTPUT_TOKEN,
        calldata: '0x1234',
        value: '0',
        gasLimit: '250000',
      },
    },
  },
  refreshContext: {
    provider: 'enso',
    walletAddress: WALLET,
    sourceAssetId: 'ethereum:usds',
    destinationAssetId: 'ethereum:susds',
    amount: '1000000000000000000',
    slippage: { bps: '5', percent: '0.05' },
    referralCode: null,
  },
  statusContext: null,
  providerDetails: {
    provider: 'enso',
    route: [{ protocol: 'enso', action: 'deposit' }],
    gasUnits: '250000',
    priceImpactBps: null,
    simulationBlockNumber: 22_000_000,
  },
} as const satisfies OseroApiSwapQuoteResponse;

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

function sameChainQuoteForAmount(raw: `${bigint}`): OseroApiSwapQuoteResponse {
  return {
    ...ENSO_SAME_CHAIN_QUOTE,
    quote: {
      ...ENSO_SAME_CHAIN_QUOTE.quote,
      inputAmount: { raw, formatted: formatUnits(BigInt(raw), 18) },
      slippage: { bps: '12.5', percent: '0.125' },
      referralAttribution: { requestedCode: 3001, status: 'applied' },
    },
    refreshContext: {
      ...ENSO_SAME_CHAIN_QUOTE.refreshContext,
      amount: raw,
      slippage: { bps: '12.5', percent: '0.125' },
      referralCode: 3001,
    },
  };
}

function quoteWithApproval(
  options: {
    readonly encodedSpender?: Address;
    readonly spender?: Address;
    readonly sender?: Address;
    readonly tokenChainId?: number;
    readonly recipient?: Address;
    readonly requiredAmount?: bigint;
    readonly tokenSymbol?: string;
    /** Amount encoded in calldata when it should differ from `requiredAmount`. */
    readonly encodedAmount?: bigint;
    /** Replaces the approval calldata entirely. */
    readonly calldata?: Hex;
    readonly value?: `${bigint}`;
    readonly transactionChainId?: number;
  } = {},
): OseroApiSwapQuoteResponse {
  const requiredAmount =
    options.requiredAmount ?? BigInt(ENSO_SAME_CHAIN_QUOTE.quote.inputAmount.raw);
  const approvalData =
    options.calldata ??
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [
        options.encodedSpender ?? options.spender ?? SPENDER,
        options.encodedAmount ?? requiredAmount,
      ],
    });
  return {
    ...ENSO_SAME_CHAIN_QUOTE,
    pair: {
      ...ENSO_SAME_CHAIN_QUOTE.pair,
      source: {
        ...ENSO_SAME_CHAIN_QUOTE.pair.source,
        chainId: options.tokenChainId ?? 1,
      },
    },
    executionPlan: {
      ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
      approvalSteps: [
        {
          token: {
            ...ENSO_SAME_CHAIN_QUOTE.pair.source,
            chainId: options.tokenChainId ?? 1,
            symbol: options.tokenSymbol ?? ENSO_SAME_CHAIN_QUOTE.pair.source.symbol,
          },
          spender: options.spender ?? SPENDER,
          requiredAmount: {
            raw: requiredAmount.toString() as `${bigint}`,
            formatted: formatUnits(requiredAmount, 18),
          },
          transaction: {
            chainId: options.transactionChainId ?? 1,
            sender: options.sender ?? WALLET,
            recipient: options.recipient ?? ENSO_SAME_CHAIN_QUOTE.pair.source.address,
            calldata: approvalData,
            value: options.value ?? '0',
            gasLimit: '50000',
          },
        },
      ],
    },
  };
}

const QUOTE_INPUT_RAW = BigInt(ENSO_SAME_CHAIN_QUOTE.quote.inputAmount.raw);

function canonicalApprovalCalldata(spender: Address = SPENDER, value = QUOTE_INPUT_RAW): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] });
}

/** A quote that is internally consistent for a different input amount than the caller requested. */
function quoteForOtherInputAmount(): OseroApiSwapQuoteResponse {
  return {
    ...ENSO_SAME_CHAIN_QUOTE,
    quote: {
      ...ENSO_SAME_CHAIN_QUOTE.quote,
      inputAmount: { raw: '2000000000000000000', formatted: '2' },
    },
    refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, amount: '2000000000000000000' },
  };
}

function crossChainQuoteFixture(): OseroApiSwapQuoteResponse {
  return {
    ...ENSO_SAME_CHAIN_QUOTE,
    pair: {
      ...ENSO_SAME_CHAIN_QUOTE.pair,
      source: { ...ENSO_SAME_CHAIN_QUOTE.pair.source, chainId: 8453 },
    },
    routeSummary: {
      kind: 'cross-chain',
      sourceChainId: 8453,
      destinationChainId: 1,
      bridge: 'future-bridge',
    },
    executionPlan: {
      ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
      executionStep: {
        transaction: {
          ...ENSO_SAME_CHAIN_QUOTE.executionPlan.executionStep.transaction,
          chainId: 8453,
        },
      },
    },
    statusContext: {
      provider: 'enso',
      sourceChainId: 8453,
      destinationChainId: 1,
      bridge: 'future-bridge',
    },
  };
}

function changedQuote(path: readonly string[], value: unknown): unknown {
  const quote = structuredClone(ENSO_SAME_CHAIN_QUOTE) as unknown as Record<string, unknown>;
  let record = quote;
  for (const segment of path.slice(0, -1)) {
    record = record[segment] as Record<string, unknown>;
  }
  const field = path.at(-1);
  if (field === undefined) throw new Error('test path must not be empty');
  record[field] = value;
  return quote;
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

/**
 * Models browser fetch: WebIDL maps a null/undefined receiver to the realm's
 * global object, but rejects any other receiver with a brand-check TypeError.
 */
const receiverAwareFetch: OseroApiFetch = function (this: unknown): Promise<Response> {
  if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
  return Promise.resolve(new Response(JSON.stringify({ assets: [] })));
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
  allowance: bigint | readonly bigint[],
  chainId = 8453,
): {
  readonly client: PublicClient;
  readonly getBlockNumber: Mock;
  readonly readContract: Mock;
} {
  const getBlockNumber = mockFn(async () => 123n);
  const allowances = typeof allowance === 'bigint' ? [allowance] : allowance;
  let allowanceIndex = 0;
  const readContract = mockFn(async () => {
    const value = allowances[Math.min(allowanceIndex, allowances.length - 1)];
    allowanceIndex += 1;
    if (value === undefined) throw new Error('No allowance configured');
    return value;
  });
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

  it('calls the default global fetch with a receiver browsers accept', async () => {
    vi.stubGlobal('fetch', receiverAwareFetch);

    try {
      const client = OseroApiClient.create({ apiKey: API_KEY });

      const result = await client.getSupportedAssets();

      expect(result.isOk()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls a caller-supplied fetch with a receiver browsers accept', async () => {
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: receiverAwareFetch });

    const result = await client.getSupportedAssets();

    expect(result.isOk()).toBe(true);
  });

  it('tracks the hosted asset and chain vocabulary independently of native action chains', () => {
    expect(OSERO_API_KNOWN_CHAIN_IDS).toEqual([
      1, 8453, 42161, 10, 59144, 56, 130, 137, 143, 999, 9745, 43114, 80094,
    ]);
    expect(OSERO_API_KNOWN_ASSET_IDS).toEqual(
      expect.arrayContaining([
        'ethereum:usdc',
        'base:usdc',
        'arbitrum:usdc',
        'optimism:usdc',
        'linea:usdc',
        'avalanche_c:usdc',
        'hyperevm:usdc',
        'monad:usdc',
        'polygon:usdc',
        'unichain:usdc',
        'berachain:usdce',
        'ethereum:usde',
        'arbitrum:usde',
        'base:usde',
        'optimism:usde',
        'linea:usde',
        'avalanche_c:usde',
        'bnb:usde',
        'berachain:usde',
        'hyperevm:usde',
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
        'ethereum:susds',
      ]),
    );
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
    const slippage = parseSlippage({ bps: '12.5' });
    const referralResult = referral(3001n);
    if (slippage.isErr() || referralResult.isErr()) throw new Error('test input failed');
    const transport = fetchSequence({ body: sameChainQuoteForAmount('1000000') });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: { chainId: 1, address: ENSO_SAME_CHAIN_QUOTE.pair.source.address },
        slippage: slippage.value,
        referral: referralResult.value,
      }),
    );

    expect(result.isOk()).toBe(true);
    const body = JSON.parse(String(transport.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      fromAssetId: `1:${ENSO_SAME_CHAIN_QUOTE.pair.source.address.toLowerCase()}`,
      toAssetId: 'ethereum:susds',
      amount: '1000000',
      slippage: '12.5',
      referralCode: 3001,
    });
  });

  it.each([42, 0, 65_535, 4_000, Number.MAX_SAFE_INTEGER])(
    'decodes referral code %d the API accepted without a client-side range',
    async (code) => {
      const referralResult = referral(BigInt(code));
      if (referralResult.isErr()) throw referralResult.error;
      const fixture = sameChainQuoteForAmount('1000000');
      const transport = fetchSequence({
        body: {
          ...fixture,
          quote: {
            ...fixture.quote,
            slippage: { bps: '5', percent: '0.05' },
            referralAttribution: { requestedCode: code, status: 'not-applied' },
          },
          refreshContext: {
            ...fixture.refreshContext,
            slippage: { bps: '5', percent: '0.05' },
            referralCode: code,
          },
        },
      });
      const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

      const result = await client.getSwapQuote(
        quoteRequest({ fromAssetId: 'ethereum:usds', referral: referralResult.value }),
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.quote.quote.referralAttribution.requestedCode).toBe(code);
        expect(result.value.quote.refreshContext.referralCode).toBe(code);
      }
    },
  );

  it.each([
    ['a different code than requested', 3002],
    ['a negative code', -1],
    ['a fractional code', 3001.5],
    ['a string code', '3001'],
  ])('still rejects a response referral that is %s', async (_name, code) => {
    const referralResult = referral(3001n);
    if (referralResult.isErr()) throw referralResult.error;
    const fixture = sameChainQuoteForAmount('1000000');
    const transport = fetchSequence({
      body: {
        ...fixture,
        quote: {
          ...fixture.quote,
          slippage: { bps: '5', percent: '0.05' },
          referralAttribution: { requestedCode: code, status: 'applied' },
        },
        refreshContext: {
          ...fixture.refreshContext,
          slippage: { bps: '5', percent: '0.05' },
          referralCode: code,
        },
      },
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({ fromAssetId: 'ethereum:usds', referral: referralResult.value }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
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
  it('returns an expiry-bound ready Hosted Swap Workflow for an Enso same-chain quote', async () => {
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('ready-to-execute');
      expect(result.value.quote).toEqual(ENSO_SAME_CHAIN_QUOTE);
      expect(result.value.walletExecutionPlan).toMatchObject({
        __typename: 'ExecutionPlan',
        version: 2,
        quoteExpiresAt: ENSO_SAME_CHAIN_QUOTE.quote.expiresAt,
        metadata: { source: 'hosted-api' },
      });
      expect(result.value.walletExecutionPlan.steps).toEqual([
        expect.objectContaining({
          chainId: 1,
          from: WALLET,
          to: OUTPUT_TOKEN,
          data: '0x1234',
          value: 0n,
          operation: 'SWAP_EXACT_IN',
        }),
      ]);
    }
  });

  it('prepares a wallet plan on a hosted API chain without local action capabilities', async () => {
    const baseFixture = crossChainQuoteFixture();
    const fixture: OseroApiSwapQuoteResponse = {
      ...baseFixture,
      pair: {
        ...baseFixture.pair,
        source: {
          ...baseFixture.pair.source,
          assetId: 'linea:usde',
          chainId: 59144,
          chainKey: 'linea',
          chainName: 'Linea',
          chainShortName: 'Linea',
          symbol: 'USDe',
          label: 'USDe - Linea',
        },
      },
      routeSummary: { ...baseFixture.routeSummary, sourceChainId: 59144 },
      executionPlan: {
        ...baseFixture.executionPlan,
        executionStep: {
          transaction: {
            ...baseFixture.executionPlan.executionStep.transaction,
            chainId: 59144,
          },
        },
      },
      refreshContext: {
        ...baseFixture.refreshContext,
        sourceAssetId: 'linea:usde',
      },
      statusContext: { ...baseFixture.statusContext!, sourceChainId: 59144 },
    };
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'linea:usde',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.walletExecutionPlan.steps).toEqual([
        expect.objectContaining({ chainId: 59144, operation: 'SWAP_EXACT_IN' }),
      ]);
    }
  });

  it('requires a public-client provider only when Approval Steps need checking', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(transport.calls).toHaveLength(1);
  });

  it('skips satisfied Approval Steps and exposes only final execution', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient(1_000_000_000_000_000_000n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.walletExecutionPlan.steps.map((step) => step.operation)).toEqual([
        'SWAP_EXACT_IN',
      ]);
      expect(result.value.walletExecutionPlan.metadata.allowanceSnapshots).toEqual([
        expect.objectContaining({
          allowance: 1_000_000_000_000_000_000n,
          requiredAmount: 1_000_000_000_000_000_000n,
          observedAtBlock: 123n,
        }),
      ]);
      expect(result.value.walletExecutionPlan.steps[0]?.estimatedGas).toEqual({
        gas: 250_000n,
        source: 'hosted-api',
      });
    }
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(rpc.readContract).toHaveBeenCalledTimes(1);
  });

  it('exposes only the exact API-prepared approval when the first Approval Step is insufficient', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient(0n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('approval-required');
      expect(result.value.quote.executionPlan.executionStep).toBeDefined();
      expect(result.value.walletExecutionPlan.steps).toEqual([
        {
          __typename: 'TransactionRequest',
          id: 'approval-1',
          chainId: 1,
          from: WALLET,
          to: ENSO_SAME_CHAIN_QUOTE.pair.source.address,
          data: quoteWithApproval().executionPlan.approvalSteps[0]?.transaction.calldata,
          value: 0n,
          operation: 'APPROVE_ERC20',
          authorization: {
            kind: 'erc20-approval',
            token: ENSO_SAME_CHAIN_QUOTE.pair.source.address,
            owner: WALLET,
            spender: SPENDER,
            amount: 1_000_000_000_000_000_000n,
          },
          estimatedGas: { gas: 50_000n, source: 'hosted-api' },
        },
      ]);
      expect(result.value.walletExecutionPlan.quoteExpiresAt).toBe(
        ENSO_SAME_CHAIN_QUOTE.quote.expiresAt,
      );
    }
    expect(rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ENSO_SAME_CHAIN_QUOTE.pair.source.address,
        args: [WALLET, SPENDER],
        blockNumber: 123n,
      }),
    );
  });

  it('checks multiple Approval Steps in order and withholds all steps after the first insufficient one', async () => {
    const first = quoteWithApproval().executionPlan.approvalSteps[0]!;
    const second = quoteWithApproval({ spender: OTHER_SPENDER }).executionPlan.approvalSteps[0]!;
    const laterSpender: Address = '0x8888888888888888888888888888888888888888';
    const third = quoteWithApproval({ spender: laterSpender }).executionPlan.approvalSteps[0]!;
    const fixture = {
      ...quoteWithApproval(),
      executionPlan: {
        ...quoteWithApproval().executionPlan,
        approvalSteps: [first, second, third],
      },
    };
    const transport = fetchSequence({ body: fixture });
    const rpc = publicClient([1_000_000_000_000_000_000n, 0n], 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('approval-required');
      expect(result.value.walletExecutionPlan.steps).toHaveLength(1);
      expect(result.value.walletExecutionPlan.steps[0]?.authorization?.spender).toBe(OTHER_SPENDER);
    }
    expect(rpc.readContract).toHaveBeenCalledTimes(2);
    expect(rpc.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: [WALLET, laterSpender] }),
    );
  });

  it('refreshes with the returned context unchanged and rechecks a changed spender', async () => {
    const initial = quoteWithApproval();
    const refreshed = quoteWithApproval({ spender: OTHER_SPENDER });
    const transport = fetchSequence({ body: initial }, { body: refreshed });
    const rpc = publicClient([0n, 0n], 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });
    const request = quoteRequest({
      fromAssetId: 'ethereum:usds',
      amount: amount(1_000_000_000_000_000_000n),
    });

    const first = await client.getSwapQuote(request);
    if (first.isErr()) throw first.error;
    const result = await client.refreshSwapQuote(first.value.quote.refreshContext);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('approval-required');
      expect(result.value.walletExecutionPlan.steps[0]?.authorization?.spender).toBe(OTHER_SPENDER);
    }
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toEqual(initial.refreshContext);
    expect(transport.calls[1]?.url).toBe('https://api.osero.org/v1/swap/quote/refresh');
    expect(rpc.readContract).toHaveBeenCalledTimes(2);
    expect(rpc.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: [WALLET, OTHER_SPENDER] }),
    );
  });

  it('rechecks allowance when refresh repeats an Approval Step and becomes ready once sufficient', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence(
      { body: approvalQuote },
      { body: approvalQuote },
      { body: approvalQuote },
    );
    const rpc = publicClient([0n, 0n, 1_000_000_000_000_000_000n], 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });
    const initial = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );
    if (initial.isErr()) throw initial.error;

    const repeated = await client.refreshSwapQuote(initial.value.quote.refreshContext);
    if (repeated.isErr()) throw repeated.error;
    const ready = await client.refreshSwapQuote(repeated.value.quote.refreshContext);

    expect(repeated.value.state).toBe('approval-required');
    expect(ready.isOk()).toBe(true);
    if (ready.isOk()) {
      expect(ready.value.state).toBe('ready-to-execute');
      expect(ready.value.walletExecutionPlan.steps.map((step) => step.operation)).toEqual([
        'SWAP_EXACT_IN',
      ]);
    }
    expect(rpc.readContract).toHaveBeenCalledTimes(3);
  });

  it('returns typed provider and allowance RPC failures without exposing a plan', async () => {
    const providerTransport = fetchSequence({ body: quoteWithApproval() });
    const providerFailure = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: providerTransport.fetch,
      publicClientProvider: async () => {
        throw new Error('provider unavailable');
      },
    });
    const rpcTransport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient(0n, 1);
    rpc.readContract.mockRejectedValueOnce(new Error('allowance unavailable'));
    const rpcFailure = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: rpcTransport.fetch,
      publicClientProvider: () => rpc.client,
    });
    const request = quoteRequest({
      fromAssetId: 'ethereum:usds',
      amount: amount(1_000_000_000_000_000_000n),
    });

    const failedProvider = await providerFailure.getSwapQuote(request);
    const failedRpc = await rpcFailure.getSwapQuote(request);

    expect(failedProvider.isErr()).toBe(true);
    if (failedProvider.isErr()) expect(failedProvider.error.code).toBe('CONFIGURATION_ERROR');
    expect(failedRpc.isErr()).toBe(true);
    if (failedRpc.isErr()) expect(failedRpc.error.code).toBe('RPC_REQUEST_FAILED');
  });

  it('fails closed on provider switching, malformed refresh responses, and cancellation', async () => {
    const switchedProvider = {
      ...ENSO_SAME_CHAIN_QUOTE,
      provider: 'future-provider',
      refreshContext: {
        ...ENSO_SAME_CHAIN_QUOTE.refreshContext,
        provider: 'future-provider',
      },
      providerDetails: { provider: 'future-provider' },
    };
    const switchedTransport = fetchSequence({ body: switchedProvider });
    const switchedClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: switchedTransport.fetch,
    });
    const switched = await switchedClient.refreshSwapQuote(ENSO_SAME_CHAIN_QUOTE.refreshContext);

    const malformedTransport = fetchSequence({
      body: changedQuote(['executionPlan', 'executionStep', 'transaction', 'calldata'], '0x1'),
    });
    const malformedClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: malformedTransport.fetch,
    });
    const malformed = await malformedClient.refreshSwapQuote(ENSO_SAME_CHAIN_QUOTE.refreshContext);

    const controller = new AbortController();
    const cancelledFetch = mockFn(
      async (): Promise<Response> => new Response(JSON.stringify(quoteWithApproval())),
    );
    let markAllowanceReadStarted!: () => void;
    const allowanceReadStarted = new Promise<void>((resolve) => {
      markAllowanceReadStarted = resolve;
    });
    const cancelledRpc = {
      chain: { ...base, id: 1 },
      getBlockNumber: async () => 123n,
      readContract: () => {
        markAllowanceReadStarted();
        return new Promise<bigint>(() => {});
      },
    } as unknown as PublicClient;
    const cancelledClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: cancelledFetch,
      publicClientProvider: () => cancelledRpc,
    });
    const pendingCancellation = cancelledClient.refreshSwapQuote(
      ENSO_SAME_CHAIN_QUOTE.refreshContext,
      { signal: controller.signal },
    );
    await allowanceReadStarted;
    controller.abort('stop during allowance read');
    const cancelled = await pendingCancellation;

    expect(switched.isErr()).toBe(true);
    if (switched.isErr()) expect(switched.error).toBeInstanceOf(ApiResponseError);
    expect(malformed.isErr()).toBe(true);
    if (malformed.isErr()) expect(malformed.error).toBeInstanceOf(ApiResponseError);
    expect(cancelled.isErr()).toBe(true);
    if (cancelled.isErr()) expect(cancelled.error.code).toBe('CANCELLED');
  });

  it('skips a zero-required Approval Step without configuring allowance RPC', async () => {
    const transport = fetchSequence({ body: quoteWithApproval({ requiredAmount: 0n }) });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.state).toBe('ready-to-execute');
  });

  it.each([
    ['amount is not canonical', changedQuote(['quote', 'inputAmount', 'raw'], '01')],
    ['Expected Output is zero', changedQuote(['quote', 'expectedOutput', 'raw'], '0')],
    [
      'formatted amount differs',
      changedQuote(['quote', 'expectedOutput', 'formatted'], '980000000000000000'),
    ],
    [
      'Minimum Output exceeds Expected Output',
      changedQuote(['quote', 'minimumOutput'], {
        raw: '990000000000000000',
        formatted: '0.99',
      }),
    ],
    ['slippage percent differs', changedQuote(['quote', 'slippage', 'percent'], '5')],
    ['timestamp is not UTC', changedQuote(['quote', 'quotedAt'], '2030-01-01T00:00:00+01:00')],
    [
      'timestamp rolls into another day',
      changedQuote(['quote', 'expiresAt'], '2030-02-30T00:00:00.000Z'),
    ],
    [
      'timestamp rolls into another hour',
      changedQuote(['quote', 'expiresAt'], '2030-01-01T24:00:00.000Z'),
    ],
    [
      'execution sender differs',
      changedQuote(['executionPlan', 'executionStep', 'transaction', 'sender'], OTHER_WALLET),
    ],
    ['route chain differs', changedQuote(['routeSummary', 'sourceChainId'], 8453)],
    ['asset context differs', changedQuote(['refreshContext', 'sourceAssetId'], 'future:asset')],
    [
      'calldata is not byte aligned',
      changedQuote(['executionPlan', 'executionStep', 'transaction', 'calldata'], '0x1'),
    ],
    ['provider tags differ', changedQuote(['refreshContext', 'provider'], 'lifi')],
    [
      'expiry is not after quote time',
      changedQuote(['quote', 'expiresAt'], '2029-01-01T00:00:00.000Z'),
    ],
    [
      'same-chain status is not null',
      changedQuote(['statusContext'], {
        provider: 'enso',
        sourceChainId: 1,
        destinationChainId: 1,
        bridge: 'future',
      }),
    ],
    ['approval calldata differs', quoteWithApproval({ encodedSpender: OTHER_SPENDER })],
    [
      'approval required amount exceeds quote input',
      quoteWithApproval({
        requiredAmount: BigInt(ENSO_SAME_CHAIN_QUOTE.quote.inputAmount.raw) + 1n,
      }),
    ],
    ['approval token identity differs', quoteWithApproval({ tokenSymbol: 'OTHER' })],
  ])('rejects malformed normalized quote data when %s', async (_name, fixture) => {
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });

  it.each([
    [
      'approval calldata carries one trailing byte',
      quoteWithApproval({ calldata: `${canonicalApprovalCalldata()}00` }),
      'canonical encoding of approve',
    ],
    [
      'approval calldata carries a trailing 32-byte word',
      quoteWithApproval({ calldata: `${canonicalApprovalCalldata()}${'11'.repeat(32)}` }),
      'canonical encoding of approve',
    ],
    [
      'approval calldata is truncated',
      quoteWithApproval({ calldata: canonicalApprovalCalldata().slice(0, -2) as Hex }),
      'calldata must encode ERC-20 approve',
    ],
    [
      'an approval step carries an ERC-20 transfer selector',
      quoteWithApproval({
        calldata: encodeFunctionData({
          abi: fullErc20Abi,
          functionName: 'transfer',
          args: [SPENDER, QUOTE_INPUT_RAW],
        }),
      }),
      'calldata must encode ERC-20 approve',
    ],
    [
      'approval calldata amount differs from requiredAmount for the correct spender',
      quoteWithApproval({ encodedAmount: QUOTE_INPUT_RAW - 1n }),
      'calldata must match approve(spender, requiredAmount.raw)',
    ],
    [
      'approval calldata approves an unlimited amount',
      quoteWithApproval({ encodedAmount: UINT256_MAX }),
      'calldata must match approve(spender, requiredAmount.raw)',
    ],
    [
      'approval recipient is not the approval token',
      quoteWithApproval({ recipient: OTHER_SPENDER }),
      'transaction.recipient must match the approval token',
    ],
    [
      'approval carries native value',
      quoteWithApproval({ value: '1' }),
      'transaction.value must be 0',
    ],
    [
      'approval chain differs from the source chain',
      quoteWithApproval({ transactionChainId: 8453 }),
      'transaction.chainId must match the source chain',
    ],
    [
      'approval sender differs from fromAddress',
      quoteWithApproval({ sender: OTHER_WALLET }),
      'transaction.sender must match the requested wallet',
    ],
    [
      'approval token lives on another chain than the route',
      quoteWithApproval({ tokenChainId: 8453 }),
      '$.routeSummary chains must match $.pair',
    ],
    [
      'quote input amount differs from the requested amount',
      quoteForOtherInputAmount(),
      'amounts must match the requested amount',
    ],
  ])(
    'rejects a hostile quote before any allowance read when %s',
    async (_name, fixture, reason) => {
      const transport = fetchSequence({ body: fixture });
      const rpc = publicClient(0n, 1);
      const client = OseroApiClient.create({
        apiKey: API_KEY,
        fetch: transport.fetch,
        publicClientProvider: () => rpc.client,
      });

      const result = await client.getSwapQuote(
        quoteRequest({
          fromAssetId: 'ethereum:usds',
          amount: amount(QUOTE_INPUT_RAW),
        }),
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ApiResponseError);
        expect(result.error.message).toContain(reason);
      }
      expect(rpc.getBlockNumber).not.toHaveBeenCalled();
      expect(rpc.readContract).not.toHaveBeenCalled();
    },
  );

  it('applies the same canonical-calldata check to a refreshed quote', async () => {
    const transport = fetchSequence({
      body: quoteWithApproval({ calldata: `${canonicalApprovalCalldata()}00` }),
    });
    const rpc = publicClient(0n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.refreshSwapQuote(ENSO_SAME_CHAIN_QUOTE.refreshContext);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ApiResponseError);
      expect(result.error.message).toContain('canonical encoding of approve');
    }
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it('accepts canonical approval calldata with upper-case argument hex', async () => {
    // viem matches the 4-byte selector case-sensitively, so only the arguments vary in case.
    const canonical = canonicalApprovalCalldata();
    const upper = `${canonical.slice(0, 10)}${canonical.slice(10).toUpperCase()}` as Hex;
    const transport = fetchSequence({ body: quoteWithApproval({ calldata: upper }) });
    const rpc = publicClient(0n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({ fromAssetId: 'ethereum:usds', amount: amount(QUOTE_INPUT_RAW) }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('approval-required');
      expect(result.value.walletExecutionPlan.steps[0]?.data).toBe(upper);
    }
  });

  it.each([
    ['source', { fromAssetId: 'future:source' }],
    ['destination', { toAssetId: 'future:destination' }],
  ])('rejects a response for a different requested %s asset', async (_name, override) => {
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
        ...override,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });

  it('retains valid wire address casing in the normalized quote', async () => {
    const lowercaseOutput = OUTPUT_TOKEN.toLowerCase() as Address;
    const fixture = {
      ...ENSO_SAME_CHAIN_QUOTE,
      pair: {
        ...ENSO_SAME_CHAIN_QUOTE.pair,
        destination: { ...ENSO_SAME_CHAIN_QUOTE.pair.destination, address: lowercaseOutput },
      },
      executionPlan: {
        ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
        executionStep: {
          transaction: {
            ...ENSO_SAME_CHAIN_QUOTE.executionPlan.executionStep.transaction,
            recipient: lowercaseOutput,
          },
        },
      },
    };
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.quote).toEqual(fixture);
  });

  it('rejects a public client for the wrong source chain', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient(0n, 8453);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CONFIGURATION_ERROR');
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it('narrows LI.FI Provider Details and preserves unknown provider data', async () => {
    const lifiQuote = {
      ...ENSO_SAME_CHAIN_QUOTE,
      provider: 'lifi',
      refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, provider: 'lifi' },
      providerDetails: {
        provider: 'lifi',
        routeId: 'route-1',
        usesComposer: true,
        gasCostUsd: '0.42',
        steps: [
          {
            id: 'step-1',
            type: 'swap',
            tool: 'lifi',
            executionDurationSeconds: null,
            feeCosts: [],
            gasCosts: [
              {
                type: 'SEND',
                price: '1',
                estimate: '1',
                limit: '1',
                amount: '1',
                amountUsd: null,
                token: {
                  chainId: 1,
                  address: '0x0000000000000000000000000000000000000000',
                  symbol: 'ETH',
                  decimals: 18,
                },
              },
            ],
            includedSteps: [],
          },
        ],
      },
    } as const;
    const unknownQuote = {
      ...ENSO_SAME_CHAIN_QUOTE,
      provider: 'future-provider',
      refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, provider: 'future-provider' },
      providerDetails: {
        provider: 'future-provider',
        diagnostic: { route: 42 },
      },
    } as const;
    const transport = fetchSequence({ body: lifiQuote }, { body: unknownQuote });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const request = quoteRequest({
      fromAssetId: 'ethereum:usds',
      amount: amount(1_000_000_000_000_000_000n),
    });

    const lifi = await client.getSwapQuote(request);
    const unknown = await client.getSwapQuote(request);

    expect(lifi.isOk()).toBe(true);
    if (lifi.isOk() && isOseroApiLifiProviderDetails(lifi.value.quote.providerDetails)) {
      expect(lifi.value.quote.providerDetails.usesComposer).toBe(true);
      expect(lifi.value.quote.providerDetails.steps[0]?.gasCosts[0]?.token.address).toBe(
        '0x0000000000000000000000000000000000000000',
      );
    }
    expect(unknown.isOk()).toBe(true);
    if (unknown.isOk()) {
      expect(unknown.value.quote.providerDetails).toEqual(unknownQuote.providerDetails);
    }
  });
});

describe('Hosted Swap Workflow execution', () => {
  afterEach(() => vi.useRealTimers());

  it('executes a ready initial quote and reports the final audit result', async () => {
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const wallet = executionHandler();
    const progress: string[] = [];
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        onProgress: (event) => {
          progress.push(event.type);
        },
      },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.finalQuote).toEqual(ENSO_SAME_CHAIN_QUOTE);
      expect(result.value.approvalResults).toEqual([]);
      expect(result.value.executionResult).toEqual(wallet.results[0]);
    }
    expect(wallet.calls).toHaveLength(1);
    expect(wallet.calls[0]?.steps.map((step) => step.operation)).toEqual(['SWAP_EXACT_IN']);
    expect(progress).toEqual(['quote-received', 'ready-to-execute', 'execution-confirmed']);
  });

  it('confirms one approval at a time and refreshes before using replacement actions', async () => {
    const initial = quoteWithApproval();
    const repeated = quoteWithApproval({ spender: OTHER_SPENDER });
    const transport = fetchSequence(
      { body: initial },
      { body: repeated },
      { body: ENSO_SAME_CHAIN_QUOTE },
    );
    const rpc = publicClient([0n, 0n], 1);
    const wallet = executionHandler();
    const progress: string[] = [];
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        onProgress: (event) => {
          progress.push(event.type);
        },
      },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.finalQuote).toEqual(ENSO_SAME_CHAIN_QUOTE);
      expect(result.value.approvalResults).toEqual(wallet.results.slice(0, 2));
      expect(result.value.executionResult).toEqual(wallet.results[2]);
    }
    expect(wallet.calls.map((plan) => plan.steps.map((step) => step.operation))).toEqual([
      ['APPROVE_ERC20'],
      ['APPROVE_ERC20'],
      ['SWAP_EXACT_IN'],
    ]);
    expect(wallet.calls[0]?.steps[0]?.authorization?.spender).toBe(SPENDER);
    expect(wallet.calls[1]?.steps[0]?.authorization?.spender).toBe(OTHER_SPENDER);
    expect(transport.calls.slice(1).map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      initial.refreshContext,
      repeated.refreshContext,
    ]);
    expect(progress).toEqual([
      'quote-received',
      'approval-required',
      'approval-confirmed',
      'quote-refresh',
      'quote-received',
      'approval-required',
      'approval-confirmed',
      'quote-refresh',
      'quote-received',
      'ready-to-execute',
      'execution-confirmed',
    ]);
  });

  it('refreshes an expired ready quote before submitting its execution plan', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'));
    const refreshed = {
      ...ENSO_SAME_CHAIN_QUOTE,
      quote: {
        ...ENSO_SAME_CHAIN_QUOTE.quote,
        quotedAt: '2030-01-01T00:01:00.000Z',
        expiresAt: '2030-01-01T00:02:00.000Z',
      },
      executionPlan: {
        ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
        executionStep: {
          transaction: {
            ...ENSO_SAME_CHAIN_QUOTE.executionPlan.executionStep.transaction,
            calldata: '0x5678',
          },
        },
      },
    } as const satisfies OseroApiSwapQuoteResponse;
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE }, { body: refreshed });
    const wallet = executionHandler();
    const progress: string[] = [];
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        onProgress: (event) => {
          progress.push(event.type);
        },
      },
    );

    expect(result.isOk()).toBe(true);
    expect(wallet.calls).toHaveLength(1);
    expect(wallet.calls[0]?.steps[0]?.data).toBe('0x5678');
    expect(transport.calls).toHaveLength(2);
    expect(progress).toEqual([
      'quote-received',
      'quote-refresh',
      'quote-received',
      'ready-to-execute',
      'execution-confirmed',
    ]);
  });

  it('rechecks expiry after readiness progress before calling the wallet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:59.999Z'));
    const refreshed = {
      ...ENSO_SAME_CHAIN_QUOTE,
      quote: {
        ...ENSO_SAME_CHAIN_QUOTE.quote,
        quotedAt: '2030-01-01T00:01:00.000Z',
        expiresAt: '2030-01-01T00:02:00.000Z',
      },
      executionPlan: {
        ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
        executionStep: {
          transaction: {
            ...ENSO_SAME_CHAIN_QUOTE.executionPlan.executionStep.transaction,
            calldata: '0x5678',
          },
        },
      },
    } as const satisfies OseroApiSwapQuoteResponse;
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE }, { body: refreshed });
    const wallet = executionHandler();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    let readinessCount = 0;

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        onProgress: (event) => {
          if (event.type === 'ready-to-execute' && readinessCount++ === 0) {
            vi.setSystemTime(new Date(ENSO_SAME_CHAIN_QUOTE.quote.expiresAt));
          }
        },
      },
    );

    expect(result.isOk()).toBe(true);
    expect(wallet.calls).toHaveLength(1);
    expect(wallet.calls[0]?.steps[0]?.data).toBe('0x5678');
    expect(transport.calls).toHaveLength(2);
  });

  it('refreshes when the wallet handler detects expiry before broadcast', async () => {
    const refreshed = {
      ...ENSO_SAME_CHAIN_QUOTE,
      executionPlan: {
        ...ENSO_SAME_CHAIN_QUOTE.executionPlan,
        executionStep: {
          transaction: {
            ...ENSO_SAME_CHAIN_QUOTE.executionPlan.executionStep.transaction,
            calldata: '0x5678',
          },
        },
      },
    } as const satisfies OseroApiSwapQuoteResponse;
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE }, { body: refreshed });
    const wallet = executionHandler();
    let handlerCalls = 0;
    const handler: ExecutionPlanHandler = (plan) => {
      handlerCalls += 1;
      if (handlerCalls === 1) {
        return errAsync(new QuoteExpiredError(plan, plan.quoteExpiresAt!));
      }
      return wallet.handler(plan);
    };
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      handler,
    );

    expect(result.isOk()).toBe(true);
    expect(handlerCalls).toBe(2);
    expect(wallet.calls[0]?.steps[0]?.data).toBe('0x5678');
    expect(transport.calls).toHaveLength(2);
  });

  it('stops before a fourth approval wallet call at the default approval limit', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence({ body: approvalQuote });
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ApprovalLimitError);
      if (result.error instanceof ApprovalLimitError) {
        expect(result.error.limit).toBe(3);
        expect(result.error.approvalResults).toEqual(wallet.results);
      }
    }
    expect(wallet.calls).toHaveLength(3);
    expect(transport.calls).toHaveLength(4);
  });

  it('allows exactly three approvals at the default approval limit', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence(
      { body: approvalQuote },
      { body: approvalQuote },
      { body: approvalQuote },
      { body: ENSO_SAME_CHAIN_QUOTE },
    );
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.approvalResults).toHaveLength(3);
    expect(wallet.calls).toHaveLength(4);
  });

  it('stops before a sixth Quote Refresh request at the default refresh limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ENSO_SAME_CHAIN_QUOTE.quote.expiresAt));
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const wallet = executionHandler();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(QuoteRefreshLimitError);
      if (result.error instanceof QuoteRefreshLimitError) expect(result.error.limit).toBe(5);
    }
    expect(transport.calls).toHaveLength(6);
    expect(wallet.calls).toHaveLength(0);
  });

  it('allows exactly five Quote Refreshes at the default refresh limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ENSO_SAME_CHAIN_QUOTE.quote.expiresAt));
    const ready = {
      ...ENSO_SAME_CHAIN_QUOTE,
      quote: {
        ...ENSO_SAME_CHAIN_QUOTE.quote,
        quotedAt: '2030-01-01T00:01:00.000Z',
        expiresAt: '2030-01-01T00:02:00.000Z',
      },
    } as const satisfies OseroApiSwapQuoteResponse;
    const transport = fetchSequence(
      { body: ENSO_SAME_CHAIN_QUOTE },
      { body: ENSO_SAME_CHAIN_QUOTE },
      { body: ENSO_SAME_CHAIN_QUOTE },
      { body: ENSO_SAME_CHAIN_QUOTE },
      { body: ENSO_SAME_CHAIN_QUOTE },
      { body: ready },
    );
    const wallet = executionHandler();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
    );

    expect(result.isOk()).toBe(true);
    expect(transport.calls).toHaveLength(6);
    expect(wallet.calls).toHaveLength(1);
  });

  it('accepts configured positive limits and rejects invalid limits before side effects', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence(
      { body: approvalQuote },
      { body: approvalQuote },
      { body: approvalQuote },
      { body: approvalQuote },
      { body: ENSO_SAME_CHAIN_QUOTE },
    );
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });
    const request = quoteRequest({
      fromAssetId: 'ethereum:usds',
      amount: amount(1_000_000_000_000_000_000n),
    });

    const invalidApproval = await client.executeSwap(request, wallet.handler, {
      approvalTransactionLimit: 0,
    });
    const invalidRefresh = await client.executeSwap(request, wallet.handler, {
      quoteRefreshLimit: Number.POSITIVE_INFINITY,
    });
    const result = await client.executeSwap(request, wallet.handler, {
      approvalTransactionLimit: 4,
    });

    expect(invalidApproval.isErr()).toBe(true);
    expect(invalidRefresh.isErr()).toBe(true);
    expect(result.isOk()).toBe(true);
    expect(wallet.calls).toHaveLength(5);
    expect(transport.calls).toHaveLength(5);
  });

  it('returns a typed callback failure with already confirmed approval results', async () => {
    const initial = quoteWithApproval();
    const transport = fetchSequence({ body: initial }, { body: ENSO_SAME_CHAIN_QUOTE });
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        onProgress: (event) => {
          if (event.type === 'approval-confirmed') throw new Error('progress failed');
        },
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ProgressCallbackError);
      if (result.error instanceof ProgressCallbackError) {
        expect(result.error.hostedSwap?.progressType).toBe('approval-confirmed');
        expect(result.error.hostedSwap?.approvalResults).toEqual(wallet.results);
      }
    }
    expect(wallet.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('honors cancellation between transitions without starting future work', async () => {
    const controller = new AbortController();
    const initial = quoteWithApproval();
    const transport = fetchSequence({ body: initial }, { body: ENSO_SAME_CHAIN_QUOTE });
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(
      quoteRequest({
        fromAssetId: 'ethereum:usds',
        amount: amount(1_000_000_000_000_000_000n),
      }),
      wallet.handler,
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'approval-confirmed') controller.abort('stop after confirmation');
        },
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    expect(wallet.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('preserves wallet and post-approval HTTP failures as distinguishable results', async () => {
    const readyTransport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const walletFailure = BroadcastError.from(new Error('wallet rejected'));
    const failedHandler: ExecutionPlanHandler = () => errAsync(walletFailure);
    const readyClient = OseroApiClient.create({ apiKey: API_KEY, fetch: readyTransport.fetch });
    const request = quoteRequest({
      fromAssetId: 'ethereum:usds',
      amount: amount(1_000_000_000_000_000_000n),
    });

    const failedWallet = await readyClient.executeSwap(request, failedHandler);

    const approvalTransport = fetchSequence(
      { body: quoteWithApproval() },
      { body: { code: 'UPSTREAM_UNAVAILABLE' }, status: 503 },
    );
    const rpc = publicClient(0n, 1);
    const wallet = executionHandler();
    const approvalClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: approvalTransport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const failedRefresh = await approvalClient.executeSwap(request, wallet.handler);

    expect(failedWallet.isErr()).toBe(true);
    if (failedWallet.isErr()) expect(failedWallet.error).toBe(walletFailure);
    expect(failedRefresh.isErr()).toBe(true);
    if (failedRefresh.isErr()) expect(failedRefresh.error).toBeInstanceOf(ApiRequestError);
    expect(wallet.calls).toHaveLength(1);
    expect(approvalTransport.calls).toHaveLength(2);
  });
});

/** An RPC client for mainnet built from the two calls the hosted workflow makes. */
function rpcClient(calls: {
  readonly getBlockNumber: (args?: { readonly cacheTime?: number }) => Promise<bigint>;
  readonly readContract: (args: { readonly blockNumber?: bigint }) => Promise<bigint>;
}): { readonly client: PublicClient; readonly getBlockNumber: Mock; readonly readContract: Mock } {
  const getBlockNumber = mockFn(calls.getBlockNumber);
  const readContract = mockFn(calls.readContract);
  const client = { chain: { ...base, id: 1 }, getBlockNumber, readContract };
  return { client: client as unknown as PublicClient, getBlockNumber, readContract };
}

/** The block each allowance read was pinned to, in call order. */
function allowanceBlocks(readContract: Mock): unknown[] {
  return readContract.mock.calls.map(([args]) => (args as { blockNumber?: bigint }).blockNumber);
}

/** Reports `blockNumber` as the receipt block of a single-step wallet result. */
function withReceiptBlock(result: TransactionResult, blockNumber: bigint): TransactionResult {
  const transaction = result.transactions[0]!;
  return {
    ...result,
    transactions: [{ ...transaction, confirmation: { ...transaction.confirmation, blockNumber } }],
  };
}

/** Replaces the receipt of a single-step wallet result with one that throws when read. */
function withUnreadableReceipt(result: TransactionResult): TransactionResult {
  const transaction = Object.defineProperty({ ...result.transactions[0]! }, 'confirmation', {
    enumerable: true,
    get(): never {
      throw new Error('unreadable receipt');
    },
  });
  return { ...result, transactions: [transaction] };
}

/**
 * A wallet that confirms every plan and, when `blockNumber` is given, reports it as the receipt
 * block. `onConfirm` runs once per confirmed plan, before the result is returned.
 */
function confirmingWallet(options: {
  readonly blockNumber?: bigint;
  readonly onConfirm?: () => void;
}): { readonly handler: ExecutionPlanHandler; readonly operations: () => string[][] } {
  const wallet = executionHandler();
  const handler: ExecutionPlanHandler = (plan) =>
    wallet.handler(plan).map((result) => {
      options.onConfirm?.();
      return options.blockNumber === undefined
        ? result
        : withReceiptBlock(result, options.blockNumber);
    });
  return {
    handler,
    operations: () => wallet.calls.map((plan) => plan.steps.map((step) => step.operation)),
  };
}

/** Runs the fake clock until `pending` settles, however many timers it schedules. */
async function settleOnFakeClock<Value>(pending: PromiseLike<Value>): Promise<Value> {
  const state = { settled: false };
  const done = Promise.resolve(pending).finally(() => {
    state.settled = true;
  });
  // oxlint-disable-next-line no-await-in-loop -- Each tick depends on the previous one.
  while (!state.settled) await vi.advanceTimersByTimeAsync(250);
  return done;
}

describe('allowance block selection', () => {
  const REQUIRED = 1_000_000_000_000_000_000n;
  const FRESH_HEAD = [{ cacheTime: 0 }];
  const swapRequest = () =>
    quoteRequest({ fromAssetId: 'ethereum:usds', amount: amount(REQUIRED) });

  afterEach(() => vi.useRealTimers());

  it('requests an uncached head for the initial quote and for a refresh', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence({ body: approvalQuote });
    const rpc = publicClient(REQUIRED, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const initial = await client.getSwapQuote(swapRequest());
    if (initial.isErr()) throw initial.error;
    const refreshed = await client.refreshSwapQuote(initial.value.quote.refreshContext);

    expect(refreshed.isOk()).toBe(true);
    expect(rpc.getBlockNumber.mock.calls).toEqual([FRESH_HEAD, FRESH_HEAD]);
  });

  it('sends one approval when the cached head predates the approval', async () => {
    const approvalQuote = quoteWithApproval();
    const transport = fetchSequence({ body: approvalQuote });
    const CACHED_HEAD = 100n;
    let head = CACHED_HEAD;
    let approvedAt: bigint | undefined;
    // Models viem: the head is served from a cache unless the caller opts out with cacheTime 0.
    const rpc = rpcClient({
      getBlockNumber: async (args) => (args?.cacheTime === 0 ? head : CACHED_HEAD),
      readContract: async ({ blockNumber }) =>
        approvedAt !== undefined && blockNumber !== undefined && blockNumber >= approvedAt
          ? REQUIRED
          : 0n,
    });
    // The receipt carries no block number, so only the uncached head keeps the read fresh.
    const wallet = confirmingWallet({
      onConfirm: () => {
        head += 1n;
        approvedAt ??= head;
      },
    });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(swapRequest(), wallet.handler);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.approvalResults).toHaveLength(1);
    expect(wallet.operations()).toEqual([['APPROVE_ERC20'], ['SWAP_EXACT_IN']]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([100n, 101n]);
  });

  it('never reads the allowance below the block of the confirmed approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = fetchSequence({ body: quoteWithApproval() });
    // The RPC head stays behind the approval for as long as the SDK waits.
    const rpc = rpcClient({
      getBlockNumber: async () => 150n,
      readContract: async ({ blockNumber }) =>
        blockNumber !== undefined && blockNumber >= 200n ? REQUIRED : 0n,
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(client.executeSwap(swapRequest(), wallet.handler));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.approvalResults).toHaveLength(1);
      expect(result.value.executionResult.transactions[0]?.operation).toBe('SWAP_EXACT_IN');
    }
    expect(wallet.operations()).toEqual([['APPROVE_ERC20'], ['SWAP_EXACT_IN']]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 200n]);
    expect(rpc.readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: 'allowance', blockNumber: 200n }),
    );
    // One head request for the initial quote, then one plus four bounded re-polls.
    expect(rpc.getBlockNumber.mock.calls).toEqual(Array.from({ length: 6 }, () => FRESH_HEAD));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads at the head once a lagging RPC catches up with the approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = fetchSequence({ body: quoteWithApproval() });
    const heads = [150n, 150n, 199n, 203n];
    let headIndex = 0;
    const rpc = rpcClient({
      getBlockNumber: async () => {
        const head = heads[Math.min(headIndex, heads.length - 1)]!;
        headIndex += 1;
        return head;
      },
      readContract: async ({ blockNumber }) =>
        blockNumber !== undefined && blockNumber >= 200n ? REQUIRED : 0n,
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(client.executeSwap(swapRequest(), wallet.handler));

    expect(result.isOk()).toBe(true);
    expect(wallet.operations()).toEqual([['APPROVE_ERC20'], ['SWAP_EXACT_IN']]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 203n]);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(4);
  });

  it('reads at the fresh head without waiting when the receipt has no block number', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    let head = 150n;
    const rpc = rpcClient({
      getBlockNumber: async () => head,
      readContract: async ({ blockNumber }) =>
        blockNumber !== undefined && blockNumber >= 151n ? REQUIRED : 0n,
    });
    const wallet = confirmingWallet({
      onConfirm: () => {
        head = 151n;
      },
    });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(swapRequest(), wallet.handler);

    expect(result.isOk()).toBe(true);
    expect(wallet.operations()).toEqual([['APPROVE_ERC20'], ['SWAP_EXACT_IN']]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 151n]);
    expect(rpc.getBlockNumber.mock.calls).toEqual([FRESH_HEAD, FRESH_HEAD]);
  });

  it('ignores a wallet result that reports no usable receipt block', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient([0n, REQUIRED], 1);
    const wallet = executionHandler();
    // A handler is caller code and may return less than its declared result.
    const handler: ExecutionPlanHandler = (plan) =>
      wallet.handler(plan).map(({ planId, txHash }) => ({ planId, txHash }) as never);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(swapRequest(), handler);

    expect(result.isOk()).toBe(true);
    expect(wallet.calls).toHaveLength(2);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it('continues on the fresh head when reading the receipt of a wallet result throws', async () => {
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = publicClient([0n, REQUIRED], 1);
    const wallet = executionHandler();
    const handler: ExecutionPlanHandler = (plan) =>
      wallet.handler(plan).map((result) => withUnreadableReceipt(result));
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(swapRequest(), handler);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.approvalResults).toHaveLength(1);
    expect(wallet.calls).toHaveLength(2);
    expect(rpc.getBlockNumber.mock.calls).toEqual([FRESH_HEAD, FRESH_HEAD]);
  });

  it('raises the floor to the block of each later approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = fetchSequence({ body: quoteWithApproval() });
    // The allowance is only sufficient from the block of the second approval.
    const rpc = rpcClient({
      getBlockNumber: async () => 150n,
      readContract: async ({ blockNumber }) =>
        blockNumber !== undefined && blockNumber >= 300n ? REQUIRED : 0n,
    });
    const receiptBlocks = [200n, 300n, 301n];
    const wallet = executionHandler();
    const handler: ExecutionPlanHandler = (plan) =>
      wallet
        .handler(plan)
        .map((result) => withReceiptBlock(result, receiptBlocks[wallet.calls.length - 1]!));
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(client.executeSwap(swapRequest(), handler));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.approvalResults).toHaveLength(2);
    expect(wallet.calls.map((plan) => plan.steps.map((step) => step.operation))).toEqual([
      ['APPROVE_ERC20'],
      ['APPROVE_ERC20'],
      ['SWAP_EXACT_IN'],
    ]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 200n, 300n]);
  });

  it('keeps the floor for a refresh caused by quote expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:01:00.000Z'));
    const expired = quoteWithApproval();
    const fresh = {
      ...expired,
      quote: {
        ...expired.quote,
        quotedAt: '2030-01-01T00:01:00.000Z',
        expiresAt: '2030-01-01T00:02:00.000Z',
      },
    } as OseroApiSwapQuoteResponse;
    const transport = fetchSequence({ body: expired }, { body: expired }, { body: fresh });
    const rpc = rpcClient({
      getBlockNumber: async () => 150n,
      readContract: async ({ blockNumber }) =>
        blockNumber !== undefined && blockNumber >= 200n ? REQUIRED : 0n,
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const refreshReasons: string[] = [];
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(
      client.executeSwap(swapRequest(), wallet.handler, {
        onProgress: (event) => {
          if (event.type === 'quote-refresh') refreshReasons.push(event.reason);
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(refreshReasons).toEqual(['approval-confirmed', 'quote-expired']);
    expect(wallet.operations()).toEqual([['APPROVE_ERC20'], ['SWAP_EXACT_IN']]);
    // The head never passes the approval, so both refreshes read at the receipt block.
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 200n, 200n]);
  });

  it('returns the head request failure when it fails while waiting for the approval block', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = fetchSequence({ body: quoteWithApproval() });
    let headRequests = 0;
    const rpc = rpcClient({
      getBlockNumber: async () => {
        headRequests += 1;
        if (headRequests === 3) throw new Error('head unavailable');
        return 150n;
      },
      readContract: async () => 0n,
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(client.executeSwap(swapRequest(), wallet.handler));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(RpcError);
      if (result.error instanceof RpcError) expect(result.error.operation).toBe('getBlockNumber');
    }
    expect(wallet.operations()).toEqual([['APPROVE_ERC20']]);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(rpc.readContract).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the RPC cannot serve the block of the confirmed approval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = fetchSequence({ body: quoteWithApproval() });
    const rpc = rpcClient({
      getBlockNumber: async () => 150n,
      readContract: async ({ blockNumber }) => {
        if (blockNumber === 200n) throw new Error('header not found');
        return 0n;
      },
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await settleOnFakeClock(client.executeSwap(swapRequest(), wallet.handler));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(RpcError);
      if (result.error instanceof RpcError) {
        expect(result.error.operation).toBe('readContract');
        expect(result.error.functionName).toBe('allowance');
        expect(result.error.chainId).toBe(1);
      }
    }
    // The approval is not requested again and nothing is executed.
    expect(wallet.operations()).toEqual([['APPROVE_ERC20']]);
    expect(allowanceBlocks(rpc.readContract)).toEqual([150n, 200n]);
    expect(transport.calls).toHaveLength(2);
  });

  it('cancels while waiting for a lagging RPC to reach the approval block', async () => {
    const controller = new AbortController();
    const transport = fetchSequence({ body: quoteWithApproval() });
    let headRequests = 0;
    const rpc = rpcClient({
      getBlockNumber: async () => {
        headRequests += 1;
        // The second head request is the first one after the approval; the SDK then waits
        // before asking again, and the caller aborts during that wait.
        if (headRequests === 2) setTimeout(() => controller.abort('stop waiting'), 5);
        return 150n;
      },
      readContract: async () => 0n,
    });
    const wallet = confirmingWallet({ blockNumber: 200n });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.executeSwap(swapRequest(), wallet.handler, {
      signal: controller.signal,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    expect(wallet.operations()).toEqual([['APPROVE_ERC20']]);
    expect(rpc.getBlockNumber).toHaveBeenCalledTimes(2);
    expect(rpc.readContract).toHaveBeenCalledTimes(1);
  });
});

describe('Transfer Status polling', () => {
  it('serializes the complete Status Context and decodes normalized Transfer Status', async () => {
    const fixture = lifiTransferStatusFixture();
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://contract.test/v1/',
      fetch: transport.fetch,
    });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: { ...crossChainQuoteFixture().statusContext!, provider: 'lifi' },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(fixture);
    expect(transport.calls[0]?.url).toBe(
      `https://contract.test/v1/swap/status/${SOURCE_HASH}?provider=lifi&sourceChainId=8453&destinationChainId=1&bridge=future-bridge`,
    );
  });

  it('narrows Enso Transfer Status Provider Details', async () => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('completed', 'delivered') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatusForQuote(crossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(isOseroApiEnsoTransferStatusProviderDetails(result.value.providerDetails)).toBe(true);
    if (!isOseroApiEnsoTransferStatusProviderDetails(result.value.providerDetails)) return;
    expect(result.value.providerDetails.status).toBe('delivered');
  });

  it('preserves opaque Provider Details for an unknown Quote Provider', async () => {
    const fixture = {
      ...lifiTransferStatusFixture('unknown'),
      provider: 'future-provider',
      providerDetails: {
        provider: 'future-provider',
        lifecycle: { phase: 42 },
      },
    } as const;
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: {
        provider: 'future-provider' as never,
        sourceChainId: 8453,
        destinationChainId: 1,
        bridge: 'future-bridge',
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.providerDetails).toEqual(fixture.providerDetails);
  });

  it('narrows LI.FI Transfer Status Provider Details', async () => {
    const transport = fetchSequence({ body: lifiTransferStatusFixture() });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: { ...crossChainQuoteFixture().statusContext!, provider: 'lifi' },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(isOseroApiLifiTransferStatusProviderDetails(result.value.providerDetails)).toBe(true);
  });

  it.each([
    ['provider', { provider: 'enso' }],
    ['source chain', { sourceChainId: 10 }],
    ['destination chain', { destinationChainId: 10 }],
    ['bridge', { bridge: 'another-bridge' }],
    ['source transaction hash', { sourceTransactionHash: DESTINATION_HASH }],
    ['destination transaction hash', { destinationTransactionHash: '0x12' }],
    ['normalized state', { state: '' }],
    ['non-string normalized state', { state: 7 }],
    ['error', { error: '' }],
    ['Provider Details provider', { providerDetails: { provider: 'enso', status: 'DONE' } }],
    ['LI.FI Provider Details', { providerDetails: { provider: 'lifi', status: 'DONE' } }],
  ])('rejects Transfer Status with inconsistent or malformed %s', async (_name, override) => {
    const transport = fetchSequence({ body: { ...lifiTransferStatusFixture(), ...override } });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: { ...crossChainQuoteFixture().statusContext!, provider: 'lifi' },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });

  it('reports an unrecognized normalized state as unknown and keeps polling', async () => {
    const future = { ...ensoTransferStatusFixture('pending', 'settling'), state: 'future-state' };
    const completed = ensoTransferStatusFixture('completed', 'delivered');
    const single = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: fetchSequence({ body: future }).fetch,
    });
    const transport = fetchSequence({ body: future }, { body: completed });
    const polling = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const onStatus = mockFn();

    const status = await single.getSwapStatusForQuote(crossChainQuoteFixture(), SOURCE_HASH);
    const waited = await polling.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      onStatus,
    });

    expect(status.isOk()).toBe(true);
    if (status.isOk()) expect(status.value.state).toBe('unknown');
    expect(waited.isOk()).toBe(true);
    if (waited.isOk()) expect(waited.value.state).toBe('completed');
    expect(onStatus.mock.calls.map(([value]) => (value as { state: string }).state)).toEqual([
      'unknown',
      'completed',
    ]);
    expect(transport.calls).toHaveLength(2);
  });

  it('rejects same-chain Status Context and same-chain quotes before HTTP', async () => {
    const transport = fetchSequence({ body: lifiTransferStatusFixture() });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const sameChainContext = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: {
        provider: 'lifi',
        sourceChainId: 8453,
        destinationChainId: 8453,
        bridge: 'future-bridge',
      },
    });
    const oneShot = await client.getSwapStatusForQuote(ENSO_SAME_CHAIN_QUOTE, SOURCE_HASH);
    const wait = await client.waitForSwapCompletion(ENSO_SAME_CHAIN_QUOTE, SOURCE_HASH);

    expect(sameChainContext.isErr()).toBe(true);
    expect(oneShot.isErr()).toBe(true);
    expect(wait.isErr()).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps status request failures and polling option failures typed', async () => {
    const transport = fetchSequence({ body: { code: 'UPSTREAM_UNAVAILABLE' }, status: 503 });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const requestFailed = await client.getSwapStatusForQuote(crossChainQuoteFixture(), SOURCE_HASH);
    const invalidInterval = await client.waitForSwapCompletion(
      crossChainQuoteFixture(),
      SOURCE_HASH,
      { pollingIntervalMs: 0 },
    );
    const invalidTimeout = await client.waitForSwapCompletion(
      crossChainQuoteFixture(),
      SOURCE_HASH,
      { timeoutMs: Number.POSITIVE_INFINITY },
    );

    expect(requestFailed.isErr()).toBe(true);
    if (requestFailed.isErr()) expect(requestFailed.error).toBeInstanceOf(ApiRequestError);
    expect(invalidInterval.isErr()).toBe(true);
    expect(invalidTimeout.isErr()).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });

  it('returns terminal transfer failure with diagnostics, not an SDK exception', async () => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('failed') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('failed');
      expect(result.value.error).toBe('bridge failed');
      expect(result.value.sourceTransactionHash).toBe(SOURCE_HASH);
      expect(result.value.providerDetails).toEqual({ provider: 'enso', status: 'failed' });
    }
  });

  it('bounds and cancels a pending async status callback', async () => {
    const controller = new AbortController();
    let markCallbackStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      markCallbackStarted = resolve;
    });
    const cancelClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: fetchSequence({ body: ensoTransferStatusFixture('pending') }).fetch,
    });
    const pendingCancellation = cancelClient.waitForSwapCompletion(
      crossChainQuoteFixture(),
      SOURCE_HASH,
      {
        signal: controller.signal,
        timeoutMs: 1_000,
        onStatus: () => {
          markCallbackStarted();
          return new Promise<void>(() => {});
        },
      },
    );
    await callbackStarted;
    controller.abort('stop callback');

    const cancelled = await Promise.race([
      pendingCancellation,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    const timeoutClient = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: fetchSequence({ body: ensoTransferStatusFixture('pending') }).fetch,
    });
    const timedOut = await Promise.race([
      timeoutClient.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
        timeoutMs: 5,
        onStatus: () => new Promise<void>(() => {}),
      }),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);

    expect(cancelled).not.toBe('hung');
    if (cancelled !== 'hung') {
      expect(cancelled.isErr()).toBe(true);
      if (cancelled.isErr()) expect(cancelled.error.code).toBe('CANCELLED');
    }
    expect(timedOut).not.toBe('hung');
    if (timedOut !== 'hung') {
      expect(timedOut.isErr()).toBe(true);
      if (timedOut.isErr()) expect(timedOut.error).toBeInstanceOf(TimeoutError);
    }
  });

  it('cancels status requests while an async API-key provider is pending', async () => {
    const controller = new AbortController();
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const transport = fetchSequence({ body: lifiTransferStatusFixture() });
    const client = OseroApiClient.create({
      apiKeyProvider: () => {
        markProviderStarted();
        return new Promise<string>(() => {});
      },
      fetch: transport.fetch,
    });
    const pending = client.getSwapStatusForQuote(crossChainQuoteFixture(), SOURCE_HASH, {
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort('stop key lookup');

    const result = await Promise.race([
      pending,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);

    expect(result).not.toBe('hung');
    if (result !== 'hung') {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    }
    expect(transport.calls).toHaveLength(0);
  });

  it('returns callback failures and same-chain polling misuse as typed errors', async () => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('pending') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const callback = await client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 100,
      onStatus: () => {
        throw new Error('consumer failed');
      },
    });
    const sameChain = await client.waitForSwapCompletion(ENSO_SAME_CHAIN_QUOTE, SOURCE_HASH);

    expect(callback.isErr()).toBe(true);
    if (callback.isErr()) expect(callback.error.code).toBe('CONFIGURATION_ERROR');
    expect(sameChain.isErr()).toBe(true);
    if (sameChain.isErr()) expect(sameChain.error.code).toBe('VALIDATION_ERROR');
  });
});

const ZEROX_SAME_CHAIN_QUOTE = {
  ...ENSO_SAME_CHAIN_QUOTE,
  provider: '0x',
  quote: {
    ...ENSO_SAME_CHAIN_QUOTE.quote,
    minimumOutput: { raw: '975000000000000000', formatted: '0.975' },
  },
  refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, provider: '0x' },
  providerDetails: {
    provider: '0x',
    zid: '0x111111111111111111111111',
    route: [{ type: 'fill', source: 'Uniswap_V3' }],
    fees: {
      integratorFee: null,
      zeroExFee: { amount: '2500', token: OUTPUT_TOKEN, type: 'volume' },
      bridgeNativeFee: null,
    },
    gasLimit: '250000',
    totalNetworkFee: '4500000000000000',
    estimatedTimeSeconds: null,
  },
} as const satisfies OseroApiSwapQuoteResponse;

const ZEROX_QUOTE_ID = '0x22222222222222222222222222222222';

function zeroXCrossChainQuoteFixture(): OseroApiSwapQuoteResponse {
  const crossChain = crossChainQuoteFixture();
  return {
    ...crossChain,
    provider: '0x',
    quote: ZEROX_SAME_CHAIN_QUOTE.quote,
    routeSummary: { ...crossChain.routeSummary, bridge: 'across_v4' },
    refreshContext: { ...crossChain.refreshContext, provider: '0x' },
    statusContext: {
      provider: '0x',
      sourceChainId: 8453,
      destinationChainId: 1,
      bridge: 'across_v4',
      providerQuoteId: ZEROX_QUOTE_ID,
    },
    providerDetails: {
      ...ZEROX_SAME_CHAIN_QUOTE.providerDetails,
      zid: '0x333333333333333333333333',
      route: [
        { type: 'swap', source: '0x' },
        { type: 'bridge', source: 'across_v4' },
      ],
      estimatedTimeSeconds: 30,
    },
  };
}

function zeroXQuoteRequest(): OseroApiSwapQuoteRequest {
  return quoteRequest({
    fromAssetId: 'ethereum:usds',
    amount: amount(1_000_000_000_000_000_000n),
  });
}

describe('0x quotes', () => {
  it('decodes and narrows 0x Provider Details on a same-chain quote', async () => {
    const transport = fetchSequence({ body: ZEROX_SAME_CHAIN_QUOTE });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(zeroXQuoteRequest());

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.state).toBe('ready-to-execute');
    expect(result.value.quote).toEqual(ZEROX_SAME_CHAIN_QUOTE);
    expect(isOseroApiEnsoProviderDetails(result.value.quote.providerDetails)).toBe(false);
    expect(isOseroApiZeroXProviderDetails(result.value.quote.providerDetails)).toBe(true);
    if (!isOseroApiZeroXProviderDetails(result.value.quote.providerDetails)) return;
    const details = result.value.quote.providerDetails;
    expect(details.zid).toBe('0x111111111111111111111111');
    expect(details.route).toEqual([{ type: 'fill', source: 'Uniswap_V3' }]);
    expect(details.fees.zeroExFee).toEqual({
      amount: '2500',
      token: OUTPUT_TOKEN,
      type: 'volume',
    });
    expect(details.fees.integratorFee).toBeNull();
    expect(details.fees.bridgeNativeFee).toBeNull();
    expect(details.totalNetworkFee).toBe('4500000000000000');
  });

  it('exposes an Integrator Fee without restating it in Expected Output', async () => {
    const fixture: OseroApiSwapQuoteResponse = {
      ...ZEROX_SAME_CHAIN_QUOTE,
      providerDetails: {
        ...ZEROX_SAME_CHAIN_QUOTE.providerDetails,
        fees: {
          ...ZEROX_SAME_CHAIN_QUOTE.providerDetails.fees,
          integratorFee: { amount: '2500', token: OUTPUT_TOKEN, type: 'volume' },
        },
      },
    };
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(zeroXQuoteRequest());

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // The API ranks the net Expected Output, so it is reported unchanged.
    expect(result.value.quote.quote.expectedOutput).toEqual(
      ZEROX_SAME_CHAIN_QUOTE.quote.expectedOutput,
    );
    if (!isOseroApiZeroXProviderDetails(result.value.quote.providerDetails)) return;
    expect(result.value.quote.providerDetails.fees.integratorFee).toEqual({
      amount: '2500',
      token: OUTPUT_TOKEN,
      type: 'volume',
    });
  });

  it('carries the Provider Quote ID on a 0x cross-chain Status Context', async () => {
    const fixture = zeroXCrossChainQuoteFixture();
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(zeroXQuoteRequest());

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const statusContext = result.value.quote.statusContext;
    expect(statusContext).not.toBeNull();
    expect(isOseroApiZeroXStatusContext(statusContext!)).toBe(true);
    if (!isOseroApiZeroXStatusContext(statusContext!)) return;
    expect(statusContext.providerQuoteId).toBe(ZEROX_QUOTE_ID);
    expect(statusContext.bridge).toBe('across_v4');
  });

  it.each([
    [
      'a missing Provider Quote ID',
      {
        statusContext: {
          provider: '0x',
          sourceChainId: 8453,
          destinationChainId: 1,
          bridge: 'across_v4',
        },
      },
    ],
    [
      'an empty Provider Quote ID',
      {
        statusContext: {
          provider: '0x',
          sourceChainId: 8453,
          destinationChainId: 1,
          bridge: 'across_v4',
          providerQuoteId: '',
        },
      },
    ],
  ])('rejects a 0x cross-chain quote with %s', async (_name, override) => {
    const transport = fetchSequence({ body: { ...zeroXCrossChainQuoteFixture(), ...override } });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(zeroXQuoteRequest());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });

  it.each([
    ['zid', { zid: '' }],
    ['route entry', { route: [{ type: 'fill' }] }],
    ['fees', { fees: { integratorFee: null, zeroExFee: null } }],
    [
      'fee amount',
      {
        fees: {
          integratorFee: null,
          zeroExFee: { amount: '-1', token: OUTPUT_TOKEN, type: 'volume' },
          bridgeNativeFee: null,
        },
      },
    ],
    [
      'fee token',
      {
        fees: {
          integratorFee: null,
          zeroExFee: { amount: '1', token: 'not-an-address', type: 'volume' },
          bridgeNativeFee: null,
        },
      },
    ],
    ['total network fee', { totalNetworkFee: '0x10' }],
    ['estimated time', { estimatedTimeSeconds: -1 }],
  ])('rejects malformed 0x Provider Details %s', async (_name, override) => {
    const transport = fetchSequence({
      body: {
        ...ZEROX_SAME_CHAIN_QUOTE,
        providerDetails: { ...ZEROX_SAME_CHAIN_QUOTE.providerDetails, ...override },
      },
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(zeroXQuoteRequest());

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });
});

describe('0x Transfer Status and recovery', () => {
  it('serializes the Provider Quote ID into the status query', async () => {
    const fixture = zeroXTransferStatusFixture();
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://contract.test/v1/',
      fetch: transport.fetch,
    });

    const result = await client.getSwapStatusForQuote(zeroXCrossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(fixture);
    expect(transport.calls[0]?.url).toBe(
      `https://contract.test/v1/swap/status/${SOURCE_HASH}?provider=0x&sourceChainId=8453` +
        `&destinationChainId=1&bridge=across_v4&providerQuoteId=${ZEROX_QUOTE_ID}`,
    );
  });

  it('refuses to poll a 0x Status Context that lost its Provider Quote ID', async () => {
    const transport = fetchSequence({ body: zeroXTransferStatusFixture() });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: {
        provider: '0x',
        sourceChainId: 8453,
        destinationChainId: 1,
        bridge: 'across_v4',
      } as never,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(transport.calls).toHaveLength(0);
  });

  it('echoes Status Context fields an unknown provider adds', async () => {
    const fixture = {
      ...lifiTransferStatusFixture('unknown'),
      provider: 'future-provider',
      providerDetails: { provider: 'future-provider', lifecycle: 'phase-2' },
    } as const;
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://contract.test/v1/',
      fetch: transport.fetch,
    });

    const result = await client.getSwapStatus({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: {
        provider: 'future-provider',
        sourceChainId: 8453,
        destinationChainId: 1,
        bridge: 'future-bridge',
        settlementEpoch: 7,
      } as never,
    });

    expect(result.isOk()).toBe(true);
    expect(transport.calls[0]?.url).toContain('settlementEpoch=7');
  });

  it('narrows 0x Transfer Status Provider Details and normalized Recovery Context', async () => {
    const fixture = zeroXTransferStatusFixture('failed', zeroXRecoveryContextFixture());
    const transport = fetchSequence({ body: fixture });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatusForQuote(zeroXCrossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(isOseroApiZeroXTransferStatusProviderDetails(result.value.providerDetails)).toBe(true);
    if (!isOseroApiZeroXTransferStatusProviderDetails(result.value.providerDetails)) return;
    expect(result.value.providerDetails.failureReason).toBe('internal');
    expect(result.value.providerDetails.recoveryStatus).toBe('manual_action_required');
    expect(result.value.recoveryContext).toEqual(zeroXRecoveryContextFixture());
  });

  it.each([
    ['recovery state', { state: 'in-progress' }],
    ['recovery reason', { reason: 'exploded' }],
    ['recovery chain', { chainId: 0 }],
    ['recovery token', { tokenAddress: '0x0000000000000000000000000000000000000000' }],
    ['recovery amount', { amount: '1.5' }],
    ['recovery deadline', { deadline: 'tomorrow' }],
    [
      'a sender on the Recovery Transaction',
      {
        action: {
          transaction: {
            chainId: 8453,
            sender: WALLET,
            recipient: OTHER_SPENDER,
            calldata: '0x9abc',
            value: '0',
            gasLimit: null,
          },
        },
      },
    ],
    [
      'Recovery Transaction calldata',
      {
        action: {
          transaction: {
            chainId: 8453,
            recipient: OTHER_SPENDER,
            calldata: '0x9',
            value: '0',
            gasLimit: null,
          },
        },
      },
    ],
  ])('rejects malformed %s', async (_name, override) => {
    const transport = fetchSequence({
      body: zeroXTransferStatusFixture('failed', {
        ...zeroXRecoveryContextFixture(),
        ...override,
      } as never),
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatusForQuote(zeroXCrossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ApiResponseError);
  });

  it('returns a failed transfer so the caller can inspect its Recovery Context', async () => {
    const failed = zeroXTransferStatusFixture('failed', zeroXRecoveryContextFixture());
    const transport = fetchSequence(
      { body: zeroXTransferStatusFixture('pending') },
      { body: failed },
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(zeroXCrossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('failed');
      expect(result.value.recoveryContext?.state).toBe('action-required');
    }
    expect(transport.calls).toHaveLength(2);
  });

  it('keeps polling a failed transfer while automatic recovery is pending', async () => {
    const recovering = zeroXTransferStatusFixture(
      'failed',
      zeroXRecoveryContextFixture({ state: 'pending', action: null, deadline: null }),
    );
    const recovered = zeroXTransferStatusFixture(
      'failed',
      zeroXRecoveryContextFixture({
        state: 'completed',
        action: null,
        deadline: null,
        settledAmount: '997500',
      }),
    );
    const transport = fetchSequence(
      { body: recovering },
      { body: recovering },
      { body: recovered },
    );
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(zeroXCrossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      waitForRecovery: true,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.recoveryContext?.state).toBe('completed');
      expect(result.value.recoveryContext?.settledAmount).toBe('997500');
    }
    expect(transport.calls).toHaveLength(3);
  });

  it('prepares a sender-free Recovery Action for any submitter', () => {
    const status = zeroXTransferStatusFixture('failed', zeroXRecoveryContextFixture());

    const plan = prepareRecoveryExecutionPlan(status, OTHER_WALLET);

    expect(plan.isOk()).toBe(true);
    if (!plan.isOk()) return;
    expect(plan.value).toMatchObject({
      version: 2,
      // The deadline becomes plan expiry so adapters refuse a closed window.
      quoteExpiresAt: '2030-01-02T00:00:00.000Z',
      metadata: { source: 'hosted-api' },
    });
    expect(plan.value.steps).toEqual([
      expect.objectContaining({
        chainId: 8453,
        from: OTHER_WALLET,
        to: '0x0000000000000000000000000000000000000004',
        data: '0x9abc',
        value: 0n,
        operation: 'RECOVER_CROSS_CHAIN_TRANSFER',
        estimatedGas: { gas: 200_000n, source: 'hosted-api' },
      }),
    ]);
  });

  it('omits plan expiry when a Recovery Action has no deadline', () => {
    const status = zeroXTransferStatusFixture(
      'failed',
      zeroXRecoveryContextFixture({ deadline: null }),
    );

    const plan = prepareRecoveryExecutionPlan(status, WALLET);

    expect(plan.isOk()).toBe(true);
    if (plan.isOk()) expect(plan.value.version).toBe(1);
  });

  it.each([
    ['no Recovery Context', zeroXTransferStatusFixture('failed'), WALLET],
    [
      'no Recovery Action',
      zeroXTransferStatusFixture(
        'failed',
        zeroXRecoveryContextFixture({ state: 'unavailable', action: null }),
      ),
      WALLET,
    ],
    [
      'an invalid submitter',
      zeroXTransferStatusFixture('failed', zeroXRecoveryContextFixture()),
      'not-an-address' as Address,
    ],
  ])('refuses to prepare recovery with %s', (_name, status, submitter) => {
    const plan = prepareRecoveryExecutionPlan(status, submitter);

    expect(plan.isErr()).toBe(true);
    if (plan.isErr()) expect(plan.error.code).toBe('VALIDATION_ERROR');
  });

  // A stale or malformed response can pair a non-actionable state with calldata.
  // Submitting it would broadcast a transaction the API did not authorize.
  it.each([
    ['pending', 'pending'],
    ['completed', 'completed'],
    ['not-required', 'not-required'],
    ['unavailable', 'unavailable'],
  ] as const)('refuses to submit a %s recovery that still carries an action', (_name, state) => {
    const status = zeroXTransferStatusFixture('failed', zeroXRecoveryContextFixture({ state }));

    expect(isOseroApiActionableRecovery(status.recoveryContext)).toBe(false);
    const plan = prepareRecoveryExecutionPlan(status, WALLET);

    expect(plan.isErr()).toBe(true);
    if (plan.isErr()) {
      expect(plan.error.code).toBe('VALIDATION_ERROR');
      expect(plan.error.message).toContain('not action-required');
    }
  });

  it.each([
    ['pending', 'pending'],
    ['completed', 'completed'],
    ['unknown', 'unknown'],
  ] as const)(
    'refuses to recover a transfer whose state is %s rather than failed',
    (_name, state) => {
      const status = zeroXTransferStatusFixture(state, zeroXRecoveryContextFixture());

      const plan = prepareRecoveryExecutionPlan(status, WALLET);

      expect(plan.isErr()).toBe(true);
      if (plan.isErr()) {
        expect(plan.error.code).toBe('VALIDATION_ERROR');
        expect(plan.error.message).toContain('only a failed transfer');
      }
    },
  );

  it.each([
    ['pending', 'pending'],
    ['completed', 'completed'],
    ['action-required', 'action-required'],
    ['not-required', 'not-required'],
    ['unavailable', 'unavailable'],
  ] as const)('decodes the %s Recovery Context state', async (_name, state) => {
    const recoveryContext = zeroXRecoveryContextFixture({
      state,
      ...(state === 'action-required' ? {} : { action: null, deadline: null }),
      ...(state === 'completed' ? { settledAmount: '997500' as const } : {}),
    });
    const transport = fetchSequence({
      body: zeroXTransferStatusFixture('failed', recoveryContext),
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatusForQuote(zeroXCrossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.recoveryContext).toEqual(recoveryContext);
    // Only action-required authorizes a wallet transaction.
    expect(isOseroApiActionableRecovery(result.value.recoveryContext)).toBe(
      state === 'action-required',
    );
  });

  it.each([
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
    ['out-of-gas', 'out-of-gas'],
    ['provider-failure', 'provider-failure'],
    ['unknown', 'unknown'],
  ] as const)('decodes the %s Recovery Context reason', async (_name, reason) => {
    const recoveryContext = zeroXRecoveryContextFixture({ reason });
    const transport = fetchSequence({
      body: zeroXTransferStatusFixture('failed', recoveryContext),
    });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapStatusForQuote(zeroXCrossChainQuoteFixture(), SOURCE_HASH);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.recoveryContext?.reason).toBe(reason);
  });
});

/** A fetch that stays in flight until its request signal aborts, like a real transport. */
function hangingFetch(): {
  readonly fetch: OseroApiFetch;
  readonly started: Promise<void>;
  readonly signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetch: OseroApiFetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal !== undefined) {
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      }
      markStarted();
    });
  return { fetch, started, signals };
}

describe('hosted transport failures', () => {
  it('maps a network failure to ApiTransportError with the request context', async () => {
    const cause = new TypeError('fetch failed');
    const fetch = mockFn(async (): Promise<Response> => {
      throw cause;
    });
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://contract.test/v1/',
      fetch,
    });

    const assets = await client.getSupportedAssets();
    const quote = await client.getSwapQuote(quoteRequest());

    for (const [result, method, url] of [
      [assets, 'GET', 'https://contract.test/v1/swap/assets'],
      [quote, 'POST', 'https://contract.test/v1/swap/quote'],
    ] as const) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ApiTransportError);
        expect(result.error.code).toBe('API_TRANSPORT_FAILED');
        expect(result.error.cause).toBe(cause);
        if (result.error instanceof ApiTransportError) {
          expect(result.error.method).toBe(method);
          expect(result.error.url).toBe(url);
        }
      }
    }
    // A transport failure is never retried implicitly.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps a failure while reading the response body to ApiTransportError', async () => {
    const cause = new Error('socket closed');
    const fetch: OseroApiFetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.reject(cause),
      }) as unknown as Response;
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const result = await client.getSupportedAssets();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ApiTransportError);
      expect(result.error.cause).toBe(cause);
    }
  });

  it('maps an abort while the fetch is in flight to CancelError', async () => {
    const controller = new AbortController();
    const transport = hangingFetch();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.getSwapQuote(quoteRequest(), { signal: controller.signal });
    await transport.started;
    controller.abort('user navigated away');
    const result = await pending;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('CANCELLED');
      expect(result.error).not.toBeInstanceOf(ApiTransportError);
    }
    expect(transport.signals).toHaveLength(1);
    expect(transport.signals[0]?.aborted).toBe(true);
  });
});

function quoteWithExecutionGas(gasLimit: string | null): OseroApiSwapQuoteResponse {
  return changedQuote(
    ['executionPlan', 'executionStep', 'transaction', 'gasLimit'],
    gasLimit,
  ) as OseroApiSwapQuoteResponse;
}

function quoteWithApprovalGas(gasLimit: string | null): OseroApiSwapQuoteResponse {
  const quote = structuredClone(quoteWithApproval()) as unknown as {
    executionPlan: { approvalSteps: { transaction: { gasLimit: string | null } }[] };
  };
  quote.executionPlan.approvalSteps[0]!.transaction.gasLimit = gasLimit;
  return quote as unknown as OseroApiSwapQuoteResponse;
}

const gasQuoteRequest = () =>
  quoteRequest({ fromAssetId: 'ethereum:usds', amount: amount(QUOTE_INPUT_RAW) });

describe('advisory gas from hosted quotes', () => {
  it.each([
    ['null', null],
    ['"0"', '0'],
  ])('attaches no estimatedGas to the execution step when gasLimit is %s', async (_name, gas) => {
    const transport = fetchSequence({ body: quoteWithExecutionGas(gas) });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.getSwapQuote(gasQuoteRequest());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const step = result.value.walletExecutionPlan.steps[0]!;
      expect(step.estimatedGas).toBeUndefined();
      expect('estimatedGas' in step).toBe(false);
      // The API Execution Plan keeps what the API said.
      expect(result.value.quote.executionPlan.executionStep.transaction.gasLimit).toBe(gas);
    }
  });

  it.each([
    ['null', null],
    ['"0"', '0'],
  ])('attaches no estimatedGas to the approval step when gasLimit is %s', async (_name, gas) => {
    const transport = fetchSequence({ body: quoteWithApprovalGas(gas) });
    const rpc = publicClient(0n, 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });

    const result = await client.getSwapQuote(gasQuoteRequest());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('approval-required');
      const step = result.value.walletExecutionPlan.steps[0]!;
      expect(step.operation).toBe('APPROVE_ERC20');
      expect('estimatedGas' in step).toBe(false);
    }
  });

  it('carries a positive gasLimit as advisory hosted-api metadata without changing identity', async () => {
    const withGas = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: fetchSequence({ body: quoteWithExecutionGas('250000') }).fetch,
    });
    const withoutGas = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: fetchSequence({ body: quoteWithExecutionGas(null) }).fetch,
    });

    const estimated = await withGas.getSwapQuote(gasQuoteRequest());
    const bare = await withoutGas.getSwapQuote(gasQuoteRequest());

    expect(estimated.isOk()).toBe(true);
    expect(bare.isOk()).toBe(true);
    if (estimated.isOk() && bare.isOk()) {
      expect(estimated.value.walletExecutionPlan.steps[0]?.estimatedGas).toEqual({
        gas: 250_000n,
        source: 'hosted-api',
      });
      // Advisory gas is metadata: it is not part of what the wallet signs or of the plan id.
      expect(estimated.value.walletExecutionPlan.id).toBe(bare.value.walletExecutionPlan.id);
    }
  });
});

describe('Transfer Status polling on a fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('polls once per interval through every transition until completion', async () => {
    const transport = fetchSequence(
      { body: ensoTransferStatusFixture('pending', 'submitted') },
      { body: ensoTransferStatusFixture('pending', 'submitted') },
      { body: ensoTransferStatusFixture('pending', 'bridging') },
      { body: ensoTransferStatusFixture('unknown', 'future-provider-state') },
      { body: ensoTransferStatusFixture('completed', 'delivered') },
    );
    const seen: string[] = [];
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 5_000,
      timeoutMs: 60_000,
      onStatus: (status) => {
        const details = status.providerDetails as { readonly status?: string };
        seen.push(`${status.state}:${details.status}`);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(transport.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.state).toBe('completed');
    expect(transport.calls).toHaveLength(5);
    // An unchanged status is not reported twice.
    expect(seen).toEqual([
      'pending:submitted',
      'pending:bridging',
      'unknown:future-provider-state',
      'completed:delivered',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out at the deadline without an extra request', async () => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('pending') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 5_000,
      timeoutMs: 12_000,
    });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(transport.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TimeoutError);
      if (result.error instanceof TimeoutError) {
        expect(result.error.operation).toBe('waitForSwapCompletion');
        expect(result.error.timeoutMs).toBe(12_000);
      }
    }
    expect(transport.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately when aborted during the sleep between polls', async () => {
    const controller = new AbortController();
    const transport = fetchSequence({ body: ensoTransferStatusFixture('pending') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 5_000,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.calls).toHaveLength(1);
    controller.abort('stop during sleep');
    const result = await pending;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    // The pending sleep timer is cleared and no further poll is ever issued.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.calls).toHaveLength(1);
  });

  it('cancels the in-flight status request when aborted mid-fetch', async () => {
    const controller = new AbortController();
    const transport = hangingFetch();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 5_000,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    await transport.started;
    controller.abort('stop during fetch');
    const result = await pending;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('CANCELLED');
    expect(transport.signals).toHaveLength(1);
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out and aborts a status request that never answers', async () => {
    const transport = hangingFetch();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const pending = client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 5_000,
      timeoutMs: 8_000,
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(transport.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(TimeoutError);
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const CANONICAL_REFRESH_BODY =
  '{"provider":"enso","walletAddress":"0x1111111111111111111111111111111111111111",' +
  '"sourceAssetId":"ethereum:usds","destinationAssetId":"ethereum:susds",' +
  '"amount":"1000000000000000000","slippage":{"bps":"5","percent":"0.05"},"referralCode":null}';

describe('Refresh Context forward compatibility', () => {
  it('sends a Refresh Context without extra fields byte-for-byte as before', async () => {
    const transport = fetchSequence({ body: ENSO_SAME_CHAIN_QUOTE });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const first = await client.getSwapQuote(gasQuoteRequest());
    if (first.isErr()) throw first.error;

    await client.refreshSwapQuote(first.value.quote.refreshContext);

    expect(Object.keys(first.value.quote.refreshContext)).toEqual([
      'provider',
      'walletAddress',
      'sourceAssetId',
      'destinationAssetId',
      'amount',
      'slippage',
      'referralCode',
    ]);
    expect(transport.calls[1]?.init?.body).toBe(CANONICAL_REFRESH_BODY);
  });

  it('normalizes field order regardless of the order the API used', async () => {
    const context = ENSO_SAME_CHAIN_QUOTE.refreshContext;
    const shuffled = {
      ...ENSO_SAME_CHAIN_QUOTE,
      refreshContext: {
        referralCode: context.referralCode,
        slippage: context.slippage,
        amount: context.amount,
        destinationAssetId: context.destinationAssetId,
        sourceAssetId: context.sourceAssetId,
        walletAddress: context.walletAddress,
        provider: context.provider,
      },
    };
    const transport = fetchSequence({ body: shuffled }, { body: ENSO_SAME_CHAIN_QUOTE });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const first = await client.getSwapQuote(gasQuoteRequest());
    if (first.isErr()) throw first.error;

    await client.refreshSwapQuote(first.value.quote.refreshContext);

    expect(transport.calls[1]?.init?.body).toBe(CANONICAL_REFRESH_BODY);
  });

  it('preserves unknown primitive fields and echoes them unchanged on refresh', async () => {
    const withExtras = {
      ...ENSO_SAME_CHAIN_QUOTE,
      refreshContext: {
        signature: 'sig-abc',
        ...ENSO_SAME_CHAIN_QUOTE.refreshContext,
        issuedAt: 1_700_000_000,
        sticky: true,
        nested: { ignored: true },
        list: ['ignored'],
        nothing: null,
      },
    };
    const transport = fetchSequence({ body: withExtras });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });
    const first = await client.getSwapQuote(gasQuoteRequest());
    if (first.isErr()) throw first.error;

    const refreshed = await client.refreshSwapQuote(first.value.quote.refreshContext);

    expect(refreshed.isOk()).toBe(true);
    expect(first.value.quote.refreshContext).toEqual({
      ...ENSO_SAME_CHAIN_QUOTE.refreshContext,
      signature: 'sig-abc',
      issuedAt: 1_700_000_000,
      sticky: true,
    });
    // Known fields first in their fixed order, then the extra primitives as the API sent them.
    expect(transport.calls[1]?.init?.body).toBe(
      `${CANONICAL_REFRESH_BODY.slice(0, -1)},"signature":"sig-abc","issuedAt":1700000000,"sticky":true}`,
    );
  });

  it('echoes extra fields through the automatic executeSwap refresh', async () => {
    const token = 'server-session-token';
    const approval = {
      ...quoteWithApproval(),
      refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, session: token },
    };
    const ready = {
      ...ENSO_SAME_CHAIN_QUOTE,
      refreshContext: { ...ENSO_SAME_CHAIN_QUOTE.refreshContext, session: token },
    };
    const transport = fetchSequence({ body: approval }, { body: ready });
    const rpc = publicClient([0n, QUOTE_INPUT_RAW], 1);
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      fetch: transport.fetch,
      publicClientProvider: () => rpc.client,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:10.000Z'));
    try {
      const result = await client.executeSwap(gasQuoteRequest(), executionHandler().handler);

      expect(result.isOk()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls[1]?.url).toBe('https://api.osero.org/v1/swap/quote/refresh');
    expect(JSON.parse(String(transport.calls[1]?.init?.body))).toMatchObject({ session: token });
  });

  it('never lets an extra field shadow a known field', async () => {
    const hostile = JSON.stringify(ENSO_SAME_CHAIN_QUOTE).replace(
      '"refreshContext":{',
      '"refreshContext":{"__proto__":{"amount":"1"},"constructor":"x",',
    );
    const fetch: OseroApiFetch = async () => new Response(hostile);
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch });

    const first = await client.getSwapQuote(gasQuoteRequest());

    expect(first.isOk()).toBe(true);
    if (first.isOk()) {
      expect(first.value.quote.refreshContext.amount).toBe('1000000000000000000');
      expect(JSON.parse(JSON.stringify(first.value.quote.refreshContext))).toEqual({
        ...ENSO_SAME_CHAIN_QUOTE.refreshContext,
        constructor: 'x',
      });
    }
  });
});

describe('waiting on a persisted status request', () => {
  it('resumes polling after a restart from the persisted request alone', async () => {
    // Process one: execute the swap and persist only the status request.
    const quote = zeroXCrossChainQuoteFixture();
    const persisted = JSON.stringify({
      sourceTransactionHash: SOURCE_HASH,
      statusContext: quote.statusContext,
    });

    // Process two: a new client, no quote in memory.
    const transport = fetchSequence(
      { body: zeroXTransferStatusFixture('pending') },
      { body: zeroXTransferStatusFixture('completed') },
    );
    const client = OseroApiClient.create({
      apiKey: API_KEY,
      baseUrl: 'https://contract.test/v1/',
      fetch: transport.fetch,
    });
    const onStatus = mockFn();

    const result = await client.waitForTransferStatus(JSON.parse(persisted), {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      onStatus,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('completed');
      expect(result.value.destinationTransactionHash).toBe(DESTINATION_HASH);
    }
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.url).toBe(
      `https://contract.test/v1/swap/status/${SOURCE_HASH}?provider=0x&sourceChainId=8453&destinationChainId=1&bridge=across_v4&providerQuoteId=${ZEROX_QUOTE_ID}`,
    );
  });

  it('issues exactly the requests waitForSwapCompletion issues for the same quote', async () => {
    const quote = crossChainQuoteFixture();
    const byQuote = fetchSequence(
      { body: ensoTransferStatusFixture('pending') },
      { body: ensoTransferStatusFixture('completed') },
    );
    const byRequest = fetchSequence(
      { body: ensoTransferStatusFixture('pending') },
      { body: ensoTransferStatusFixture('completed') },
    );
    const options = { pollingIntervalMs: 1, timeoutMs: 1_000 } as const;

    const fromQuote = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: byQuote.fetch,
    }).waitForSwapCompletion(quote, SOURCE_HASH, options);
    const fromRequest = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: byRequest.fetch,
    }).waitForTransferStatus(
      { sourceTransactionHash: SOURCE_HASH, statusContext: quote.statusContext! },
      options,
    );

    expect(fromRequest).toEqual(fromQuote);
    expect(byRequest.calls.map((call) => call.url)).toEqual(byQuote.calls.map((call) => call.url));
    expect(byRequest.calls.map((call) => call.init?.method)).toEqual(
      byQuote.calls.map((call) => call.init?.method),
    );
  });

  it('shares waitForRecovery, timeout, and cancellation semantics', async () => {
    const statusRequest = {
      sourceTransactionHash: SOURCE_HASH,
      statusContext: zeroXCrossChainQuoteFixture().statusContext!,
    };
    const pendingRecovery = zeroXRecoveryContextFixture({
      state: 'pending',
      action: null,
      deadline: null,
    });
    const settledRecovery = zeroXRecoveryContextFixture({
      state: 'completed',
      action: null,
      deadline: null,
      settledAmount: '997500',
    });
    const recovering = fetchSequence(
      { body: zeroXTransferStatusFixture('failed', pendingRecovery) },
      { body: zeroXTransferStatusFixture('failed', settledRecovery) },
    );
    const firstFailure = fetchSequence({
      body: zeroXTransferStatusFixture('failed', pendingRecovery),
    });
    const neverDone = fetchSequence({ body: zeroXTransferStatusFixture('pending') });
    const controller = new AbortController();
    controller.abort('stop');

    const waited = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: recovering.fetch,
    }).waitForTransferStatus(statusRequest, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      waitForRecovery: true,
    });
    const immediate = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: firstFailure.fetch,
    }).waitForTransferStatus(statusRequest, { pollingIntervalMs: 1, timeoutMs: 1_000 });
    const timedOut = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: neverDone.fetch,
    }).waitForTransferStatus(statusRequest, { pollingIntervalMs: 1, timeoutMs: 5 });
    const cancelled = await OseroApiClient.create({
      apiKey: API_KEY,
      fetch: neverDone.fetch,
    }).waitForTransferStatus(statusRequest, { signal: controller.signal });

    expect(waited.isOk() && waited.value.recoveryContext?.state).toBe('completed');
    expect(recovering.calls).toHaveLength(2);
    expect(immediate.isOk() && immediate.value.recoveryContext?.state).toBe('pending');
    expect(firstFailure.calls).toHaveLength(1);
    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isErr()) {
      expect(timedOut.error).toBeInstanceOf(TimeoutError);
      if (timedOut.error instanceof TimeoutError) {
        expect(timedOut.error.operation).toBe('waitForTransferStatus');
        expect(timedOut.error.timeoutMs).toBe(5);
      }
    }
    expect(cancelled.isErr() && cancelled.error.code).toBe('CANCELLED');
  });

  it.each([
    ['a null request', null],
    ['a malformed source hash', { sourceTransactionHash: '0x12', statusContext: {} }],
    [
      'a same-chain Status Context',
      {
        sourceTransactionHash: SOURCE_HASH,
        statusContext: { provider: 'enso', sourceChainId: 1, destinationChainId: 1, bridge: 'x' },
      },
    ],
    [
      'a 0x Status Context without its Provider Quote ID',
      {
        sourceTransactionHash: SOURCE_HASH,
        statusContext: {
          provider: '0x',
          sourceChainId: 8453,
          destinationChainId: 1,
          bridge: 'across_v4',
        },
      },
    ],
  ])('rejects %s before any request', async (_name, statusRequest) => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('completed') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForTransferStatus(statusRequest as never);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ['null options', null],
    ['a zero polling interval', { pollingIntervalMs: 0 }],
    ['an infinite timeout', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['a non-function status callback', { onStatus: 'log' }],
    ['a non-boolean waitForRecovery', { waitForRecovery: 'yes' }],
  ])('rejects %s before any request', async (_name, options) => {
    const transport = fetchSequence({ body: ensoTransferStatusFixture('completed') });
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForTransferStatus(
      {
        sourceTransactionHash: SOURCE_HASH,
        statusContext: crossChainQuoteFixture().statusContext!,
      },
      options as never,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(transport.calls).toHaveLength(0);
  });
});
