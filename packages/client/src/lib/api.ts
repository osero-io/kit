import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';

import {
  ApiRequestError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
} from './errors.js';
import { makeApprovalRequiredPlan, makeTransactionRequest } from './plan.js';
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from './result.js';
import type { Erc20ApprovalRequired, OperationType, TransactionRequest } from './types.js';

export const DEFAULT_OSERO_API_BASE_URL = 'https://api.osero.org/v1/';

/**
 * Chains the Osero swap API can route from or to, as a single source of truth.
 * Add a chain here to make its id and key decodable in `/swap/assets` and quote
 * responses. Counter assets bind to a chain through their `<chainKey>:` asset-id
 * prefix, so every chain listed here backs at least one counter asset.
 */
export const OSERO_API_CHAINS = [
  { chainKey: 'ethereum', chainId: 1 },
  { chainKey: 'base', chainId: 8453 },
  { chainKey: 'arbitrum', chainId: 42161 },
  { chainKey: 'optimism', chainId: 10 },
  { chainKey: 'linea', chainId: 59144 },
  { chainKey: 'bnb', chainId: 56 },
  { chainKey: 'unichain', chainId: 130 },
  { chainKey: 'polygon', chainId: 137 },
  { chainKey: 'monad', chainId: 143 },
  { chainKey: 'hyperevm', chainId: 999 },
  { chainKey: 'plasma', chainId: 9745 },
  { chainKey: 'avalanche_c', chainId: 43114 },
  { chainKey: 'berachain', chainId: 80094 },
] as const;

/**
 * Counter assets — the user-facing tokens swappable against the sUSDS vault.
 * Each id is `<chainKey>:<tokenKey>`, with `chainKey` drawn from
 * {@link OSERO_API_CHAINS}. Add a row to support a new token, or a new chain
 * deployment of a token; the derived id, symbol, and decimal sets plus every
 * response decoder below update from this list. Contract addresses are NOT kept
 * here — this is an API client, so it only validates that responses carry a
 * well-formed address and trusts the API for the canonical deployment.
 */
export const OSERO_API_COUNTER_ASSETS = [
  // USDC — native Circle issuance (6 decimals).
  { assetId: 'base:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'arbitrum:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'optimism:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'linea:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'ethereum:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'avalanche_c:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'hyperevm:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'monad:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'polygon:usdc', symbol: 'USDC', decimals: 6 },
  { assetId: 'unichain:usdc', symbol: 'USDC', decimals: 6 },
  // USDC.e — canonical bridged USDC on Berachain (6 decimals).
  { assetId: 'berachain:usdce', symbol: 'USDC.e', decimals: 6 },
  // USDe — Ethena synthetic dollar (18 decimals).
  { assetId: 'ethereum:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'arbitrum:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'base:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'optimism:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'linea:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'avalanche_c:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'bnb:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'berachain:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'hyperevm:usde', symbol: 'USDe', decimals: 18 },
  { assetId: 'plasma:usde', symbol: 'USDe', decimals: 18 },
  // Ethereum-native stablecoins.
  { assetId: 'ethereum:ausd', symbol: 'AUSD', decimals: 6 },
  { assetId: 'ethereum:gho', symbol: 'GHO', decimals: 18 },
  { assetId: 'ethereum:pyusd', symbol: 'PYUSD', decimals: 6 },
  { assetId: 'arbitrum:pyusd', symbol: 'PYUSD', decimals: 6 },
  { assetId: 'ethereum:rlusd', symbol: 'RLUSD', decimals: 18 },
  { assetId: 'ethereum:usdd', symbol: 'USDD', decimals: 18 },
  { assetId: 'ethereum:usdg', symbol: 'USDG', decimals: 6 },
  { assetId: 'ethereum:usdt', symbol: 'USDT', decimals: 6 },
  { assetId: 'ethereum:usdtb', symbol: 'USDtb', decimals: 18 },
  { assetId: 'ethereum:frxusd', symbol: 'frxUSD', decimals: 18 },
] as const;

/** The single sUSDS vault asset that every counter asset swaps against. */
export const OSERO_API_VAULT_ASSET = {
  assetId: 'ethereum:susds',
  symbol: 'sUSDS',
  decimals: 18,
} as const;

const OSERO_API_ASSETS = [...OSERO_API_COUNTER_ASSETS, OSERO_API_VAULT_ASSET] as const;

export type OseroApiAsset =
  | (typeof OSERO_API_COUNTER_ASSETS)[number]
  | typeof OSERO_API_VAULT_ASSET;
export type OseroApiChain = (typeof OSERO_API_CHAINS)[number];
export type OseroApiCounterAssetId = (typeof OSERO_API_COUNTER_ASSETS)[number]['assetId'];
export type OseroApiSusdsAssetId = (typeof OSERO_API_VAULT_ASSET)['assetId'];
export type OseroApiPublicAssetId = OseroApiAsset['assetId'];
export type OseroApiChainKey = OseroApiChain['chainKey'];
export type OseroApiChainId = OseroApiChain['chainId'];
export type OseroApiSourceChainId = OseroApiChainId;
export type OseroApiAssetSymbol = OseroApiAsset['symbol'];
export type OseroApiAssetDecimals = OseroApiAsset['decimals'];

export const OSERO_API_COUNTER_ASSET_IDS: readonly OseroApiCounterAssetId[] =
  OSERO_API_COUNTER_ASSETS.map((asset) => asset.assetId);

export const OSERO_API_SUSDS_ASSET_ID: OseroApiSusdsAssetId = OSERO_API_VAULT_ASSET.assetId;

export const OSERO_API_PUBLIC_ASSET_IDS: readonly OseroApiPublicAssetId[] = OSERO_API_ASSETS.map(
  (asset) => asset.assetId,
);

export const OSERO_API_CHAIN_IDS: readonly OseroApiChainId[] = OSERO_API_CHAINS.map(
  (chain) => chain.chainId,
);

export const OSERO_API_SOURCE_CHAIN_IDS: readonly OseroApiSourceChainId[] = OSERO_API_CHAIN_IDS;

const OSERO_API_CHAIN_KEYS: readonly OseroApiChainKey[] = OSERO_API_CHAINS.map(
  (chain) => chain.chainKey,
);

const OSERO_API_ASSET_SYMBOLS: readonly OseroApiAssetSymbol[] = [
  ...new Set(OSERO_API_ASSETS.map((asset) => asset.symbol)),
];

const OSERO_API_ASSET_DECIMALS: readonly OseroApiAssetDecimals[] = [
  ...new Set(OSERO_API_ASSETS.map((asset) => asset.decimals)),
];

const OSERO_API_CHAIN_BY_KEY = new Map<OseroApiChainKey, OseroApiChain>(
  OSERO_API_CHAINS.map((chain) => [chain.chainKey, chain]),
);

const OSERO_API_ASSET_BY_ID = new Map<OseroApiPublicAssetId, OseroApiAsset>(
  OSERO_API_ASSETS.map((asset) => [asset.assetId, asset]),
);

export const OSERO_API_BRIDGE_PROTOCOLS = ['ccip', 'layerzero', 'relay', 'stargate'] as const;
export const OSERO_API_KEY_PREFIX = 'osero_';
export const OSERO_API_KEY_MAX_LENGTH = 256;
export const OSERO_API_REFERRAL_CODE_MIN = 3000;
export const OSERO_API_REFERRAL_CODE_MAX = 3999;
const UINT256_MAX = 2n ** 256n - 1n;

export type OseroApiBridgeProtocol = (typeof OSERO_API_BRIDGE_PROTOCOLS)[number];
export type OseroApiIntegerString = `${bigint}`;
export type OseroApiReferralCode = number;

export type OseroApiSwapQuoteRequest = OseroApiToSusdsQuoteRequest | OseroApiFromSusdsQuoteRequest;

export type OseroApiToSusdsQuoteRequest = {
  readonly fromAddress: Address;
  readonly fromAssetId: OseroApiCounterAssetId;
  readonly toAssetId: OseroApiSusdsAssetId;
  readonly amount: bigint | OseroApiIntegerString;
  readonly slippage?: string;
  readonly referralCode?: OseroApiReferralCode;
};

export type OseroApiFromSusdsQuoteRequest = {
  readonly fromAddress: Address;
  readonly fromAssetId: OseroApiSusdsAssetId;
  readonly toAssetId: OseroApiCounterAssetId;
  readonly amount: bigint | OseroApiIntegerString;
  readonly slippage?: string;
  readonly referralCode?: OseroApiReferralCode;
};

export type OseroApiSwapStatusRequest = {
  readonly txHash: Hex;
  readonly sourceChainId: OseroApiSourceChainId;
  readonly bridgeProtocol: OseroApiBridgeProtocol;
};

export type OseroApiRequestOptions = {
  /**
   * Override the API key for a single request. Useful when a server-side
   * integration serves multiple tenants through one client instance.
   */
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
};

export type OseroApiClientConfig = {
  readonly apiKey: string;
  readonly baseUrl?: string | URL;
  readonly fetch?: OseroApiFetch;
};

export type ResolvedOseroApiClientConfig = {
  readonly baseUrl: string;
};

export type OseroApiFetchInit = {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
};

export type OseroApiFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
};

export type OseroApiFetch = (
  url: string,
  init: OseroApiFetchInit,
) => Promise<OseroApiFetchResponse>;

export type OseroApiClientError =
  | ValidationError
  | UnsupportedChainError
  | ApiRequestError
  | UnexpectedError;

export type OseroApiAssetKind = 'counter' | 'vault';
export type OseroApiSwapDirection = 'to-susds' | 'from-susds';
export type OseroApiSwapExecutionKind = 'same-chain' | 'cross-chain';
export type OseroApiBridgeState = 'pending' | 'completed' | 'failed' | 'unknown';
export type OseroApiBridgeProviderStatus =
  | 'pending'
  | 'inflight'
  | 'delivered'
  | 'failed'
  | 'unknown';

export type OseroApiSwapAsset = {
  readonly assetId: OseroApiPublicAssetId;
  readonly chainId: OseroApiChainId;
  readonly chainKey: OseroApiChainKey;
  readonly chainName: string;
  readonly chainShortName: string;
  readonly symbol: OseroApiAssetSymbol;
  readonly decimals: OseroApiAssetDecimals;
  readonly address: Address;
  readonly label: string;
};

export type OseroApiSupportedAsset = OseroApiSwapAsset & {
  readonly kind: OseroApiAssetKind;
};

export type OseroApiSupportedAssetsResponse = {
  readonly assets: readonly OseroApiSupportedAsset[];
};

export type OseroApiSwapAmount = {
  readonly raw: OseroApiIntegerString;
  readonly formatted: string;
};

export type OseroApiSwapTransaction = {
  readonly to: Address;
  readonly from: Address;
  readonly data: Hex;
  readonly value: OseroApiIntegerString;
};

export type OseroApiSwapRouteHop = {
  readonly protocol: string;
  readonly action: string;
  readonly chainId: number;
  readonly sourceChainId: number | null;
  readonly destinationChainId: number | null;
};

export type OseroApiSwapBridgeStatusRequest = {
  readonly sourceChainId: OseroApiSourceChainId;
  readonly bridgeProtocol: OseroApiBridgeProtocol;
};

export type OseroApiSwapQuoteInfo = {
  readonly amountIn: OseroApiSwapAmount;
  readonly amountOut: OseroApiSwapAmount | null;
  readonly previewUnavailable: boolean;
  readonly slippage: {
    readonly bps: string;
    readonly percent: string;
  };
  readonly gas: OseroApiIntegerString | null;
  readonly priceImpactBps: number | null;
  readonly createdAt: number | null;
};

export type OseroApiSwapApproval = {
  readonly token: OseroApiSwapAsset;
  readonly spender: Address;
  readonly amount: OseroApiSwapAmount;
  readonly gas: OseroApiIntegerString | null;
  readonly transaction: OseroApiSwapTransaction;
};

export type OseroApiSwapExecution = {
  readonly kind: OseroApiSwapExecutionKind;
  readonly sourceChainId: OseroApiSourceChainId;
  readonly destinationChainId: OseroApiChainId;
  readonly transaction: OseroApiSwapTransaction;
  readonly route: readonly OseroApiSwapRouteHop[];
};

/**
 * Discriminated on `required`: a cross-chain quote always carries a
 * non-null `protocol` + `statusRequest`, a same-chain quote always
 * carries `null` for both. The decoder enforces this invariant at
 * runtime so callers can rely on the narrowing.
 */
export type OseroApiSwapBridge =
  | {
      readonly required: true;
      readonly protocol: OseroApiBridgeProtocol;
      readonly statusRequest: OseroApiSwapBridgeStatusRequest;
    }
  | {
      readonly required: false;
      readonly protocol: null;
      readonly statusRequest: null;
    };

export type OseroApiSwapPair = {
  readonly direction: OseroApiSwapDirection;
  readonly from: OseroApiSwapAsset;
  readonly to: OseroApiSwapAsset;
};

export type OseroApiSwapQuoteResponse = {
  readonly pair: OseroApiSwapPair;
  readonly quote: OseroApiSwapQuoteInfo;
  readonly approval: OseroApiSwapApproval;
  readonly execution: OseroApiSwapExecution;
  readonly bridge: OseroApiSwapBridge;
};

export type OseroApiSwapQuote = OseroApiSwapQuoteResponse & {
  /**
   * Existing `@osero/client/viem` and `@osero/client/ethers` adapters can
   * execute this plan directly.
   */
  readonly executionPlan: Erc20ApprovalRequired;
};

export type OseroApiSwapStatusBridge = {
  readonly protocol: OseroApiBridgeProtocol;
  readonly state: OseroApiBridgeState;
  readonly providerStatus: OseroApiBridgeProviderStatus;
  readonly sourceChainId: OseroApiSourceChainId;
  readonly destinationChainId: OseroApiSourceChainId | null;
  readonly sourceTxHash: Hex;
  readonly destinationTxHash: Hex | null;
  readonly error: string | null;
};

export type OseroApiSwapStatusResponse = {
  readonly bridge: OseroApiSwapStatusBridge;
};

type OseroApiSwapQuoteBody = {
  readonly fromAddress: Address;
  readonly fromAssetId: OseroApiPublicAssetId;
  readonly toAssetId: OseroApiPublicAssetId;
  readonly amount: OseroApiIntegerString;
  readonly slippage?: string;
  readonly referralCode?: OseroApiReferralCode;
};

type RequestJsonArgs<T> = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: OseroApiSwapQuoteBody;
  readonly options?: OseroApiRequestOptions;
  readonly decoder: (value: unknown) => Result<T, UnexpectedError>;
};

/**
 * HTTP client for `https://api.osero.org/v1/`. It is intentionally
 * independent from the on-chain `OseroClient`: callers can use it only to
 * fetch quotes, or pass `quote.executionPlan` to the existing wallet
 * adapters for execution.
 */
export class OseroApiClient {
  readonly config: ResolvedOseroApiClientConfig;

  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: OseroApiFetch;

  constructor(config: OseroApiClientConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_OSERO_API_BASE_URL);
    this.#fetch = resolveFetch(config.fetch);
    this.config = {
      baseUrl: this.#baseUrl.toString(),
    };
  }

  static create(config: OseroApiClientConfig): OseroApiClient {
    return new OseroApiClient(config);
  }

  getSupportedAssets(
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSupportedAssetsResponse, OseroApiClientError> {
    return this.requestJson({
      method: 'GET',
      path: 'swap/assets',
      options,
      decoder: decodeSupportedAssetsResponse,
    });
  }

  getSwapQuote(
    request: OseroApiSwapQuoteRequest,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSwapQuote, OseroApiClientError> {
    const body = encodeSwapQuoteRequest(request);
    if (body.isErr()) {
      return errAsync(body.error);
    }

    return this.requestJson({
      method: 'POST',
      path: 'swap/quote',
      body: body.value,
      options,
      decoder: decodeSwapQuoteResponse,
    }).map(withExecutionPlan);
  }

  getSwapStatus(
    request: OseroApiSwapStatusRequest,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSwapStatusResponse, OseroApiClientError> {
    const query = encodeSwapStatusRequest(request);
    if (query.isErr()) {
      return errAsync(query.error);
    }

    return this.requestJson({
      method: 'GET',
      path: query.value,
      options,
      decoder: decodeSwapStatusResponse,
    });
  }

  /**
   * Convenience wrapper around {@link OseroApiClient.getSwapStatus} that
   * pulls `sourceChainId` and `bridgeProtocol` out of a cross-chain
   * quote's `bridge.statusRequest`, so callers only need to supply the
   * source-chain tx hash returned by their wallet.
   *
   * Returns a {@link ValidationError} when the quote is same-chain
   * (`bridge.required === false`) since there is no bridge to track.
   */
  getSwapStatusForQuote(
    quote: OseroApiSwapQuoteResponse,
    txHash: Hex,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSwapStatusResponse, OseroApiClientError> {
    if (!quote.bridge.required) {
      return errAsync(
        ValidationError.forField(
          'quote',
          'Quote is same-chain — getSwapStatusForQuote requires a cross-chain bridge.',
        ),
      );
    }

    return this.getSwapStatus(
      {
        txHash,
        sourceChainId: quote.bridge.statusRequest.sourceChainId,
        bridgeProtocol: quote.bridge.statusRequest.bridgeProtocol,
      },
      options,
    );
  }

  private requestJson<T>({
    method,
    path,
    body,
    options,
    decoder,
  }: RequestJsonArgs<T>): ResultAsync<T, OseroApiClientError> {
    const apiKey = resolveApiKey(options?.apiKey ?? this.#apiKey);
    if (apiKey.isErr()) {
      return errAsync(apiKey.error);
    }

    const url = new URL(path, this.#baseUrl);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': apiKey.value,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const init: OseroApiFetchInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    };

    return ResultAsync.fromPromise(this.#fetch(url.toString(), init), (error) =>
      UnexpectedError.from(error),
    ).andThen((response) =>
      ResultAsync.fromPromise(response.text(), (error) => UnexpectedError.from(error)).andThen(
        (text) => {
          const bodyResult = parseJsonBody(text);
          const responseBody = bodyResult.isOk() ? bodyResult.value : text;

          if (!response.ok) {
            return errAsync(
              ApiRequestError.from({
                statusCode: response.status,
                statusText: response.statusText,
                body: responseBody,
                cause: bodyResult.isErr() ? bodyResult.error : undefined,
              }),
            );
          }

          if (bodyResult.isErr()) {
            return errAsync(bodyResult.error);
          }

          const decoded = decoder(bodyResult.value);
          if (decoded.isErr()) {
            return errAsync(decoded.error);
          }

          return okAsync(decoded.value);
        },
      ),
    );
  }
}

function withExecutionPlan(response: OseroApiSwapQuoteResponse): OseroApiSwapQuote {
  return Object.assign({}, response, {
    executionPlan: swapQuoteToExecutionPlan(response),
  });
}

export function swapQuoteToExecutionPlan(quote: OseroApiSwapQuoteResponse): Erc20ApprovalRequired {
  const approvalTransaction = apiTransactionToTransactionRequest(
    quote.approval.transaction,
    quote.execution.sourceChainId,
    'APPROVE_ERC20',
  );
  const executionTransaction = apiTransactionToTransactionRequest(
    quote.execution.transaction,
    quote.execution.sourceChainId,
    operationForQuoteDirection(quote.pair.direction),
  );

  return makeApprovalRequiredPlan(executionTransaction, [
    {
      token: quote.approval.token.address,
      spender: quote.approval.spender,
      amount: BigInt(quote.approval.amount.raw),
      byTransaction: approvalTransaction,
    },
  ]);
}

function apiTransactionToTransactionRequest(
  transaction: OseroApiSwapTransaction,
  chainId: OseroApiSourceChainId,
  operation: OperationType,
): TransactionRequest {
  return makeTransactionRequest({
    chainId,
    from: transaction.from,
    to: transaction.to,
    data: transaction.data,
    value: BigInt(transaction.value),
    operation,
  });
}

function operationForQuoteDirection(direction: OseroApiSwapDirection): OperationType {
  return direction === 'to-susds' ? 'MINT_SUSDS' : 'REDEEM_SUSDS_FOR_USDC';
}

function normalizeBaseUrl(baseUrl: string | URL): URL {
  try {
    const url = new URL(baseUrl.toString());
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  } catch (cause) {
    throw new ValidationError(
      'baseUrl must be a valid absolute URL',
      { field: 'baseUrl' },
      { cause },
    );
  }
}

function resolveFetch(fetchOverride: OseroApiFetch | undefined): OseroApiFetch {
  if (fetchOverride) {
    return fetchOverride;
  }

  const globalFetch = globalThis.fetch;
  if (typeof globalFetch !== 'function') {
    throw new UnexpectedError(
      'No fetch implementation is available. Pass `fetch` to OseroApiClient.create().',
    );
  }

  return (url, init) => globalFetch(url, init);
}

function resolveApiKey(apiKey: string): Result<string, ValidationError> {
  if (!isOseroApiKeyCandidate(apiKey)) {
    return err(
      ValidationError.forField(
        'apiKey',
        `apiKey must start with ${OSERO_API_KEY_PREFIX} and contain only base64url characters`,
      ),
    );
  }
  return ok(apiKey);
}

function isOseroApiKeyCandidate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > OSERO_API_KEY_MAX_LENGTH ||
    !value.startsWith(OSERO_API_KEY_PREFIX)
  ) {
    return false;
  }

  const secret = value.slice(OSERO_API_KEY_PREFIX.length);
  return secret.length > 0 && /^[A-Za-z0-9_-]+$/.test(secret);
}

function encodeSwapQuoteRequest(
  request: OseroApiSwapQuoteRequest,
): Result<OseroApiSwapQuoteBody, ValidationError> {
  if (!isAddress(request.fromAddress)) {
    return err(ValidationError.forField('fromAddress', 'fromAddress must be an EVM address'));
  }
  if (!isOseroApiPublicAssetId(request.fromAssetId)) {
    return err(
      ValidationError.forField('fromAssetId', 'fromAssetId is not supported by the Osero API'),
    );
  }
  if (!isOseroApiPublicAssetId(request.toAssetId)) {
    return err(
      ValidationError.forField('toAssetId', 'toAssetId is not supported by the Osero API'),
    );
  }
  if (!isSupportedApiSwapPair(request.fromAssetId, request.toAssetId)) {
    return err(
      new ValidationError(
        'Only supported counter assets -> sUSDS or sUSDS -> supported counter assets are supported',
        {
          field: 'assetPair',
          fromAssetId: request.fromAssetId,
          toAssetId: request.toAssetId,
        },
      ),
    );
  }

  const amount = encodePositiveInteger(request.amount, 'amount');
  if (amount.isErr()) {
    return err(amount.error);
  }

  const slippage = encodeSlippage(request.slippage);
  if (slippage.isErr()) {
    return err(slippage.error);
  }

  const referralCode = encodeReferralCode(request.referralCode);
  if (referralCode.isErr()) {
    return err(referralCode.error);
  }

  return ok({
    fromAddress: getAddress(request.fromAddress),
    fromAssetId: request.fromAssetId,
    toAssetId: request.toAssetId,
    amount: amount.value,
    ...(slippage.value !== undefined ? { slippage: slippage.value } : {}),
    ...(referralCode.value !== undefined ? { referralCode: referralCode.value } : {}),
  });
}

function encodeSwapStatusRequest(
  request: OseroApiSwapStatusRequest,
): Result<string, ValidationError | UnsupportedChainError> {
  if (!isTransactionHash(request.txHash)) {
    return err(ValidationError.forField('txHash', 'txHash must be a 32-byte hex string'));
  }
  if (!isOseroApiSourceChainId(request.sourceChainId)) {
    return err(new UnsupportedChainError(request.sourceChainId));
  }
  if (!isOseroApiBridgeProtocol(request.bridgeProtocol)) {
    return err(
      ValidationError.forField(
        'bridgeProtocol',
        'bridgeProtocol must be one of ccip, layerzero, relay, or stargate',
      ),
    );
  }

  const search = new URLSearchParams({
    sourceChainId: String(request.sourceChainId),
    bridgeProtocol: request.bridgeProtocol,
  });
  return ok(`swap/status/${request.txHash}?${search.toString()}`);
}

function encodePositiveInteger(
  value: bigint | string,
  field: string,
): Result<OseroApiIntegerString, ValidationError> {
  if (typeof value === 'bigint') {
    if (value <= 0n) {
      return err(ValidationError.forField(field, `${field} must be greater than 0`));
    }
    return ok(value.toString() as OseroApiIntegerString);
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    return err(
      ValidationError.forField(field, `${field} must be a positive base-10 integer string`),
    );
  }
  return ok(value as OseroApiIntegerString);
}

function encodeSlippage(value: string | undefined): Result<string | undefined, ValidationError> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(value)) {
    return err(
      ValidationError.forField(
        'slippage',
        'slippage must be a percentage with up to 2 decimal places',
      ),
    );
  }
  if (Number(value) > 5) {
    return err(ValidationError.forField('slippage', 'slippage cannot exceed 5%'));
  }
  return ok(value);
}

function encodeReferralCode(
  value: OseroApiReferralCode | undefined,
): Result<OseroApiReferralCode | undefined, ValidationError> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (
    !Number.isInteger(value) ||
    value < OSERO_API_REFERRAL_CODE_MIN ||
    value > OSERO_API_REFERRAL_CODE_MAX
  ) {
    return err(
      ValidationError.forField(
        'referralCode',
        `referralCode must be an integer from ${OSERO_API_REFERRAL_CODE_MIN} to ${OSERO_API_REFERRAL_CODE_MAX}`,
      ),
    );
  }
  return ok(value);
}

function parseJsonBody(text: string): Result<unknown, UnexpectedError> {
  if (text.trim() === '') {
    return ok(null);
  }

  try {
    return ok(JSON.parse(text) as unknown);
  } catch (cause) {
    return err(UnexpectedError.from(cause));
  }
}

class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

function decodeSupportedAssetsResponse(
  value: unknown,
): Result<OseroApiSupportedAssetsResponse, UnexpectedError> {
  return decode(value, (root) => ({
    assets: arrayField(root, 'assets', '$.assets', decodeSupportedAsset),
  }));
}

function decodeSwapQuoteResponse(
  value: unknown,
): Result<OseroApiSwapQuoteResponse, UnexpectedError> {
  return decode(value, (root) => {
    const response = {
      pair: decodeSwapPair(requiredField(root, 'pair', '$.pair'), '$.pair'),
      quote: decodeSwapQuoteInfo(requiredField(root, 'quote', '$.quote'), '$.quote'),
      approval: decodeSwapApproval(requiredField(root, 'approval', '$.approval'), '$.approval'),
      execution: decodeSwapExecution(
        requiredField(root, 'execution', '$.execution'),
        '$.execution',
      ),
      bridge: decodeSwapBridge(requiredField(root, 'bridge', '$.bridge'), '$.bridge'),
    };
    assertSwapQuoteInvariants(response);
    return response;
  });
}

function decodeSwapStatusResponse(
  value: unknown,
): Result<OseroApiSwapStatusResponse, UnexpectedError> {
  return decode(value, (root) => ({
    bridge: decodeSwapStatusBridge(requiredField(root, 'bridge', '$.bridge'), '$.bridge'),
  }));
}

function assertSwapQuoteInvariants(response: OseroApiSwapQuoteResponse): void {
  const { pair, approval, execution, bridge } = response;

  if (!isSupportedApiSwapPair(pair.from.assetId, pair.to.assetId)) {
    throw new DecodeError('$.pair must be a supported counter asset <-> sUSDS pair');
  }

  const expectedDirection =
    pair.from.assetId === OSERO_API_SUSDS_ASSET_ID ? 'from-susds' : 'to-susds';
  if (pair.direction !== expectedDirection) {
    throw new DecodeError(`$.pair.direction must be '${expectedDirection}' for this asset pair`);
  }

  if (approval.token.assetId !== pair.from.assetId) {
    throw new DecodeError('$.approval.token must match $.pair.from');
  }
  if (approval.token.address !== pair.from.address) {
    throw new DecodeError('$.approval.token.address must match $.pair.from.address');
  }
  if (approval.transaction.to !== approval.token.address) {
    throw new DecodeError('$.approval.transaction.to must match $.approval.token.address');
  }
  if (approval.transaction.value !== '0') {
    throw new DecodeError('$.approval.transaction.value must be 0');
  }
  if (approval.transaction.from !== execution.transaction.from) {
    throw new DecodeError('$.approval.transaction.from must match $.execution.transaction.from');
  }

  if (execution.sourceChainId !== pair.from.chainId) {
    throw new DecodeError('$.execution.sourceChainId must match $.pair.from.chainId');
  }
  if (execution.destinationChainId !== pair.to.chainId) {
    throw new DecodeError('$.execution.destinationChainId must match $.pair.to.chainId');
  }
  if (execution.kind === 'same-chain' && execution.sourceChainId !== execution.destinationChainId) {
    throw new DecodeError('$.execution.kind cannot be same-chain across different chains');
  }
  if (
    execution.kind === 'cross-chain' &&
    execution.sourceChainId === execution.destinationChainId
  ) {
    throw new DecodeError('$.execution.kind cannot be cross-chain on a single chain');
  }

  const bridgeRequired = execution.kind === 'cross-chain';
  if (bridge.required !== bridgeRequired) {
    throw new DecodeError('$.bridge.required must match $.execution.kind');
  }
  if (bridge.required) {
    if (bridge.statusRequest.sourceChainId !== execution.sourceChainId) {
      throw new DecodeError(
        '$.bridge.statusRequest.sourceChainId must match $.execution.sourceChainId',
      );
    }
    if (bridge.statusRequest.bridgeProtocol !== bridge.protocol) {
      throw new DecodeError('$.bridge.statusRequest.bridgeProtocol must match $.bridge.protocol');
    }
  }
}

function decode<T>(
  value: unknown,
  run: (root: Record<string, unknown>) => T,
): Result<T, UnexpectedError> {
  try {
    return ok(run(asRecord(value, '$')));
  } catch (cause) {
    return err(UnexpectedError.from(cause));
  }
}

function decodeSupportedAsset(value: unknown, path: string): OseroApiSupportedAsset {
  const record = asRecord(value, path);
  const asset = decodeSwapAsset(record, path);
  const kind = enumStringField(record, 'kind', `${path}.kind`, OSERO_API_ASSET_KINDS);
  const expectedKind = asset.assetId === OSERO_API_SUSDS_ASSET_ID ? 'vault' : 'counter';
  if (kind !== expectedKind) {
    throw new DecodeError(`${path}.kind must be '${expectedKind}' for ${asset.assetId}`);
  }
  return {
    ...asset,
    kind,
  };
}

function decodeSwapPair(value: unknown, path: string): OseroApiSwapPair {
  const record = asRecord(value, path);
  return {
    direction: enumStringField(record, 'direction', `${path}.direction`, OSERO_API_DIRECTIONS),
    from: decodeSwapAsset(requiredField(record, 'from', `${path}.from`), `${path}.from`),
    to: decodeSwapAsset(requiredField(record, 'to', `${path}.to`), `${path}.to`),
  };
}

function decodeSwapAsset(value: unknown, path: string): OseroApiSwapAsset {
  const record = asRecord(value, path);
  const assetId = enumStringField(record, 'assetId', `${path}.assetId`, OSERO_API_PUBLIC_ASSET_IDS);
  const expectedAsset = apiAssetForId(assetId, `${path}.assetId`);
  const expectedChain = apiChainForAssetId(assetId, `${path}.assetId`);
  const chainId = sourceChainIdField(record, 'chainId', `${path}.chainId`);
  const chainKey = enumStringField(record, 'chainKey', `${path}.chainKey`, OSERO_API_CHAIN_KEYS);
  const symbol = enumStringField(record, 'symbol', `${path}.symbol`, OSERO_API_ASSET_SYMBOLS);
  const decimals = decimalsField(record, 'decimals', `${path}.decimals`);

  if (chainKey !== expectedChain.chainKey) {
    throw new DecodeError(`${path}.chainKey must be '${expectedChain.chainKey}' for ${assetId}`);
  }
  if (chainId !== expectedChain.chainId) {
    throw new DecodeError(`${path}.chainId must be ${expectedChain.chainId} for ${assetId}`);
  }
  if (symbol !== expectedAsset.symbol) {
    throw new DecodeError(`${path}.symbol must be '${expectedAsset.symbol}' for ${assetId}`);
  }
  if (decimals !== expectedAsset.decimals) {
    throw new DecodeError(`${path}.decimals must be ${expectedAsset.decimals} for ${assetId}`);
  }

  return {
    assetId,
    chainId,
    chainKey,
    chainName: stringField(record, 'chainName', `${path}.chainName`),
    chainShortName: stringField(record, 'chainShortName', `${path}.chainShortName`),
    symbol,
    decimals,
    address: addressField(record, 'address', `${path}.address`),
    label: stringField(record, 'label', `${path}.label`),
  };
}

function apiAssetForId(assetId: OseroApiPublicAssetId, path: string): OseroApiAsset {
  const asset = OSERO_API_ASSET_BY_ID.get(assetId);
  if (asset === undefined) {
    throw new DecodeError(`${path} has no registered asset metadata`);
  }
  return asset;
}

function apiChainForAssetId(assetId: OseroApiPublicAssetId, path: string): OseroApiChain {
  const [chainKey] = assetId.split(':') as [OseroApiChainKey, string];
  const chain = OSERO_API_CHAIN_BY_KEY.get(chainKey);
  if (chain === undefined) {
    throw new DecodeError(`${path} references unregistered chain '${chainKey}'`);
  }
  return chain;
}

function decodeSwapQuoteInfo(value: unknown, path: string): OseroApiSwapQuoteInfo {
  const record = asRecord(value, path);
  return {
    amountIn: decodeSwapAmount(
      requiredField(record, 'amountIn', `${path}.amountIn`),
      `${path}.amountIn`,
    ),
    amountOut: nullableField(record, 'amountOut', `${path}.amountOut`, decodeSwapAmount),
    previewUnavailable: booleanField(record, 'previewUnavailable', `${path}.previewUnavailable`),
    slippage: decodeSlippage(
      requiredField(record, 'slippage', `${path}.slippage`),
      `${path}.slippage`,
    ),
    gas: nullableField(record, 'gas', `${path}.gas`, decodeNonNegativeIntegerString),
    priceImpactBps: nullableField(record, 'priceImpactBps', `${path}.priceImpactBps`, decodeNumber),
    createdAt: nullableField(record, 'createdAt', `${path}.createdAt`, decodeNumber),
  };
}

function decodeSwapAmount(value: unknown, path: string): OseroApiSwapAmount {
  const record = asRecord(value, path);
  return {
    raw: uint256StringField(record, 'raw', `${path}.raw`),
    formatted: stringField(record, 'formatted', `${path}.formatted`),
  };
}

function decodeSlippage(
  value: unknown,
  path: string,
): { readonly bps: string; readonly percent: string } {
  const record = asRecord(value, path);
  return {
    bps: stringField(record, 'bps', `${path}.bps`),
    percent: stringField(record, 'percent', `${path}.percent`),
  };
}

function decodeSwapApproval(value: unknown, path: string): OseroApiSwapApproval {
  const record = asRecord(value, path);
  return {
    token: decodeSwapAsset(requiredField(record, 'token', `${path}.token`), `${path}.token`),
    spender: addressField(record, 'spender', `${path}.spender`),
    amount: decodeSwapAmount(requiredField(record, 'amount', `${path}.amount`), `${path}.amount`),
    gas: nullableField(record, 'gas', `${path}.gas`, decodeNonNegativeIntegerString),
    transaction: decodeSwapTransaction(
      requiredField(record, 'transaction', `${path}.transaction`),
      `${path}.transaction`,
    ),
  };
}

function decodeSwapExecution(value: unknown, path: string): OseroApiSwapExecution {
  const record = asRecord(value, path);
  return {
    kind: enumStringField(record, 'kind', `${path}.kind`, OSERO_API_EXECUTION_KINDS),
    sourceChainId: sourceChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: sourceChainIdField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
    ),
    transaction: decodeSwapTransaction(
      requiredField(record, 'transaction', `${path}.transaction`),
      `${path}.transaction`,
    ),
    route: arrayField(record, 'route', `${path}.route`, decodeSwapRouteHop),
  };
}

function decodeSwapBridge(value: unknown, path: string): OseroApiSwapBridge {
  const record = asRecord(value, path);
  const required = booleanField(record, 'required', `${path}.required`);
  const protocol = nullableField(record, 'protocol', `${path}.protocol`, decodeBridgeProtocol);
  const statusRequest = nullableField(
    record,
    'statusRequest',
    `${path}.statusRequest`,
    decodeSwapBridgeStatusRequest,
  );

  if (required) {
    if (protocol === null) {
      throw new DecodeError(`${path}.protocol must not be null when bridge.required is true`);
    }
    if (statusRequest === null) {
      throw new DecodeError(`${path}.statusRequest must not be null when bridge.required is true`);
    }
    return { required: true, protocol, statusRequest };
  }

  if (protocol !== null) {
    throw new DecodeError(`${path}.protocol must be null when bridge.required is false`);
  }
  if (statusRequest !== null) {
    throw new DecodeError(`${path}.statusRequest must be null when bridge.required is false`);
  }
  return { required: false, protocol: null, statusRequest: null };
}

function decodeSwapBridgeStatusRequest(
  value: unknown,
  path: string,
): OseroApiSwapBridgeStatusRequest {
  const record = asRecord(value, path);
  return {
    sourceChainId: sourceChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    bridgeProtocol: enumStringField(
      record,
      'bridgeProtocol',
      `${path}.bridgeProtocol`,
      OSERO_API_BRIDGE_PROTOCOLS,
    ),
  };
}

function decodeSwapTransaction(value: unknown, path: string): OseroApiSwapTransaction {
  const record = asRecord(value, path);
  return {
    to: addressField(record, 'to', `${path}.to`),
    from: addressField(record, 'from', `${path}.from`),
    data: hexField(record, 'data', `${path}.data`),
    value: transactionValueField(record, 'value', `${path}.value`),
  };
}

function decodeSwapRouteHop(value: unknown, path: string): OseroApiSwapRouteHop {
  const record = asRecord(value, path);
  return {
    protocol: stringField(record, 'protocol', `${path}.protocol`),
    action: stringField(record, 'action', `${path}.action`),
    chainId: positiveIntegerField(record, 'chainId', `${path}.chainId`),
    sourceChainId: nullableField(record, 'sourceChainId', `${path}.sourceChainId`, decodeNumber),
    destinationChainId: nullableField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
      decodeNumber,
    ),
  };
}

function decodeSwapStatusBridge(value: unknown, path: string): OseroApiSwapStatusBridge {
  const record = asRecord(value, path);
  return {
    protocol: enumStringField(record, 'protocol', `${path}.protocol`, OSERO_API_BRIDGE_PROTOCOLS),
    state: enumStringField(record, 'state', `${path}.state`, OSERO_API_BRIDGE_STATES),
    providerStatus: enumStringField(
      record,
      'providerStatus',
      `${path}.providerStatus`,
      OSERO_API_BRIDGE_PROVIDER_STATUSES,
    ),
    sourceChainId: sourceChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: nullableField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
      decodeSourceChainId,
    ),
    sourceTxHash: hashField(record, 'sourceTxHash', `${path}.sourceTxHash`),
    destinationTxHash: nullableField(
      record,
      'destinationTxHash',
      `${path}.destinationTxHash`,
      decodeHash,
    ),
    error: nullableField(record, 'error', `${path}.error`, decodeString),
  };
}

const OSERO_API_ASSET_KINDS = ['counter', 'vault'] as const;
const OSERO_API_DIRECTIONS = ['to-susds', 'from-susds'] as const;
const OSERO_API_EXECUTION_KINDS = ['same-chain', 'cross-chain'] as const;
const OSERO_API_BRIDGE_STATES = ['pending', 'completed', 'failed', 'unknown'] as const;
const OSERO_API_BRIDGE_PROVIDER_STATUSES = [
  'pending',
  'inflight',
  'delivered',
  'failed',
  'unknown',
] as const;

function requiredField(record: Record<string, unknown>, field: string, path: string): unknown {
  if (!(field in record)) {
    throw new DecodeError(`${path} is required`);
  }
  return record[field];
}

function nullableField<T>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  decodeValue: (value: unknown, path: string) => T,
): T | null {
  const value = requiredField(record, field, path);
  return value === null ? null : decodeValue(value, path);
}

function arrayField<T>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  decodeValue: (value: unknown, path: string) => T,
): readonly T[] {
  const value = requiredField(record, field, path);
  if (!Array.isArray(value)) {
    throw new DecodeError(`${path} must be an array`);
  }
  return value.map((entry, index) => decodeValue(entry, `${path}[${index}]`));
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecodeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string, path: string): string {
  return decodeString(requiredField(record, field, path), path);
}

function decodeString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new DecodeError(`${path} must be a string`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string, path: string): boolean {
  const value = requiredField(record, field, path);
  if (typeof value !== 'boolean') {
    throw new DecodeError(`${path} must be a boolean`);
  }
  return value;
}

function decodeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DecodeError(`${path} must be a finite number`);
  }
  return value;
}

function positiveIntegerField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): number {
  const value = decodeNumber(requiredField(record, field, path), path);
  if (!Number.isInteger(value) || value <= 0) {
    throw new DecodeError(`${path} must be a positive integer`);
  }
  return value;
}

function enumStringField<T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  path: string,
  values: T,
): T[number] {
  const value = stringField(record, field, path);
  if (!isOneOf(values, value)) {
    throw new DecodeError(`${path} has unsupported value '${value}'`);
  }
  return value;
}

function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number]);
}

function addressField(record: Record<string, unknown>, field: string, path: string): Address {
  const value = stringField(record, field, path);
  if (!isAddress(value)) {
    throw new DecodeError(`${path} must be an EVM address`);
  }
  return getAddress(value);
}

function hexField(record: Record<string, unknown>, field: string, path: string): Hex {
  const value = stringField(record, field, path);
  if (!isHex(value)) {
    throw new DecodeError(`${path} must be a 0x-prefixed hex string`);
  }
  return value;
}

function hashField(record: Record<string, unknown>, field: string, path: string): Hex {
  return decodeHash(requiredField(record, field, path), path);
}

function decodeHash(value: unknown, path: string): Hex {
  const hash = decodeString(value, path);
  if (!isTransactionHash(hash)) {
    throw new DecodeError(`${path} must be a 32-byte hex string`);
  }
  return hash;
}

function nonNegativeIntegerStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): OseroApiIntegerString {
  return decodeNonNegativeIntegerString(requiredField(record, field, path), path);
}

function uint256StringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): OseroApiIntegerString {
  return encodeUint256String(BigInt(nonNegativeIntegerStringField(record, field, path)), path);
}

function decodeNonNegativeIntegerString(value: unknown, path: string): OseroApiIntegerString {
  const text = decodeString(value, path);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new DecodeError(`${path} must be a non-negative integer string`);
  }
  return text as OseroApiIntegerString;
}

function transactionValueField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): OseroApiIntegerString {
  return decodeIntegerLikeUint256String(requiredField(record, field, path), path);
}

function decodeIntegerLikeUint256String(value: unknown, path: string): OseroApiIntegerString {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DecodeError(`${path} must be a safe non-negative integer number`);
    }
    return encodeUint256String(BigInt(value), path);
  }

  const text = decodeString(value, path);
  if (/^(?:0|[1-9][0-9]*)$/.test(text)) {
    return encodeUint256String(BigInt(text), path);
  }
  if (/^0x[0-9a-fA-F]+$/.test(text)) {
    return encodeUint256String(BigInt(text), path);
  }

  throw new DecodeError(`${path} must be a non-negative integer string, number, or hex string`);
}

function encodeUint256String(value: bigint, path: string): OseroApiIntegerString {
  if (value > UINT256_MAX) {
    throw new DecodeError(`${path} must fit within uint256`);
  }
  return value.toString() as OseroApiIntegerString;
}

function decimalsField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): OseroApiAssetDecimals {
  const value = positiveIntegerField(record, field, path);
  if (!(OSERO_API_ASSET_DECIMALS as readonly number[]).includes(value)) {
    throw new DecodeError(`${path} must be one of: ${OSERO_API_ASSET_DECIMALS.join(', ')}`);
  }
  return value as OseroApiAssetDecimals;
}

function sourceChainIdField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): OseroApiSourceChainId {
  return decodeSourceChainId(requiredField(record, field, path), path);
}

function decodeSourceChainId(value: unknown, path: string): OseroApiSourceChainId {
  const chainId = decodeNumber(value, path);
  if (!isOseroApiSourceChainId(chainId)) {
    throw new DecodeError(`${path} has unsupported chain id ${chainId}`);
  }
  return chainId;
}

function decodeBridgeProtocol(value: unknown, path: string): OseroApiBridgeProtocol {
  const protocol = decodeString(value, path);
  if (!isOseroApiBridgeProtocol(protocol)) {
    throw new DecodeError(`${path} has unsupported bridge protocol '${protocol}'`);
  }
  return protocol;
}

function isOseroApiSourceChainId(value: number): value is OseroApiSourceChainId {
  return OSERO_API_SOURCE_CHAIN_IDS.includes(value as OseroApiSourceChainId);
}

function isOseroApiPublicAssetId(value: unknown): value is OseroApiPublicAssetId {
  return (
    typeof value === 'string' && OSERO_API_PUBLIC_ASSET_IDS.includes(value as OseroApiPublicAssetId)
  );
}

function isOseroApiCounterAssetId(value: unknown): value is OseroApiCounterAssetId {
  return (
    typeof value === 'string' &&
    OSERO_API_COUNTER_ASSET_IDS.includes(value as OseroApiCounterAssetId)
  );
}

function isSupportedApiSwapPair(
  fromAssetId: OseroApiPublicAssetId,
  toAssetId: OseroApiPublicAssetId,
): boolean {
  return (
    (isOseroApiCounterAssetId(fromAssetId) && toAssetId === OSERO_API_SUSDS_ASSET_ID) ||
    (fromAssetId === OSERO_API_SUSDS_ASSET_ID && isOseroApiCounterAssetId(toAssetId))
  );
}

function isOseroApiBridgeProtocol(value: string): value is OseroApiBridgeProtocol {
  return OSERO_API_BRIDGE_PROTOCOLS.includes(value as OseroApiBridgeProtocol);
}

function isTransactionHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
