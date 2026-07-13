import {
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  type Address,
  type DecodeFunctionDataReturnType,
  type Hex,
  type PublicClient,
} from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { prepareAllowanceWithPublicClient } from './allowance.js';
import {
  type ApprovalPolicy,
  type Referral,
  parseSlippage,
  referral as createReferral,
  type Slippage,
  UINT256_MAX,
} from './domain.js';
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  CancelError,
  ConfigurationError,
  InsufficientAllowanceError,
  RpcError,
  TimeoutError,
  UnexpectedError,
  ValidationError,
} from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import { referralCodeForApi } from './referrals.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import type { ExecutionPlan } from './types.js';

export const DEFAULT_OSERO_API_BASE_URL = 'https://api.osero.org/v1/';

export {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  CancelError,
  ConfigurationError,
  InsufficientAllowanceError,
  OSERO_API_ERROR_CODES,
  RpcError,
  TimeoutError,
  ValidationError,
  type OseroApiErrorCode,
} from './errors.js';

/**
 * Chains known to this SDK release, as an advisory snapshot.
 *
 * The hosted API is authoritative: it may serve chains that are not listed
 * here, and responses referencing unknown chains decode normally. This
 * snapshot only powers editor autocomplete (via {@link OseroApiKnownChainId}
 * and {@link OseroApiKnownChainKey}) and offline UI hints — no request or
 * response is ever validated against it.
 */
export const OSERO_API_KNOWN_CHAINS = [
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
 * Swap assets known to this SDK release, as an advisory snapshot.
 *
 * The hosted API is authoritative: call
 * {@link OseroApiClient.getSupportedAssets} for the live list. Assets the
 * API adds after this SDK release work end-to-end without an SDK update —
 * requests pass arbitrary asset refs through, and responses referencing
 * unknown assets decode normally. This snapshot only powers editor
 * autocomplete (via {@link OseroApiKnownAssetId}) and offline UI hints —
 * no request or response is ever validated against it.
 */
export const OSERO_API_KNOWN_ASSETS = [
  // USDC — native Circle issuance (6 decimals).
  { assetId: 'base:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'arbitrum:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'optimism:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'linea:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'ethereum:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'avalanche_c:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'hyperevm:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'monad:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'polygon:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  { assetId: 'unichain:usdc', symbol: 'USDC', decimals: 6, kind: 'counter' },
  // USDC.e — canonical bridged USDC on Berachain (6 decimals).
  { assetId: 'berachain:usdce', symbol: 'USDC.e', decimals: 6, kind: 'counter' },
  // USDe — Ethena synthetic dollar (18 decimals).
  { assetId: 'ethereum:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'arbitrum:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'base:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'optimism:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'linea:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'avalanche_c:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'bnb:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'berachain:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'hyperevm:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  { assetId: 'plasma:usde', symbol: 'USDe', decimals: 18, kind: 'counter' },
  // Ethereum-native stablecoins and Sky assets.
  { assetId: 'ethereum:ausd', symbol: 'AUSD', decimals: 6, kind: 'counter' },
  { assetId: 'ethereum:gho', symbol: 'GHO', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:pyusd', symbol: 'PYUSD', decimals: 6, kind: 'counter' },
  { assetId: 'arbitrum:pyusd', symbol: 'PYUSD', decimals: 6, kind: 'counter' },
  { assetId: 'ethereum:rlusd', symbol: 'RLUSD', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:usdd', symbol: 'USDD', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:usdg', symbol: 'USDG', decimals: 6, kind: 'counter' },
  { assetId: 'ethereum:usdt', symbol: 'USDT', decimals: 6, kind: 'counter' },
  { assetId: 'ethereum:usdtb', symbol: 'USDtb', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:frxusd', symbol: 'frxUSD', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:usds', symbol: 'USDS', decimals: 18, kind: 'counter' },
  { assetId: 'ethereum:susds', symbol: 'sUSDS', decimals: 18, kind: 'vault' },
] as const;

/**
 * Bridge protocols known to this SDK release, as an advisory snapshot.
 * The API may adopt new protocols at any time; they decode and re-encode
 * through status polling without an SDK update.
 */
export const OSERO_API_KNOWN_BRIDGE_PROTOCOLS = ['ccip', 'layerzero', 'relay', 'stargate'] as const;

export type OseroApiKnownAsset = (typeof OSERO_API_KNOWN_ASSETS)[number];
export type OseroApiKnownChain = (typeof OSERO_API_KNOWN_CHAINS)[number];
export type OseroApiKnownAssetId = OseroApiKnownAsset['assetId'];
export type OseroApiKnownChainId = OseroApiKnownChain['chainId'];
export type OseroApiKnownChainKey = OseroApiKnownChain['chainKey'];
export type OseroApiKnownBridgeProtocol = (typeof OSERO_API_KNOWN_BRIDGE_PROTOCOLS)[number];

export const OSERO_API_KNOWN_ASSET_IDS: readonly OseroApiKnownAssetId[] =
  OSERO_API_KNOWN_ASSETS.map((asset) => asset.assetId);
export const OSERO_API_KNOWN_CHAIN_IDS: readonly OseroApiKnownChainId[] =
  OSERO_API_KNOWN_CHAINS.map((chain) => chain.chainId);

/**
 * Widened identifier and vocabulary types.
 *
 * Each pairs the known literals (for autocomplete and narrowing) with an
 * open tail — `(string & {})` / `(number & {})` — so values the API adds
 * after this SDK release remain representable. Never exhaustively `switch`
 * on these without a `default` arm.
 */
export type OseroApiAssetId = OseroApiKnownAssetId | (string & {});
export type OseroApiChainId = OseroApiKnownChainId | (number & {});
export type OseroApiChainKey = OseroApiKnownChainKey | (string & {});
export type OseroApiBridgeProtocol = OseroApiKnownBridgeProtocol | (string & {});
export type OseroApiAssetKind = 'counter' | 'vault' | (string & {});
export type OseroApiSwapDirection = 'to-susds' | 'from-susds' | 'swap' | (string & {});
export type OseroApiSwapExecutionKind = 'same-chain' | 'cross-chain' | (string & {});
export type OseroApiBridgeState = 'pending' | 'completed' | 'failed' | 'unknown' | (string & {});
export type OseroApiBridgeProviderStatus =
  | 'pending'
  | 'inflight'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | (string & {});

export type OseroApiUsdsAssetId = 'ethereum:usds';
export type OseroApiSusdsAssetId = 'ethereum:susds';

export const OSERO_API_USDS_ASSET_ID: OseroApiUsdsAssetId = 'ethereum:usds';
export const OSERO_API_SUSDS_ASSET_ID: OseroApiSusdsAssetId = 'ethereum:susds';

/**
 * Informational constants describing current hosted API conventions. They
 * are not enforced client-side: the API is the authority and its answers
 * (401 for a bad key, 400 for a bad field, and a stable `code` when
 * available) are the contract. Kept exported for docs, tooling, and UI hints.
 */
export const OSERO_API_KEY_PREFIX = 'osero_';
export const OSERO_API_KEY_MAX_LENGTH = 256;
export const OSERO_API_REFERRAL_CODE_MIN = 3000;
export const OSERO_API_REFERRAL_CODE_MAX = 3999;
export type OseroApiIntegerString = `${bigint}`;

export type OseroApiInputAmount = {
  readonly raw: bigint;
};

export function oseroApiAmount(raw: bigint): Result<OseroApiInputAmount, ValidationError> {
  if (typeof raw !== 'bigint' || raw <= 0n || raw > UINT256_MAX) {
    return err(
      ValidationError.forField('raw', 'hosted API amount must be a positive uint256 bigint'),
    );
  }
  return ok(Object.freeze({ raw }));
}

/**
 * A chain-scoped ERC-20 reference for tokens without a known Osero asset
 * id. Encodes on the wire as `"<chainId>:<0xaddress>"`; the API resolves
 * it to a canonical asset id (and echoes the canonical id back) when the
 * token is supported.
 */
export type OseroApiAssetLocator = {
  readonly chainId: OseroApiChainId;
  readonly address: Address;
};

/**
 * Anything that can identify a swap asset in a request: a canonical asset
 * id (`'ethereum:usdc'` — known ids autocomplete, arbitrary ids pass
 * through to the API), an address-form string (`'8453:0x8335…2913'`), or a
 * structured {@link OseroApiAssetLocator}. The hosted API is the sole
 * authority on which refs are supported; unsupported refs come back as an
 * {@link ApiRequestError} with `code: 'SWAP_ASSET_NOT_SUPPORTED'`.
 */
export type OseroApiAssetRef = OseroApiAssetId | OseroApiAssetLocator;

export type OseroApiSwapQuoteRequest = {
  readonly fromAddress: Address;
  readonly fromAssetId: OseroApiAssetRef;
  readonly toAssetId: OseroApiAssetRef;
  readonly amount: OseroApiInputAmount;
  readonly slippage?: Slippage;
  readonly referral?: Referral;
  readonly approvalPolicy?: ApprovalPolicy;
};

export type OseroApiSwapStatusRequest = {
  readonly txHash: Hex;
  readonly sourceChainId: OseroApiChainId;
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

export type OseroApiKeyProvider = () => string | Promise<string>;
export type OseroApiPublicClient = Pick<PublicClient, 'chain' | 'getBlockNumber' | 'readContract'>;
export type OseroApiPublicClientProvider = (
  chainId: OseroApiChainId,
) => OseroApiPublicClient | Promise<OseroApiPublicClient>;

export type OseroApiFetch = typeof globalThis.fetch;

export type OseroApiClientConfig = {
  readonly apiKey?: string;
  readonly apiKeyProvider?: OseroApiKeyProvider;
  readonly publicClientProvider?: OseroApiPublicClientProvider;
  readonly baseUrl?: string | URL;
  readonly fetch?: OseroApiFetch;
};

export type OseroApiClientError =
  | ValidationError
  | ConfigurationError
  | ApiRequestError
  | ApiTransportError
  | ApiResponseError
  | InsufficientAllowanceError
  | RpcError
  | CancelError
  | TimeoutError
  | UnexpectedError;

export type OseroApiSwapAsset = {
  readonly assetId: OseroApiAssetId;
  readonly chainId: OseroApiChainId;
  readonly chainKey: OseroApiChainKey;
  readonly chainName: string;
  readonly chainShortName: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly address: Address;
  readonly label: string;
};

export type OseroApiSupportedAsset = OseroApiSwapAsset & {
  readonly kind: OseroApiAssetKind;
};

export type OseroApiSupportedAssetsResponse = {
  readonly assets: readonly OseroApiSupportedAsset[];
};

/**
 * Find the live supported asset matching an {@link OseroApiAssetRef}, or
 * `undefined` when the API does not list it. A pure lookup over the
 * response of {@link OseroApiClient.getSupportedAssets} — the SDK never
 * calls this internally and never gates requests on it; it exists so UIs
 * can pre-flight ("is this token supported?") against live data instead
 * of a shipped snapshot.
 */
export function matchOseroApiAsset(
  assets: readonly OseroApiSupportedAsset[],
  ref: OseroApiAssetRef,
): OseroApiSupportedAsset | undefined {
  if (typeof ref === 'string') {
    const byId = assets.find((asset) => asset.assetId === ref);
    if (byId) {
      return byId;
    }
    const locator = parseAssetLocatorString(ref);
    return locator ? matchByLocator(assets, locator) : undefined;
  }
  return matchByLocator(assets, ref);
}

function matchByLocator(
  assets: readonly OseroApiSupportedAsset[],
  locator: { readonly chainId: number; readonly address: string },
): OseroApiSupportedAsset | undefined {
  const address = locator.address.toLowerCase();
  return assets.find(
    (asset) => asset.chainId === locator.chainId && asset.address.toLowerCase() === address,
  );
}

function parseAssetLocatorString(
  value: string,
): { readonly chainId: number; readonly address: string } | undefined {
  const separator = value.indexOf(':');
  if (separator === -1) {
    return undefined;
  }
  const head = value.slice(0, separator);
  const tail = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/.test(head) || !isAddress(tail, { strict: false })) {
    return undefined;
  }
  const chainId = Number(head);
  return Number.isSafeInteger(chainId) ? { chainId, address: tail } : undefined;
}

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
  readonly sourceChainId: OseroApiChainId;
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
  readonly sourceChainId: OseroApiChainId;
  readonly destinationChainId: OseroApiChainId;
  readonly transaction: OseroApiSwapTransaction;
  readonly route: readonly OseroApiSwapRouteHop[];
};

/**
 * Discriminated on `required`. A bridge-tracked quote (`required: true`)
 * always carries a non-null `protocol` + `statusRequest` — the decoder
 * enforces this because {@link OseroApiClient.getSwapStatusForQuote}
 * relies on the narrowing. When `required` is `false` the fields are
 * `null` today; the decoder tolerates future non-null informational
 * values rather than failing.
 */
export type OseroApiSwapBridge =
  | {
      readonly required: true;
      readonly protocol: OseroApiBridgeProtocol;
      readonly statusRequest: OseroApiSwapBridgeStatusRequest;
    }
  | {
      readonly required: false;
      readonly protocol: OseroApiBridgeProtocol | null;
      readonly statusRequest: OseroApiSwapBridgeStatusRequest | null;
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
  readonly executionPlan: ExecutionPlan;
};

export type OseroApiSwapStatusBridge = {
  readonly protocol: OseroApiBridgeProtocol;
  readonly state: OseroApiBridgeState;
  readonly providerStatus: OseroApiBridgeProviderStatus;
  readonly sourceChainId: OseroApiChainId;
  readonly destinationChainId: OseroApiChainId | null;
  readonly sourceTxHash: Hex;
  readonly destinationTxHash: Hex | null;
  readonly error: string | null;
};

export type OseroApiSwapStatusResponse = {
  readonly bridge: OseroApiSwapStatusBridge;
};

export type OseroApiSwapCompletion = {
  readonly state: OseroApiBridgeState;
  readonly providerStatus: OseroApiBridgeProviderStatus;
  readonly sourceTxHash: Hex;
  readonly destinationTxHash: Hex | null;
  readonly status: OseroApiSwapStatusResponse;
};

export type WaitForSwapCompletionOptions = OseroApiRequestOptions & {
  readonly pollingIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly onStatus?: (status: OseroApiSwapStatusResponse) => void | Promise<void>;
};

type OseroApiSwapQuoteBody = {
  readonly fromAddress: Address;
  readonly fromAssetId: string;
  readonly toAssetId: string;
  readonly amount: OseroApiIntegerString;
  readonly slippage?: string;
  readonly referralCode?: number;
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
 *
 * Validation philosophy: the client checks wire grammar and execution
 * safety (addresses, hex payloads, integer bounds) and its own response
 * contract, while the hosted API is the sole authority on supported
 * assets, pairs, and policy limits. Requests the API would accept are
 * never rejected locally, and responses containing assets, chains,
 * protocols, kinds, directions, or states unknown to this SDK release
 * decode normally.
 */
export class OseroApiClient {
  readonly baseUrl: string;

  readonly #apiKey?: string;
  readonly #apiKeyProvider?: OseroApiKeyProvider;
  readonly #publicClientProvider?: OseroApiPublicClientProvider;
  readonly #baseUrl: URL;
  readonly #fetch: OseroApiFetch;

  constructor(config: OseroApiClientConfig = {}) {
    if (typeof config !== 'object' || config === null) {
      throw new ConfigurationError('API client configuration must be an object');
    }
    if (config.apiKey !== undefined) {
      const apiKey = resolveApiKey(config.apiKey);
      if (apiKey.isErr()) {
        throw new ConfigurationError(apiKey.error.message, 'apiKey', { cause: apiKey.error });
      }
      this.#apiKey = apiKey.value;
    }
    if (config.apiKeyProvider !== undefined && typeof config.apiKeyProvider !== 'function') {
      throw new ConfigurationError('apiKeyProvider must be a function', 'apiKeyProvider');
    }
    if (
      config.publicClientProvider !== undefined &&
      typeof config.publicClientProvider !== 'function'
    ) {
      throw new ConfigurationError(
        'publicClientProvider must be a function',
        'publicClientProvider',
      );
    }
    this.#apiKeyProvider = config.apiKeyProvider;
    this.#publicClientProvider = config.publicClientProvider;
    this.#baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_OSERO_API_BASE_URL);
    this.#fetch = resolveFetch(config.fetch);
    this.baseUrl = this.#baseUrl.toString();
  }

  static create(config: OseroApiClientConfig = {}): OseroApiClient {
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
    if (body.isErr()) return errAsync(body.error);
    if (this.#publicClientProvider === undefined) {
      return errAsync(
        new ConfigurationError(
          'getSwapQuote requires publicClientProvider for allowance-aware preparation',
          'publicClientProvider',
        ),
      );
    }

    return this.requestJson({
      method: 'POST',
      path: 'swap/quote',
      body: body.value,
      options,
      decoder: (value) =>
        decodeSwapQuoteResponse(value, {
          fromAddress: body.value.fromAddress,
          amount: body.value.amount,
        }),
    }).andThen((response) => this.prepareHostedPlan(response, request.approvalPolicy ?? 'exact'));
  }

  getSwapStatus(
    request: OseroApiSwapStatusRequest,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSwapStatusResponse, OseroApiClientError> {
    const query = encodeSwapStatusRequest(request);
    if (query.isErr()) return errAsync(query.error);
    return this.requestJson({
      method: 'GET',
      path: query.value,
      options,
      decoder: decodeSwapStatusResponse,
    });
  }

  getSwapStatusForQuote(
    quote: OseroApiSwapQuoteResponse,
    txHash: Hex,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiSwapStatusResponse, OseroApiClientError> {
    if (!quote.bridge.required) {
      return errAsync(
        ValidationError.forField(
          'quote',
          'quote is same-chain; no bridge completion status exists',
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

  waitForSwapCompletion(
    quote: OseroApiSwapQuoteResponse,
    txHash: Hex,
    options: WaitForSwapCompletionOptions = {},
  ): ResultAsync<OseroApiSwapCompletion, OseroApiClientError> {
    if (!quote.bridge.required) {
      return errAsync(
        ValidationError.forField('quote', 'waitForSwapCompletion requires a cross-chain quote'),
      );
    }
    const statusRequest = quote.bridge.statusRequest;
    if (!isTransactionHash(txHash)) {
      return errAsync(ValidationError.forField('txHash', 'txHash must be a 32-byte hex string'));
    }
    const pollingIntervalMs = options.pollingIntervalMs ?? 5_000;
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
    if (!Number.isSafeInteger(pollingIntervalMs) || pollingIntervalMs <= 0) {
      return errAsync(
        ValidationError.forField(
          'pollingIntervalMs',
          'pollingIntervalMs must be a positive safe integer',
        ),
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return errAsync(
        ValidationError.forField('timeoutMs', 'timeoutMs must be a positive safe integer'),
      );
    }
    if (options.onStatus !== undefined && typeof options.onStatus !== 'function') {
      return errAsync(ValidationError.forField('onStatus', 'onStatus must be a function'));
    }

    const wait = async (): Promise<Result<OseroApiSwapCompletion, OseroApiClientError>> => {
      const startedAt = Date.now();
      let previousStatus: string | undefined;
      // oxlint-disable no-await-in-loop -- Polls and callbacks are intentionally serialized.
      while (true) {
        if (options.signal?.aborted) {
          return err(CancelError.from(options.signal.reason));
        }
        const elapsed = Date.now() - startedAt;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) return err(new TimeoutError('waitForSwapCompletion', timeoutMs));

        const controller = new AbortController();
        let requestTimedOut = false;
        const timeout = setTimeout(() => {
          requestTimedOut = true;
          controller.abort(new TimeoutError('waitForSwapCompletion', timeoutMs));
        }, remaining);
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        const status = await this.getSwapStatus(
          {
            txHash,
            sourceChainId: statusRequest.sourceChainId,
            bridgeProtocol: statusRequest.bridgeProtocol,
          },
          {
            ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
            signal: controller.signal,
          },
        );
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        if (status.isErr()) {
          if (requestTimedOut) return err(new TimeoutError('waitForSwapCompletion', timeoutMs));
          return err(status.error);
        }

        const fingerprint = JSON.stringify(status.value);
        if (fingerprint !== previousStatus) {
          previousStatus = fingerprint;
          if (options.onStatus !== undefined) {
            try {
              await options.onStatus(status.value);
            } catch (cause) {
              return err(new ConfigurationError('onStatus callback failed', 'onStatus', { cause }));
            }
          }
        }

        if (status.value.bridge.state === 'completed' || status.value.bridge.state === 'failed') {
          return ok({
            state: status.value.bridge.state,
            providerStatus: status.value.bridge.providerStatus,
            sourceTxHash: status.value.bridge.sourceTxHash,
            destinationTxHash: status.value.bridge.destinationTxHash,
            status: status.value,
          });
        }

        const remainingBeforeSleep = timeoutMs - (Date.now() - startedAt);
        if (remainingBeforeSleep <= 0) {
          return err(new TimeoutError('waitForSwapCompletion', timeoutMs));
        }
        const delay = Math.min(pollingIntervalMs, remainingBeforeSleep);
        const slept = await sleep(delay, options.signal);
        if (slept.isErr()) return err(slept.error);
      }
      // oxlint-enable no-await-in-loop
    };
    return new ResultAsync(wait());
  }

  private prepareHostedPlan(
    response: OseroApiSwapQuoteResponse,
    approvalPolicy: ApprovalPolicy,
  ): ResultAsync<OseroApiSwapQuote, OseroApiClientError> {
    if (approvalPolicy !== 'exact' && approvalPolicy !== 'max' && approvalPolicy !== 'none') {
      return errAsync(
        ValidationError.forField('approvalPolicy', 'approvalPolicy must be exact, max, or none'),
      );
    }
    const provider = this.#publicClientProvider;
    if (provider === undefined) {
      return errAsync(
        new ConfigurationError('publicClientProvider is not configured', 'publicClientProvider'),
      );
    }

    const preparation = async (): Promise<Result<OseroApiSwapQuote, OseroApiClientError>> => {
      const publicClient = await ResultAsync.fromPromise(
        Promise.resolve().then(() => provider(response.execution.sourceChainId)),
        (cause) =>
          new ConfigurationError(
            `publicClientProvider failed for chain ${response.execution.sourceChainId}`,
            'publicClientProvider',
            { cause },
          ),
      );
      if (publicClient.isErr()) return err(publicClient.error);
      if (publicClient.value.chain?.id !== response.execution.sourceChainId) {
        return err(
          new ConfigurationError(
            'publicClientProvider returned a client for the wrong source chain',
            'publicClientProvider',
          ),
        );
      }
      const block = await ResultAsync.fromPromise(publicClient.value.getBlockNumber(), (cause) =>
        RpcError.from({
          cause,
          operation: 'getBlockNumber',
          chainId: response.execution.sourceChainId,
        }),
      );
      if (block.isErr()) return err(block.error);

      const approvalGas =
        response.approval.gas === null
          ? undefined
          : {
              gas: BigInt(response.approval.gas),
              source: 'hosted-api' as const,
            };
      const allowance = await prepareAllowanceWithPublicClient(publicClient.value, {
        stepId: 'approve-input-token',
        chainId: response.execution.sourceChainId,
        token: response.approval.token.address,
        owner: response.execution.transaction.from,
        spender: response.approval.spender,
        requiredAmount: BigInt(response.approval.amount.raw),
        policy: approvalPolicy,
        blockNumber: block.value,
        ...(approvalGas === undefined || approvalGas.gas === 0n
          ? {}
          : { estimatedGas: approvalGas }),
      });
      if (allowance.isErr()) return err(allowance.error);

      const execution = createTransactionRequest({
        id: 'execute-swap',
        chainId: response.execution.sourceChainId,
        from: response.execution.transaction.from,
        to: response.execution.transaction.to,
        data: response.execution.transaction.data,
        value: BigInt(response.execution.transaction.value),
        operation: 'SWAP_EXACT_IN',
        ...(response.quote.gas === null || BigInt(response.quote.gas) === 0n
          ? {}
          : {
              estimatedGas: {
                gas: BigInt(response.quote.gas),
                source: 'hosted-api',
              },
            }),
      });
      if (execution.isErr()) return err(execution.error);
      const plan = createExecutionPlan({
        steps: allowance.value.approval
          ? [allowance.value.approval, execution.value]
          : [execution.value],
        metadata: {
          source: 'hosted-api',
          allowanceSnapshots: [allowance.value.snapshot],
        },
      });
      if (plan.isErr()) return err(plan.error);
      return ok({ ...response, executionPlan: plan.value });
    };
    return new ResultAsync(preparation());
  }

  private requestJson<T>({
    method,
    path,
    body,
    options,
    decoder,
  }: RequestJsonArgs<T>): ResultAsync<T, OseroApiClientError> {
    const request = async (): Promise<Result<T, OseroApiClientError>> => {
      if (options?.signal?.aborted) return err(CancelError.from(options.signal.reason));
      let apiKeyValue: string | undefined = options?.apiKey;
      if (apiKeyValue === undefined && this.#apiKeyProvider !== undefined) {
        const provided = await ResultAsync.fromPromise(
          Promise.resolve().then(() => this.#apiKeyProvider!()),
          (cause) => new ConfigurationError('apiKeyProvider failed', 'apiKeyProvider', { cause }),
        );
        if (provided.isErr()) return err(provided.error);
        apiKeyValue = provided.value;
      }
      apiKeyValue ??= this.#apiKey;
      if (apiKeyValue === undefined) {
        return err(
          ValidationError.forField(
            'apiKey',
            'provide an API key per request, as a default, or through apiKeyProvider',
          ),
        );
      }
      const apiKey = resolveApiKey(apiKeyValue);
      if (apiKey.isErr()) return err(apiKey.error);

      const url = new URL(path, this.#baseUrl);
      const init: RequestInit = {
        method,
        headers: {
          accept: 'application/json',
          'x-api-key': apiKey.value,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      };

      const response = await ResultAsync.fromPromise(this.#fetch(url, init), (cause) =>
        isAbortFailure(cause, options?.signal)
          ? CancelError.from(cause)
          : ApiTransportError.from(cause, url.toString(), method),
      );
      if (response.isErr()) return err(response.error);
      const text = await ResultAsync.fromPromise(response.value.text(), (cause) =>
        isAbortFailure(cause, options?.signal)
          ? CancelError.from(cause)
          : ApiTransportError.from(cause, url.toString(), method),
      );
      if (text.isErr()) return err(text.error);

      const parsed = parseJsonBody(text.value);
      const responseBody = parsed.isOk() ? parsed.value : text.value;
      const headers = Object.fromEntries(response.value.headers.entries());
      if (!response.value.ok) {
        const metadata = extractApiResponseMetadata(responseBody, headers);
        return err(
          new ApiRequestError({
            url: url.toString(),
            method,
            statusCode: response.value.status,
            statusText: response.value.statusText,
            body: responseBody,
            headers,
            ...metadata,
            ...(parsed.isErr() ? { cause: parsed.error } : {}),
          }),
        );
      }
      if (parsed.isErr()) {
        return err(ApiResponseError.from(parsed.error, url.toString(), method));
      }
      const decoded = decoder(parsed.value);
      if (decoded.isErr()) {
        return err(ApiResponseError.from(decoded.error, url.toString(), method));
      }
      return ok(decoded.value);
    };
    return new ResultAsync(request());
  }
}

function isAbortFailure(cause: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError'))
  );
}

function sleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<Result<void, CancelError>> {
  if (signal?.aborted) return Promise.resolve(err(CancelError.from(signal.reason)));
  const { promise, resolve } = Promise.withResolvers<Result<void, CancelError>>();
  const complete = () => {
    signal?.removeEventListener('abort', abort);
    resolve(ok(undefined));
  };
  const timer = setTimeout(complete, milliseconds);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    resolve(err(CancelError.from(signal?.reason)));
  };
  signal?.addEventListener('abort', abort, { once: true });
  return promise;
}

type ApiResponseMetadata = {
  readonly apiCode?: string;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;
};

function extractApiResponseMetadata(
  body: unknown,
  headers: Readonly<Record<string, string>>,
): ApiResponseMetadata {
  const bodyRecord =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  const apiCode = typeof bodyRecord?.code === 'string' ? bodyRecord.code : undefined;
  const correlationId =
    headers['x-correlation-id'] ??
    headers['x-request-id'] ??
    (typeof bodyRecord?.correlationId === 'string' ? bodyRecord.correlationId : undefined);
  const retryAfter = headers['retry-after'];
  let retryAfterMs: number | undefined;
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      retryAfterMs = seconds * 1_000;
    } else {
      const timestamp = Date.parse(retryAfter);
      if (Number.isFinite(timestamp)) retryAfterMs = Math.max(0, timestamp - Date.now());
    }
  }
  return {
    ...(apiCode === undefined ? {} : { apiCode }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function normalizeBaseUrl(baseUrl: string | URL): URL {
  try {
    const url = new URL(baseUrl.toString());
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  } catch (cause) {
    throw new ConfigurationError('baseUrl must be a valid absolute URL', 'baseUrl', { cause });
  }
}

function resolveFetch(fetchOverride: OseroApiFetch | undefined): OseroApiFetch {
  if (fetchOverride !== undefined) {
    if (typeof fetchOverride !== 'function') {
      throw new ConfigurationError('fetch must be a standard fetch-compatible function', 'fetch');
    }
    return fetchOverride;
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new ConfigurationError(
      'No fetch implementation is available; pass fetch to OseroApiClient.create()',
      'fetch',
    );
  }
  return globalThis.fetch;
}

/**
 * The API is the authority on key validity (bad keys get a 401). The
 * client only admits non-empty printable ASCII values that can travel
 * unchanged in an HTTP header.
 */
function resolveApiKey(apiKey: string): Result<string, ValidationError> {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7E]+$/.test(apiKey)) {
    return err(
      ValidationError.forField('apiKey', 'apiKey must be a non-empty printable ASCII string'),
    );
  }
  return ok(apiKey);
}

function encodeSwapQuoteRequest(
  request: OseroApiSwapQuoteRequest,
): Result<OseroApiSwapQuoteBody, ValidationError> {
  if (typeof request !== 'object' || request === null) {
    return err(ValidationError.forField('request', 'quote request must be an object'));
  }
  if (!isAddress(request.fromAddress)) {
    return err(ValidationError.forField('fromAddress', 'fromAddress must be an EVM address'));
  }
  const fromAssetId = encodeAssetRef(request.fromAssetId, 'fromAssetId');
  if (fromAssetId.isErr()) return err(fromAssetId.error);
  const toAssetId = encodeAssetRef(request.toAssetId, 'toAssetId');
  if (toAssetId.isErr()) return err(toAssetId.error);
  if (
    typeof request.amount !== 'object' ||
    request.amount === null ||
    typeof request.amount.raw !== 'bigint' ||
    request.amount.raw <= 0n ||
    request.amount.raw > UINT256_MAX
  ) {
    return err(
      ValidationError.forField(
        'amount',
        'amount must be created with oseroApiAmount and fit within uint256',
      ),
    );
  }

  let slippage: Slippage | undefined;
  if (request.slippage !== undefined) {
    if (typeof request.slippage !== 'object' || request.slippage === null) {
      return err(
        ValidationError.forField('slippage', 'slippage must be created with parseSlippage'),
      );
    }
    const validated = parseSlippage(request.slippage.bps);
    if (validated.isErr()) return err(validated.error);
    slippage = validated.value;
  }

  const configuredReferral = request.referral ?? false;
  if (configuredReferral !== false) {
    if (typeof configuredReferral !== 'object' || configuredReferral === null) {
      return err(
        ValidationError.forField('referral', 'referral must be false or created with referral()'),
      );
    }
    const validated = createReferral(configuredReferral.code);
    if (validated.isErr()) return err(validated.error);
  }
  const referralCode = referralCodeForApi(configuredReferral);
  if (referralCode.isErr()) return err(referralCode.error);
  if (
    request.approvalPolicy !== undefined &&
    request.approvalPolicy !== 'exact' &&
    request.approvalPolicy !== 'max' &&
    request.approvalPolicy !== 'none'
  ) {
    return err(
      ValidationError.forField('approvalPolicy', 'approvalPolicy must be exact, max, or none'),
    );
  }

  return ok({
    fromAddress: getAddress(request.fromAddress),
    fromAssetId: fromAssetId.value,
    toAssetId: toAssetId.value,
    amount: request.amount.raw.toString() as OseroApiIntegerString,
    ...(slippage === undefined ? {} : { slippage: slippage.bps }),
    ...(referralCode.value === undefined ? {} : { referralCode: referralCode.value }),
  });
}

/**
 * Serialize an {@link OseroApiAssetRef} for the wire. String refs pass
 * through untouched — the API decides whether they are supported. Locators
 * are checked for serializability only (positive chain id, well-formed
 * address) and canonicalized to `"<chainId>:<lowercase address>"`.
 */
function encodeAssetRef(ref: OseroApiAssetRef, field: string): Result<string, ValidationError> {
  if (typeof ref === 'string') {
    if (ref.trim().length === 0) {
      return err(ValidationError.forField(field, `${field} must be a non-empty asset ref`));
    }
    return ok(ref);
  }

  if (typeof ref !== 'object' || ref === null) {
    return err(
      ValidationError.forField(
        field,
        `${field} must be an asset id string or a { chainId, address } locator`,
      ),
    );
  }
  if (!Number.isSafeInteger(ref.chainId) || ref.chainId <= 0) {
    return err(
      ValidationError.forField(field, `${field}.chainId must be a positive integer chain id`),
    );
  }
  if (!isAddress(ref.address)) {
    return err(ValidationError.forField(field, `${field}.address must be an EVM address`));
  }
  return ok(`${ref.chainId}:${ref.address.toLowerCase()}`);
}

function encodeSwapStatusRequest(
  request: OseroApiSwapStatusRequest,
): Result<string, ValidationError> {
  if (typeof request !== 'object' || request === null) {
    return err(ValidationError.forField('request', 'status request must be an object'));
  }
  if (!isTransactionHash(request.txHash)) {
    return err(ValidationError.forField('txHash', 'txHash must be a 32-byte hex string'));
  }
  if (!Number.isSafeInteger(request.sourceChainId) || request.sourceChainId <= 0) {
    return err(
      ValidationError.forField('sourceChainId', 'sourceChainId must be a positive integer'),
    );
  }
  if (typeof request.bridgeProtocol !== 'string' || request.bridgeProtocol.trim().length === 0) {
    return err(
      ValidationError.forField('bridgeProtocol', 'bridgeProtocol must be a non-empty string'),
    );
  }
  const search = new URLSearchParams({
    sourceChainId: String(request.sourceChainId),
    bridgeProtocol: request.bridgeProtocol,
  });
  return ok(`swap/status/${request.txHash}?${search.toString()}`);
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
  expected: {
    readonly fromAddress: Address;
    readonly amount: OseroApiIntegerString;
  },
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
    assertSwapQuoteInvariants(response, expected);
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

function assertSwapQuoteInvariants(
  response: OseroApiSwapQuoteResponse,
  expected: {
    readonly fromAddress: Address;
    readonly amount: OseroApiIntegerString;
  },
): void {
  const { approval, bridge, execution, quote } = response;
  if (!isAddressEqual(approval.transaction.to, approval.token.address)) {
    throw new DecodeError('$.approval.transaction.to must match $.approval.token.address');
  }
  if (approval.transaction.value !== '0') {
    throw new DecodeError('$.approval.transaction.value must be 0');
  }
  if (approval.token.chainId !== execution.sourceChainId) {
    throw new DecodeError('$.approval.token.chainId must match $.execution.sourceChainId');
  }
  if (
    !isAddressEqual(approval.transaction.from, expected.fromAddress) ||
    !isAddressEqual(execution.transaction.from, expected.fromAddress)
  ) {
    throw new DecodeError('approval and execution senders must match the requested fromAddress');
  }
  if (quote.amountIn.raw !== expected.amount) {
    throw new DecodeError('$.quote.amountIn.raw must match the requested amount');
  }
  if (bridge.required && bridge.statusRequest.sourceChainId !== execution.sourceChainId) {
    throw new DecodeError(
      '$.bridge.statusRequest.sourceChainId must match $.execution.sourceChainId',
    );
  }

  let decoded: DecodeFunctionDataReturnType<typeof erc20Abi>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: approval.transaction.data });
  } catch (cause) {
    throw new DecodeError(
      `$.approval.transaction.data must encode ERC-20 approve: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    decoded.functionName !== 'approve' ||
    decoded.args[0] === undefined ||
    decoded.args[1] === undefined ||
    !isAddressEqual(decoded.args[0], approval.spender) ||
    decoded.args[1] !== BigInt(approval.amount.raw)
  ) {
    throw new DecodeError(
      '$.approval.transaction.data must match approve($.approval.spender, $.approval.amount.raw)',
    );
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
  return {
    ...decodeSwapAsset(record, path),
    kind: nonEmptyStringField(record, 'kind', `${path}.kind`),
  };
}

function decodeSwapPair(value: unknown, path: string): OseroApiSwapPair {
  const record = asRecord(value, path);
  return {
    direction: nonEmptyStringField(record, 'direction', `${path}.direction`),
    from: decodeSwapAsset(requiredField(record, 'from', `${path}.from`), `${path}.from`),
    to: decodeSwapAsset(requiredField(record, 'to', `${path}.to`), `${path}.to`),
  };
}

/**
 * Structural decode of an asset row. Identity vocabulary (assetId,
 * chainKey, symbol, kind) is not checked against any local registry —
 * the API may serve assets this SDK release has never heard of.
 */
function decodeSwapAsset(value: unknown, path: string): OseroApiSwapAsset {
  const record = asRecord(value, path);
  return {
    assetId: nonEmptyStringField(record, 'assetId', `${path}.assetId`),
    chainId: positiveChainIdField(record, 'chainId', `${path}.chainId`),
    chainKey: nonEmptyStringField(record, 'chainKey', `${path}.chainKey`),
    chainName: stringField(record, 'chainName', `${path}.chainName`),
    chainShortName: stringField(record, 'chainShortName', `${path}.chainShortName`),
    symbol: nonEmptyStringField(record, 'symbol', `${path}.symbol`),
    decimals: decimalsField(record, 'decimals', `${path}.decimals`),
    address: addressField(record, 'address', `${path}.address`),
    label: stringField(record, 'label', `${path}.label`),
  };
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
    kind: nonEmptyStringField(record, 'kind', `${path}.kind`),
    sourceChainId: positiveChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: positiveChainIdField(
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
  // Absent keys decode as null so a future API that omits bridge metadata
  // on same-chain quotes keeps decoding; the required:true arm below still
  // rejects missing metadata because getSwapStatusForQuote depends on it.
  const protocol =
    'protocol' in record
      ? nullableField(record, 'protocol', `${path}.protocol`, decodeNonEmptyString)
      : null;
  const statusRequest =
    'statusRequest' in record
      ? nullableField(
          record,
          'statusRequest',
          `${path}.statusRequest`,
          decodeSwapBridgeStatusRequest,
        )
      : null;

  if (required) {
    if (protocol === null) {
      throw new DecodeError(`${path}.protocol must not be null when bridge.required is true`);
    }
    if (statusRequest === null) {
      throw new DecodeError(`${path}.statusRequest must not be null when bridge.required is true`);
    }
    return { required: true, protocol, statusRequest };
  }

  return { required: false, protocol, statusRequest };
}

function decodeSwapBridgeStatusRequest(
  value: unknown,
  path: string,
): OseroApiSwapBridgeStatusRequest {
  const record = asRecord(value, path);
  return {
    sourceChainId: positiveChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    bridgeProtocol: nonEmptyStringField(record, 'bridgeProtocol', `${path}.bridgeProtocol`),
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
    protocol: nonEmptyStringField(record, 'protocol', `${path}.protocol`),
    state: nonEmptyStringField(record, 'state', `${path}.state`),
    providerStatus: nonEmptyStringField(record, 'providerStatus', `${path}.providerStatus`),
    sourceChainId: positiveChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: nullableField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
      decodePositiveChainId,
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

function nonEmptyStringField(record: Record<string, unknown>, field: string, path: string): string {
  return decodeNonEmptyString(requiredField(record, field, path), path);
}

function decodeNonEmptyString(value: unknown, path: string): string {
  const text = decodeString(value, path);
  if (text.length === 0) {
    throw new DecodeError(`${path} must be a non-empty string`);
  }
  return text;
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

/**
 * ERC-20 `decimals()` is a uint8, so 0–255 is the timeless bound. Any
 * value inside it decodes — the API may serve assets with decimals this
 * SDK has never seen (8, 2, 0, …).
 */
function decimalsField(record: Record<string, unknown>, field: string, path: string): number {
  const value = decodeNumber(requiredField(record, field, path), path);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new DecodeError(`${path} must be an integer between 0 and 255`);
  }
  return value;
}

function positiveChainIdField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): number {
  return decodePositiveChainId(requiredField(record, field, path), path);
}

function decodePositiveChainId(value: unknown, path: string): number {
  const chainId = decodeNumber(value, path);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new DecodeError(`${path} must be a positive integer chain id`);
  }
  return chainId;
}

function isTransactionHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
