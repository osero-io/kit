import { encodeFunctionData, formatUnits, type Address, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { Mock } from 'vitest';

import {
  createExecutionHandlerFake as executionHandler,
  ensoTransferStatusFixture,
  lifiTransferStatusFixture,
  mockFn,
  TEST_DESTINATION_TRANSACTION_HASH as DESTINATION_HASH,
  TEST_SOURCE_TRANSACTION_HASH as SOURCE_HASH,
} from './_testing.js';
import { erc20Abi } from './abis/erc20.js';
import {
  isOseroApiEnsoTransferStatusProviderDetails,
  isOseroApiLifiProviderDetails,
  isOseroApiLifiTransferStatusProviderDetails,
  matchOseroApiAsset,
  oseroApiAmount,
  OseroApiClient,
  type OseroApiFetch,
  type OseroApiInputAmount,
  type OseroApiSwapQuoteRequest,
  type OseroApiSwapQuoteResponse,
} from './api.js';
import { parseSlippage, referral, UINT256_MAX } from './domain.js';
import {
  ApiRequestError,
  ApiResponseError,
  ApprovalLimitError,
  BroadcastError,
  ConfigurationError,
  ProgressCallbackError,
  QuoteExpiredError,
  QuoteRefreshLimitError,
  TimeoutError,
} from './errors.js';
import { errAsync } from './result.js';
import type { ExecutionPlanHandler } from './types.js';

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
  } = {},
): OseroApiSwapQuoteResponse {
  const requiredAmount =
    options.requiredAmount ?? BigInt(ENSO_SAME_CHAIN_QUOTE.quote.inputAmount.raw);
  const approvalData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [options.encodedSpender ?? options.spender ?? SPENDER, requiredAmount],
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
            chainId: 1,
            sender: options.sender ?? WALLET,
            recipient: options.recipient ?? ENSO_SAME_CHAIN_QUOTE.pair.source.address,
            calldata: approvalData,
            value: '0',
            gasLimit: '50000',
          },
        },
      ],
    },
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

  it('polls pending and unknown states, de-duplicates callbacks, and returns completion', async () => {
    const initial = ensoTransferStatusFixture('pending', 'PENDING');
    const pending = ensoTransferStatusFixture('unknown', 'future-provider-state');
    const completed = ensoTransferStatusFixture('completed', 'delivered');
    const transport = fetchSequence(
      { body: initial },
      { body: initial },
      { body: pending },
      { body: completed },
    );
    const onStatus = mockFn();
    const client = OseroApiClient.create({ apiKey: API_KEY, fetch: transport.fetch });

    const result = await client.waitForSwapCompletion(crossChainQuoteFixture(), SOURCE_HASH, {
      pollingIntervalMs: 1,
      timeoutMs: 1_000,
      onStatus,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.state).toBe('completed');
      expect(result.value.destinationTransactionHash).toBe(DESTINATION_HASH);
      if (isOseroApiEnsoTransferStatusProviderDetails(result.value.providerDetails)) {
        expect(result.value.providerDetails.status).toBe('delivered');
      }
    }
    expect(onStatus).toHaveBeenCalledTimes(3);
    expect(transport.calls).toHaveLength(4);
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
    if (
      result.isOk() &&
      isOseroApiLifiTransferStatusProviderDetails(result.value.providerDetails)
    ) {
      expect(result.value.providerDetails.status).toBe('DONE');
      expect(result.value.providerDetails.substatus).toBe('COMPLETED');
    }
  });

  it.each([
    ['provider', { provider: 'enso' }],
    ['source chain', { sourceChainId: 10 }],
    ['destination chain', { destinationChainId: 10 }],
    ['bridge', { bridge: 'another-bridge' }],
    ['source transaction hash', { sourceTransactionHash: DESTINATION_HASH }],
    ['destination transaction hash', { destinationTransactionHash: '0x12' }],
    ['normalized state', { state: 'future-state' }],
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

  it('supports cancellation during polling and bounded timeout', async () => {
    const controller = new AbortController();
    const cancelTransport = fetchSequence({ body: ensoTransferStatusFixture('pending') });
    const cancelClient = OseroApiClient.create({ apiKey: API_KEY, fetch: cancelTransport.fetch });
    const onStatus = mockFn(() => controller.abort('stop'));
    const cancelled = await cancelClient.waitForSwapCompletion(
      crossChainQuoteFixture(),
      SOURCE_HASH,
      {
        pollingIntervalMs: 1,
        timeoutMs: 100,
        signal: controller.signal,
        onStatus,
      },
    );

    const timeoutTransport = fetchSequence({ body: ensoTransferStatusFixture('pending') });
    const timeoutClient = OseroApiClient.create({ apiKey: API_KEY, fetch: timeoutTransport.fetch });
    const timedOut = await timeoutClient.waitForSwapCompletion(
      crossChainQuoteFixture(),
      SOURCE_HASH,
      {
        pollingIntervalMs: 1,
        timeoutMs: 5,
      },
    );

    expect(cancelled.isErr()).toBe(true);
    if (cancelled.isErr()) expect(cancelled.error.code).toBe('CANCELLED');
    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isErr()) expect(timedOut.error).toBeInstanceOf(TimeoutError);
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
