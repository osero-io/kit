import {
  decodeFunctionData,
  formatUnits,
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
import { checkAllowanceWithPublicClient } from './allowance.js';
import {
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
  ApprovalLimitError,
  CancelError,
  ConfigurationError,
  InsufficientAllowanceError,
  ProgressCallbackError,
  QuoteRefreshLimitError,
  RpcError,
  TimeoutError,
  UnexpectedError,
  ValidationError,
} from './errors.js';
import type { HostedSwapProgressType } from './hostedSwap.js';
import {
  createExecutionPlan,
  createPreparedApprovalTransaction,
  createTransactionRequest,
} from './plan.js';
import { referralCodeForApi } from './referrals.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import type {
  ExecutionPlan,
  ExecutionPlanHandler,
  SendWithError,
  TransactionResult,
} from './types.js';
import { validateQuoteExpiry } from './validation.js';

export const DEFAULT_OSERO_API_BASE_URL = 'https://api.osero.org/v1/';
export const DEFAULT_APPROVAL_TRANSACTION_LIMIT = 3;
export const DEFAULT_QUOTE_REFRESH_LIMIT = 5;

export {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  ApprovalLimitError,
  CancelError,
  ConfigurationError,
  InsufficientAllowanceError,
  OSERO_API_ERROR_CODES,
  ProgressCallbackError,
  RpcError,
  QuoteRefreshLimitError,
  TimeoutError,
  ValidationError,
  type OseroApiErrorCode,
} from './errors.js';
export type { HostedSwapProgressType } from './hostedSwap.js';

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
export type OseroApiTransferState = 'pending' | 'completed' | 'failed' | 'unknown';

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
};

export type OseroApiTransferStatusRequest = {
  readonly sourceTransactionHash: Hex;
  readonly statusContext: OseroApiStatusContext;
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
): { readonly chainId: number; readonly address: Address } | undefined {
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
  return Number.isSafeInteger(chainId) ? { chainId, address: tail as Address } : undefined;
}

export type OseroApiSwapAmount = {
  readonly raw: OseroApiIntegerString;
  readonly formatted: string;
};

declare const unknownQuoteProviderBrand: unique symbol;

export type OseroApiUnknownQuoteProvider = string & {
  readonly [unknownQuoteProviderBrand]: true;
};

export type OseroApiQuoteProvider = 'enso' | 'lifi' | OseroApiUnknownQuoteProvider;
export type OseroApiReferralAttributionStatus = 'not-requested' | 'applied' | 'not-applied';

export type OseroApiSwapSlippage = {
  readonly bps: string;
  readonly percent: string;
};

export type OseroApiReferralAttribution = {
  readonly requestedCode: number | null;
  readonly status: OseroApiReferralAttributionStatus;
};

export type OseroApiPreparedTransaction = {
  readonly chainId: OseroApiChainId;
  readonly sender: Address;
  readonly recipient: Address;
  readonly calldata: Hex;
  readonly value: OseroApiIntegerString;
  readonly gasLimit: OseroApiIntegerString | null;
};

export type OseroApiApprovalStep = {
  readonly token: OseroApiSwapAsset;
  readonly spender: Address;
  readonly requiredAmount: OseroApiSwapAmount;
  readonly transaction: OseroApiPreparedTransaction;
};

export type OseroApiExecutionStep = {
  readonly transaction: OseroApiPreparedTransaction;
};

export type OseroApiExecutionPlan = {
  readonly approvalSteps: readonly OseroApiApprovalStep[];
  readonly executionStep: OseroApiExecutionStep;
};

export type OseroApiSwapPair = {
  readonly source: OseroApiSwapAsset;
  readonly destination: OseroApiSwapAsset;
};

export type OseroApiSwapQuoteEconomics = {
  readonly inputAmount: OseroApiSwapAmount;
  readonly expectedOutput: OseroApiSwapAmount;
  readonly minimumOutput: OseroApiSwapAmount | null;
  readonly slippage: OseroApiSwapSlippage;
  readonly referralAttribution: OseroApiReferralAttribution;
  readonly quotedAt: string;
  readonly expiresAt: string;
};

export type OseroApiRouteSummary = {
  readonly kind: 'same-chain' | 'cross-chain';
  readonly sourceChainId: OseroApiChainId;
  readonly destinationChainId: OseroApiChainId;
  readonly bridge: OseroApiBridgeProtocol | null;
};

export type OseroApiRefreshContext = {
  readonly provider: OseroApiQuoteProvider;
  readonly walletAddress: Address;
  readonly sourceAssetId: OseroApiAssetId;
  readonly destinationAssetId: OseroApiAssetId;
  readonly amount: OseroApiIntegerString;
  readonly slippage: OseroApiSwapSlippage;
  readonly referralCode: number | null;
};

export type OseroApiStatusContext = {
  readonly provider: OseroApiQuoteProvider;
  readonly sourceChainId: OseroApiChainId;
  readonly destinationChainId: OseroApiChainId;
  readonly bridge: OseroApiBridgeProtocol;
};

export type OseroApiEnsoRouteLabel = {
  readonly protocol: string;
  readonly action: string;
};

export type OseroApiEnsoProviderDetails = {
  readonly provider: 'enso';
  readonly route: readonly OseroApiEnsoRouteLabel[];
  readonly gasUnits: OseroApiIntegerString | null;
  readonly priceImpactBps: number | null;
  readonly simulationBlockNumber: number | null;
};

export type OseroApiLifiToken = {
  readonly chainId: OseroApiChainId;
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
};

export type OseroApiLifiFeeCost = {
  readonly name: string;
  readonly description: string | null;
  readonly amount: OseroApiIntegerString;
  readonly amountUsd: string | null;
  readonly percentage: string | null;
  readonly included: boolean;
  readonly token: OseroApiLifiToken;
};

export type OseroApiLifiGasCost = {
  readonly type: string;
  readonly price: OseroApiIntegerString;
  readonly estimate: OseroApiIntegerString;
  readonly limit: OseroApiIntegerString;
  readonly amount: OseroApiIntegerString;
  readonly amountUsd: string | null;
  readonly token: OseroApiLifiToken;
};

export type OseroApiLifiIncludedStep = {
  readonly id: string;
  readonly type: string;
  readonly tool: string;
};

export type OseroApiLifiStep = {
  readonly id: string;
  readonly type: string;
  readonly tool: string;
  readonly executionDurationSeconds: number | null;
  readonly feeCosts: readonly OseroApiLifiFeeCost[];
  readonly gasCosts: readonly OseroApiLifiGasCost[];
  readonly includedSteps: readonly OseroApiLifiIncludedStep[];
};

export type OseroApiLifiProviderDetails = {
  readonly provider: 'lifi';
  readonly routeId: string;
  readonly usesComposer: boolean;
  readonly gasCostUsd: string | null;
  readonly steps: readonly OseroApiLifiStep[];
};

export type OseroApiUnknownProviderDetails = Readonly<Record<string, unknown>> & {
  readonly provider: OseroApiUnknownQuoteProvider;
};

export type OseroApiQuoteProviderDetails =
  | OseroApiEnsoProviderDetails
  | OseroApiLifiProviderDetails
  | OseroApiUnknownProviderDetails;

export function isOseroApiEnsoProviderDetails(
  details: OseroApiQuoteProviderDetails,
): details is OseroApiEnsoProviderDetails {
  return details.provider === 'enso';
}

export function isOseroApiLifiProviderDetails(
  details: OseroApiQuoteProviderDetails,
): details is OseroApiLifiProviderDetails {
  return details.provider === 'lifi';
}

export type OseroApiSwapQuoteResponse = {
  readonly provider: OseroApiQuoteProvider;
  readonly pair: OseroApiSwapPair;
  readonly quote: OseroApiSwapQuoteEconomics;
  readonly routeSummary: OseroApiRouteSummary;
  readonly executionPlan: OseroApiExecutionPlan;
  readonly refreshContext: OseroApiRefreshContext;
  readonly statusContext: OseroApiStatusContext | null;
  readonly providerDetails: OseroApiQuoteProviderDetails;
};

export type OseroApiReadyToExecute = {
  readonly state: 'ready-to-execute';
  readonly quote: OseroApiSwapQuoteResponse;
  readonly walletExecutionPlan: ExecutionPlan;
};

export type OseroApiApprovalRequired = {
  readonly state: 'approval-required';
  readonly quote: OseroApiSwapQuoteResponse;
  readonly walletExecutionPlan: ExecutionPlan;
};

export type OseroApiHostedSwapWorkflow = OseroApiApprovalRequired | OseroApiReadyToExecute;

export type OseroApiEnsoTransferStatusProviderDetails = {
  readonly provider: 'enso';
  readonly status: string;
};

export type OseroApiLifiTransferStatusProviderDetails = {
  readonly provider: 'lifi';
  readonly status: string;
  readonly substatus: string | null;
};

export type OseroApiUnknownTransferStatusProviderDetails = Readonly<Record<string, unknown>> & {
  readonly provider: OseroApiUnknownQuoteProvider;
};

export type OseroApiTransferStatusProviderDetails =
  | OseroApiEnsoTransferStatusProviderDetails
  | OseroApiLifiTransferStatusProviderDetails
  | OseroApiUnknownTransferStatusProviderDetails;

export function isOseroApiEnsoTransferStatusProviderDetails(
  details: OseroApiTransferStatusProviderDetails,
): details is OseroApiEnsoTransferStatusProviderDetails {
  return details.provider === 'enso';
}

export function isOseroApiLifiTransferStatusProviderDetails(
  details: OseroApiTransferStatusProviderDetails,
): details is OseroApiLifiTransferStatusProviderDetails {
  return details.provider === 'lifi';
}

export type OseroApiTransferStatus = {
  readonly provider: OseroApiQuoteProvider;
  readonly state: OseroApiTransferState;
  readonly sourceChainId: OseroApiChainId;
  readonly destinationChainId: OseroApiChainId;
  readonly bridge: OseroApiBridgeProtocol;
  readonly sourceTransactionHash: Hex;
  readonly destinationTransactionHash: Hex | null;
  readonly error: string | null;
  readonly providerDetails: OseroApiTransferStatusProviderDetails;
};

export type WaitForSwapCompletionOptions = OseroApiRequestOptions & {
  readonly pollingIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly onStatus?: (status: OseroApiTransferStatus) => void | Promise<void>;
};

type HostedSwapProgressDetails = {
  readonly 'quote-received': {
    readonly quote: OseroApiSwapQuoteResponse;
    readonly source: 'initial' | 'refresh';
  };
  readonly 'approval-required': {
    readonly quote: OseroApiSwapQuoteResponse;
    readonly walletExecutionPlan: ExecutionPlan;
    readonly approvalNumber: number;
  };
  readonly 'approval-confirmed': {
    readonly quote: OseroApiSwapQuoteResponse;
    readonly result: TransactionResult;
    readonly approvalNumber: number;
  };
  readonly 'quote-refresh': {
    readonly refreshContext: OseroApiRefreshContext;
    readonly refreshNumber: number;
    readonly reason: 'approval-confirmed' | 'quote-expired';
  };
  readonly 'ready-to-execute': {
    readonly quote: OseroApiSwapQuoteResponse;
    readonly walletExecutionPlan: ExecutionPlan;
  };
  readonly 'execution-confirmed': {
    readonly quote: OseroApiSwapQuoteResponse;
    readonly result: TransactionResult;
  };
};

export type OseroApiHostedSwapProgress = {
  [Type in HostedSwapProgressType]: { readonly type: Type } & HostedSwapProgressDetails[Type];
}[HostedSwapProgressType];

export type ExecuteSwapOptions = OseroApiRequestOptions & {
  readonly approvalTransactionLimit?: number;
  readonly quoteRefreshLimit?: number;
  readonly onProgress?: (progress: OseroApiHostedSwapProgress) => void | Promise<void>;
};

export type OseroApiHostedSwapResult = {
  readonly finalQuote: OseroApiSwapQuoteResponse;
  readonly approvalResults: readonly TransactionResult[];
  readonly executionResult: TransactionResult;
};

export type ExecuteSwapError =
  | OseroApiClientError
  | SendWithError
  | ApprovalLimitError
  | QuoteRefreshLimitError;

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
  readonly body?: OseroApiSwapQuoteBody | OseroApiRefreshContext;
  readonly options?: OseroApiRequestOptions;
  readonly decoder: (value: unknown) => Result<T, UnexpectedError>;
};

/**
 * HTTP client for `https://api.osero.org/v1/`. It is intentionally
 * independent from the on-chain `OseroClient`: callers can use it only to
 * fetch quotes, or pass the Hosted Swap Workflow's `walletExecutionPlan`
 * to the existing wallet adapters for execution.
 *
 * Validation philosophy: the client checks wire grammar and execution
 * safety (addresses, hex payloads, integer bounds) and its own response
 * contract, while the hosted API is the sole authority on supported
 * assets, pairs, and policy limits. Requests the API would accept are
 * never rejected locally, and responses containing assets, chains,
 * protocols, providers, or states unknown to this SDK release
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
  ): ResultAsync<OseroApiHostedSwapWorkflow, OseroApiClientError> {
    const body = encodeSwapQuoteRequest(request);
    if (body.isErr()) return errAsync(body.error);

    return this.requestJson({
      method: 'POST',
      path: 'swap/quote',
      body: body.value,
      options,
      decoder: (value) =>
        decodeSwapQuoteResponse(value, {
          fromAddress: body.value.fromAddress,
          fromAssetId: body.value.fromAssetId,
          toAssetId: body.value.toAssetId,
          amount: body.value.amount,
          slippageBps: body.value.slippage ?? '5',
          referralCode: body.value.referralCode ?? null,
        }),
    }).andThen((response) => this.prepareHostedWorkflow(response, options?.signal));
  }

  refreshSwapQuote(
    refreshContext: OseroApiRefreshContext,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiHostedSwapWorkflow, OseroApiClientError> {
    return this.requestJson({
      method: 'POST',
      path: 'swap/quote/refresh',
      body: refreshContext,
      options,
      decoder: (value) =>
        decodeSwapQuoteResponse(value, {
          fromAddress: refreshContext.walletAddress,
          fromAssetId: refreshContext.sourceAssetId,
          toAssetId: refreshContext.destinationAssetId,
          amount: refreshContext.amount,
          slippageBps: refreshContext.slippage.bps,
          referralCode: refreshContext.referralCode,
          provider: refreshContext.provider,
        }),
    }).andThen((response) => this.prepareHostedWorkflow(response, options?.signal));
  }

  executeSwap(
    request: OseroApiSwapQuoteRequest,
    handler: ExecutionPlanHandler,
    options: ExecuteSwapOptions = {},
  ): ResultAsync<OseroApiHostedSwapResult, ExecuteSwapError> {
    const execute = async (): Promise<Result<OseroApiHostedSwapResult, ExecuteSwapError>> => {
      if (typeof options !== 'object' || options === null) {
        return err(ValidationError.forField('options', 'options must be an object'));
      }
      const requestOptions: OseroApiRequestOptions = {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const approvalResults: TransactionResult[] = [];
      const emit = async (
        progress: OseroApiHostedSwapProgress,
        executionResult?: TransactionResult,
      ): Promise<Result<void, ProgressCallbackError | CancelError>> => {
        if (options.signal?.aborted) return err(CancelError.from(options.signal.reason));
        if (options.onProgress === undefined) return ok(undefined);
        return awaitResultWithCancellation(
          ResultAsync.fromPromise(
            Promise.resolve().then(() => options.onProgress!(progress)),
            (cause) =>
              ProgressCallbackError.fromHostedSwap(cause, {
                progressType: progress.type,
                approvalResults: [...approvalResults],
                ...(executionResult === undefined ? {} : { executionResult }),
              }),
          ),
          options.signal,
        );
      };

      if (typeof handler !== 'function') {
        return err(
          ValidationError.forField('handler', 'handler must be an Execution Plan handler'),
        );
      }
      if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
        return err(ValidationError.forField('onProgress', 'onProgress must be a function'));
      }
      const approvalTransactionLimit =
        options.approvalTransactionLimit ?? DEFAULT_APPROVAL_TRANSACTION_LIMIT;
      if (!Number.isSafeInteger(approvalTransactionLimit) || approvalTransactionLimit <= 0) {
        return err(
          ValidationError.forField(
            'approvalTransactionLimit',
            'approvalTransactionLimit must be a positive safe integer',
          ),
        );
      }
      const quoteRefreshLimit = options.quoteRefreshLimit ?? DEFAULT_QUOTE_REFRESH_LIMIT;
      if (!Number.isSafeInteger(quoteRefreshLimit) || quoteRefreshLimit <= 0) {
        return err(
          ValidationError.forField(
            'quoteRefreshLimit',
            'quoteRefreshLimit must be a positive safe integer',
          ),
        );
      }

      const initial = await this.getSwapQuote(request, requestOptions);
      if (initial.isErr()) return err(initial.error);
      let workflow = initial.value;
      let refreshCount = 0;
      const refreshWorkflow = async (
        current: OseroApiHostedSwapWorkflow,
        reason: 'approval-confirmed' | 'quote-expired',
      ): Promise<Result<OseroApiHostedSwapWorkflow, ExecuteSwapError>> => {
        if (refreshCount >= quoteRefreshLimit) {
          return err(new QuoteRefreshLimitError(quoteRefreshLimit, approvalResults));
        }
        refreshCount += 1;
        const refreshing = await emit({
          type: 'quote-refresh',
          refreshContext: current.quote.refreshContext,
          refreshNumber: refreshCount,
          reason,
        });
        if (refreshing.isErr()) return err(refreshing.error);
        const refreshed = await this.refreshSwapQuote(current.quote.refreshContext, requestOptions);
        if (refreshed.isErr()) return err(refreshed.error);
        const refreshReceived = await emit({
          type: 'quote-received',
          quote: refreshed.value.quote,
          source: 'refresh',
        });
        return refreshReceived.isErr() ? err(refreshReceived.error) : ok(refreshed.value);
      };
      const received = await emit({
        type: 'quote-received',
        quote: workflow.quote,
        source: 'initial',
      });
      if (received.isErr()) return err(received.error);

      // oxlint-disable no-await-in-loop -- Wallet and lifecycle transitions must be serialized.
      while (true) {
        if (workflow.state === 'approval-required') {
          const approvalNumber = approvalResults.length + 1;
          const required = await emit({
            type: 'approval-required',
            quote: workflow.quote,
            walletExecutionPlan: workflow.walletExecutionPlan,
            approvalNumber,
          });
          if (required.isErr()) return err(required.error);
          if (approvalResults.length >= approvalTransactionLimit) {
            return err(new ApprovalLimitError(approvalTransactionLimit, approvalResults));
          }

          let approvalResult: Result<TransactionResult, SendWithError>;
          try {
            approvalResult = await handler(workflow.walletExecutionPlan);
          } catch (cause) {
            return err(UnexpectedError.from(cause));
          }
          if (approvalResult.isErr()) return err(approvalResult.error);
          approvalResults.push(approvalResult.value);
          const confirmed = await emit({
            type: 'approval-confirmed',
            quote: workflow.quote,
            result: approvalResult.value,
            approvalNumber,
          });
          if (confirmed.isErr()) return err(confirmed.error);

          const refreshed = await refreshWorkflow(workflow, 'approval-confirmed');
          if (refreshed.isErr()) return err(refreshed.error);
          workflow = refreshed.value;
          continue;
        }

        if (Date.now() >= Date.parse(workflow.quote.quote.expiresAt)) {
          const refreshed = await refreshWorkflow(workflow, 'quote-expired');
          if (refreshed.isErr()) return err(refreshed.error);
          workflow = refreshed.value;
          continue;
        }

        const ready = await emit({
          type: 'ready-to-execute',
          quote: workflow.quote,
          walletExecutionPlan: workflow.walletExecutionPlan,
        });
        if (ready.isErr()) return err(ready.error);
        if (Date.now() >= Date.parse(workflow.quote.quote.expiresAt)) {
          const refreshed = await refreshWorkflow(workflow, 'quote-expired');
          if (refreshed.isErr()) return err(refreshed.error);
          workflow = refreshed.value;
          continue;
        }

        let executionResult: Result<TransactionResult, SendWithError>;
        try {
          executionResult = await handler(workflow.walletExecutionPlan);
        } catch (cause) {
          return err(UnexpectedError.from(cause));
        }
        if (executionResult.isErr()) {
          if (executionResult.error.code !== 'QUOTE_EXPIRED') return err(executionResult.error);
          const refreshed = await refreshWorkflow(workflow, 'quote-expired');
          if (refreshed.isErr()) return err(refreshed.error);
          workflow = refreshed.value;
          continue;
        }
        const confirmed = await emit(
          {
            type: 'execution-confirmed',
            quote: workflow.quote,
            result: executionResult.value,
          },
          executionResult.value,
        );
        if (confirmed.isErr()) return err(confirmed.error);
        return ok({
          finalQuote: workflow.quote,
          approvalResults,
          executionResult: executionResult.value,
        });
      }
      // oxlint-enable no-await-in-loop
    };
    return new ResultAsync(execute());
  }

  getSwapStatus(
    request: OseroApiTransferStatusRequest,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiTransferStatus, OseroApiClientError> {
    const query = encodeSwapStatusRequest(request);
    if (query.isErr()) return errAsync(query.error);
    return this.requestJson({
      method: 'GET',
      path: query.value,
      options,
      decoder: (value) => decodeTransferStatus(value, request),
    });
  }

  getSwapStatusForQuote(
    quote: OseroApiSwapQuoteResponse,
    txHash: Hex,
    options?: OseroApiRequestOptions,
  ): ResultAsync<OseroApiTransferStatus, OseroApiClientError> {
    if (quote.statusContext === null) {
      return errAsync(
        ValidationError.forField(
          'quote',
          'quote is same-chain; no bridge completion status exists',
        ),
      );
    }
    return this.getSwapStatus(
      {
        sourceTransactionHash: txHash,
        statusContext: quote.statusContext,
      },
      options,
    );
  }

  waitForSwapCompletion(
    quote: OseroApiSwapQuoteResponse,
    txHash: Hex,
    options: WaitForSwapCompletionOptions = {},
  ): ResultAsync<OseroApiTransferStatus, OseroApiClientError> {
    if (quote.statusContext === null) {
      return errAsync(
        ValidationError.forField('quote', 'waitForSwapCompletion requires a cross-chain quote'),
      );
    }
    const statusRequest = quote.statusContext;
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

    const wait = async (): Promise<Result<OseroApiTransferStatus, OseroApiClientError>> => {
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

        const status = await awaitPollingOperation(
          (signal) =>
            this.getSwapStatus(
              {
                sourceTransactionHash: txHash,
                statusContext: statusRequest,
              },
              {
                ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                signal,
              },
            ),
          remaining,
          timeoutMs,
          options.signal,
        );
        if (status.isErr()) return err(status.error);

        const fingerprint = JSON.stringify(status.value);
        if (fingerprint !== previousStatus) {
          previousStatus = fingerprint;
          if (options.onStatus !== undefined) {
            const callbackRemaining = timeoutMs - (Date.now() - startedAt);
            if (callbackRemaining <= 0) {
              return err(new TimeoutError('waitForSwapCompletion', timeoutMs));
            }
            const callback = await awaitPollingOperation(
              () =>
                ResultAsync.fromPromise(
                  Promise.resolve().then(() => options.onStatus!(status.value)),
                  (cause) =>
                    new ConfigurationError('onStatus callback failed', 'onStatus', { cause }),
                ),
              callbackRemaining,
              timeoutMs,
              options.signal,
            );
            if (callback.isErr()) return err(callback.error);
          }
        }

        if (status.value.state === 'completed' || status.value.state === 'failed') {
          return ok(status.value);
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

  private prepareHostedWorkflow(
    response: OseroApiSwapQuoteResponse,
    signal?: AbortSignal,
  ): ResultAsync<OseroApiHostedSwapWorkflow, OseroApiClientError> {
    const preparation = async (): Promise<
      Result<OseroApiHostedSwapWorkflow, OseroApiClientError>
    > => {
      if (signal?.aborted) return err(CancelError.from(signal.reason));
      const allowanceSnapshots = [];
      const approvalSteps = response.executionPlan.approvalSteps
        .map((approval, index) => [index, approval] as const)
        .filter(([, approval]) => BigInt(approval.requiredAmount.raw) > 0n);
      if (approvalSteps.length > 0) {
        const provider = this.#publicClientProvider;
        if (provider === undefined) {
          return err(
            new ConfigurationError(
              'quote preparation requires publicClientProvider when Approval Steps are present',
              'publicClientProvider',
            ),
          );
        }
        const clients = new Map<
          number,
          { readonly client: OseroApiPublicClient; readonly blockNumber: bigint }
        >();

        // Approval Steps are checked in API order so the first insufficient step fails closed.
        // oxlint-disable no-await-in-loop
        for (const [index, approval] of approvalSteps) {
          if (signal?.aborted) return err(CancelError.from(signal.reason));
          const chainId = approval.transaction.chainId;
          let chain = clients.get(chainId);
          if (chain === undefined) {
            const publicClient = await awaitResultWithCancellation(
              ResultAsync.fromPromise(
                Promise.resolve().then(() => provider(chainId)),
                (cause) =>
                  new ConfigurationError(
                    `publicClientProvider failed for chain ${chainId}`,
                    'publicClientProvider',
                    { cause },
                  ),
              ),
              signal,
            );
            if (signal?.aborted) return err(CancelError.from(signal.reason));
            if (publicClient.isErr()) return err(publicClient.error);
            if (publicClient.value.chain?.id !== chainId) {
              return err(
                new ConfigurationError(
                  `publicClientProvider returned a client for the wrong chain ${chainId}`,
                  'publicClientProvider',
                ),
              );
            }
            const block = await awaitResultWithCancellation(
              ResultAsync.fromPromise(publicClient.value.getBlockNumber(), (cause) =>
                RpcError.from({ cause, operation: 'getBlockNumber', chainId }),
              ),
              signal,
            );
            if (signal?.aborted) return err(CancelError.from(signal.reason));
            if (block.isErr()) return err(block.error);
            chain = { client: publicClient.value, blockNumber: block.value };
            clients.set(chainId, chain);
          }
          const allowance = await awaitResultWithCancellation(
            checkAllowanceWithPublicClient(chain.client, {
              stepId: `approval-${index + 1}`,
              chainId,
              token: approval.token.address,
              owner: approval.transaction.sender,
              spender: approval.spender,
              requiredAmount: BigInt(approval.requiredAmount.raw),
              policy: 'none',
              blockNumber: chain.blockNumber,
            }),
            signal,
          );
          if (signal?.aborted) return err(CancelError.from(signal.reason));
          if (allowance.isErr()) return err(allowance.error);
          allowanceSnapshots.push(allowance.value.snapshot);
          if (allowance.value.needsApproval) {
            const transaction = approval.transaction;
            const prepared = createPreparedApprovalTransaction({
              id: `approval-${index + 1}`,
              chainId: transaction.chainId,
              sender: transaction.sender,
              recipient: transaction.recipient,
              calldata: transaction.calldata,
              value: BigInt(transaction.value),
              token: approval.token.address,
              spender: approval.spender,
              requiredAmount: BigInt(approval.requiredAmount.raw),
              ...(transaction.gasLimit === null || BigInt(transaction.gasLimit) === 0n
                ? {}
                : {
                    estimatedGas: {
                      gas: BigInt(transaction.gasLimit),
                      source: 'hosted-api',
                    },
                  }),
            });
            if (prepared.isErr()) return err(prepared.error);
            const plan = createExecutionPlan({
              steps: [prepared.value],
              quoteExpiresAt: response.quote.expiresAt,
              metadata: { source: 'hosted-api', allowanceSnapshots },
            });
            if (plan.isErr()) return err(plan.error);
            return ok({
              state: 'approval-required',
              quote: response,
              walletExecutionPlan: plan.value,
            });
          }
        }
        // oxlint-enable no-await-in-loop
      }

      if (signal?.aborted) return err(CancelError.from(signal.reason));
      const transaction = response.executionPlan.executionStep.transaction;
      const execution = createTransactionRequest({
        id: 'execute-swap',
        chainId: transaction.chainId,
        from: transaction.sender,
        to: transaction.recipient,
        data: transaction.calldata,
        value: BigInt(transaction.value),
        operation: 'SWAP_EXACT_IN',
        ...(transaction.gasLimit === null || BigInt(transaction.gasLimit) === 0n
          ? {}
          : {
              estimatedGas: {
                gas: BigInt(transaction.gasLimit),
                source: 'hosted-api',
              },
            }),
      });
      if (execution.isErr()) return err(execution.error);
      const plan = createExecutionPlan({
        steps: [execution.value],
        quoteExpiresAt: response.quote.expiresAt,
        metadata: {
          source: 'hosted-api',
          ...(allowanceSnapshots.length === 0 ? {} : { allowanceSnapshots }),
        },
      });
      if (plan.isErr()) return err(plan.error);
      return ok({
        state: 'ready-to-execute',
        quote: response,
        walletExecutionPlan: plan.value,
      });
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
        const provided = await awaitResultWithCancellation(
          ResultAsync.fromPromise(
            Promise.resolve().then(() => this.#apiKeyProvider!()),
            (cause) => new ConfigurationError('apiKeyProvider failed', 'apiKeyProvider', { cause }),
          ),
          options?.signal,
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

      // Hoist before calling: `this.#fetch(...)` passes the client as the
      // receiver, which browser fetch rejects with "Illegal invocation".
      const fetchImpl = this.#fetch;
      const response = await ResultAsync.fromPromise(fetchImpl(url, init), (cause) =>
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

function awaitResultWithCancellation<Value, ErrorType>(
  result: PromiseLike<Result<Value, ErrorType>>,
  signal: AbortSignal | undefined,
): Promise<Result<Value, ErrorType | CancelError>> {
  if (signal === undefined) return Promise.resolve(result);
  if (signal.aborted) return Promise.resolve(err(CancelError.from(signal.reason)));

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: Result<Value, ErrorType | CancelError>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => settle(err(CancelError.from(signal.reason)));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(result).then(settle);
  });
}

async function awaitPollingOperation<Value, ErrorType>(
  operation: (signal: AbortSignal) => PromiseLike<Result<Value, ErrorType>>,
  remainingMs: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Result<Value, ErrorType | CancelError | TimeoutError>> {
  if (signal?.aborted) return err(CancelError.from(signal.reason));
  if (remainingMs <= 0) return err(new TimeoutError('waitForSwapCompletion', timeoutMs));

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new TimeoutError('waitForSwapCompletion', timeoutMs));
  }, remainingMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const result = await awaitResultWithCancellation(operation(controller.signal), controller.signal);
  clearTimeout(timeout);
  signal?.removeEventListener('abort', abort);

  return timedOut ? err(new TimeoutError('waitForSwapCompletion', timeoutMs)) : result;
}

function sleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<Result<void, CancelError>> {
  if (signal?.aborted) return Promise.resolve(err(CancelError.from(signal.reason)));
  return new Promise<Result<void, CancelError>>((resolve) => {
    let settled = false;
    const settle = (result: Result<void, CancelError>) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const timer = setTimeout(() => settle(ok(undefined)), milliseconds);
    const abort = () => {
      clearTimeout(timer);
      settle(err(CancelError.from(signal?.reason)));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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
  return globalThis.fetch.bind(globalThis);
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
  request: OseroApiTransferStatusRequest,
): Result<string, ValidationError> {
  if (typeof request !== 'object' || request === null) {
    return err(ValidationError.forField('request', 'status request must be an object'));
  }
  if (!isTransactionHash(request.sourceTransactionHash)) {
    return err(
      ValidationError.forField(
        'sourceTransactionHash',
        'sourceTransactionHash must be a 32-byte hex string',
      ),
    );
  }
  if (typeof request.statusContext !== 'object' || request.statusContext === null) {
    return err(
      ValidationError.forField('statusContext', 'statusContext must be a complete Status Context'),
    );
  }
  const { bridge, destinationChainId, provider, sourceChainId } = request.statusContext;
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return err(ValidationError.forField('statusContext.provider', 'provider must be non-empty'));
  }
  if (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0) {
    return err(
      ValidationError.forField(
        'statusContext.sourceChainId',
        'sourceChainId must be a positive integer',
      ),
    );
  }
  if (!Number.isSafeInteger(destinationChainId) || destinationChainId <= 0) {
    return err(
      ValidationError.forField(
        'statusContext.destinationChainId',
        'destinationChainId must be a positive integer',
      ),
    );
  }
  if (sourceChainId === destinationChainId) {
    return err(
      ValidationError.forField(
        'statusContext.destinationChainId',
        'Status Context must describe distinct source and destination chains',
      ),
    );
  }
  if (typeof bridge !== 'string' || bridge.trim().length === 0) {
    return err(ValidationError.forField('statusContext.bridge', 'bridge must be non-empty'));
  }
  const search = new URLSearchParams({
    provider,
    sourceChainId: String(sourceChainId),
    destinationChainId: String(destinationChainId),
    bridge,
  });
  return ok(`swap/status/${request.sourceTransactionHash}?${search.toString()}`);
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
    readonly fromAssetId: string;
    readonly toAssetId: string;
    readonly amount: OseroApiIntegerString;
    readonly slippageBps: string;
    readonly referralCode: number | null;
    readonly provider?: OseroApiQuoteProvider;
  },
): Result<OseroApiSwapQuoteResponse, UnexpectedError> {
  return decode(value, (root) => {
    const response = {
      provider: decodeQuoteProvider(requiredField(root, 'provider', '$.provider'), '$.provider'),
      pair: decodeSwapPair(requiredField(root, 'pair', '$.pair'), '$.pair'),
      quote: decodeSwapQuoteEconomics(requiredField(root, 'quote', '$.quote'), '$.quote'),
      routeSummary: decodeRouteSummary(
        requiredField(root, 'routeSummary', '$.routeSummary'),
        '$.routeSummary',
      ),
      executionPlan: decodeApiExecutionPlan(
        requiredField(root, 'executionPlan', '$.executionPlan'),
        '$.executionPlan',
      ),
      refreshContext: decodeRefreshContext(
        requiredField(root, 'refreshContext', '$.refreshContext'),
        '$.refreshContext',
      ),
      statusContext: nullableField(root, 'statusContext', '$.statusContext', decodeStatusContext),
      providerDetails: decodeQuoteProviderDetails(
        requiredField(root, 'providerDetails', '$.providerDetails'),
        '$.providerDetails',
      ),
    };
    assertSwapQuoteInvariants(response, expected);
    return response;
  });
}

function decodeTransferStatus(
  value: unknown,
  request: OseroApiTransferStatusRequest,
): Result<OseroApiTransferStatus, UnexpectedError> {
  return decode(value, (root) => {
    const status: OseroApiTransferStatus = {
      provider: decodeQuoteProvider(requiredField(root, 'provider', '$.provider'), '$.provider'),
      state: decodeTransferState(requiredField(root, 'state', '$.state'), '$.state'),
      sourceChainId: positiveChainIdField(root, 'sourceChainId', '$.sourceChainId'),
      destinationChainId: positiveChainIdField(root, 'destinationChainId', '$.destinationChainId'),
      bridge: nonEmptyStringField(root, 'bridge', '$.bridge'),
      sourceTransactionHash: hashField(root, 'sourceTransactionHash', '$.sourceTransactionHash'),
      destinationTransactionHash: nullableField(
        root,
        'destinationTransactionHash',
        '$.destinationTransactionHash',
        decodeHash,
      ),
      error: nullableField(root, 'error', '$.error', decodeNonEmptyString),
      providerDetails: decodeTransferStatusProviderDetails(
        requiredField(root, 'providerDetails', '$.providerDetails'),
        '$.providerDetails',
      ),
    };
    assertTransferStatusInvariants(status, request);
    return status;
  });
}

function assertSwapQuoteInvariants(
  response: OseroApiSwapQuoteResponse,
  expected: {
    readonly fromAddress: Address;
    readonly fromAssetId: string;
    readonly toAssetId: string;
    readonly amount: OseroApiIntegerString;
    readonly slippageBps: string;
    readonly referralCode: number | null;
    readonly provider?: OseroApiQuoteProvider;
  },
): void {
  const { executionPlan, pair, provider, quote, refreshContext, routeSummary, statusContext } =
    response;
  if (!isAddressEqual(refreshContext.walletAddress, expected.fromAddress)) {
    throw new DecodeError('$.refreshContext.walletAddress must match the requested fromAddress');
  }
  if (expected.provider !== undefined && provider !== expected.provider) {
    throw new DecodeError('$.provider must match the provider-locked Refresh Context');
  }
  if (quote.inputAmount.raw !== expected.amount || refreshContext.amount !== expected.amount) {
    throw new DecodeError('quote and Refresh Context amounts must match the requested amount');
  }
  if (
    pair.source.assetId !== refreshContext.sourceAssetId ||
    pair.destination.assetId !== refreshContext.destinationAssetId
  ) {
    throw new DecodeError('$.refreshContext asset ids must match $.pair');
  }
  assertRequestedAsset(pair.source, expected.fromAssetId, 'source');
  assertRequestedAsset(pair.destination, expected.toAssetId, 'destination');
  if (quote.slippage.bps !== expected.slippageBps) {
    throw new DecodeError('$.quote.slippage.bps must match the requested slippage');
  }
  if (quote.referralAttribution.requestedCode !== expected.referralCode) {
    throw new DecodeError(
      '$.quote.referralAttribution.requestedCode must match the requested referral',
    );
  }
  if (
    pair.source.chainId !== routeSummary.sourceChainId ||
    pair.destination.chainId !== routeSummary.destinationChainId
  ) {
    throw new DecodeError('$.routeSummary chains must match $.pair');
  }
  if (
    quote.slippage.bps !== refreshContext.slippage.bps ||
    quote.slippage.percent !== refreshContext.slippage.percent
  ) {
    throw new DecodeError('$.refreshContext.slippage must match $.quote.slippage');
  }
  if (quote.referralAttribution.requestedCode !== refreshContext.referralCode) {
    throw new DecodeError(
      '$.quote.referralAttribution.requestedCode must match $.refreshContext.referralCode',
    );
  }
  if (
    provider !== refreshContext.provider ||
    provider !== response.providerDetails.provider ||
    (statusContext !== null && provider !== statusContext.provider)
  ) {
    throw new DecodeError('provider tags must agree across the normalized quote');
  }
  if (Date.parse(quote.expiresAt) <= Date.parse(quote.quotedAt)) {
    throw new DecodeError('$.quote.expiresAt must be after $.quote.quotedAt');
  }
  assertAmountFormat(quote.inputAmount, pair.source, '$.quote.inputAmount');
  assertAmountFormat(quote.expectedOutput, pair.destination, '$.quote.expectedOutput');
  if (BigInt(quote.inputAmount.raw) === 0n || BigInt(quote.expectedOutput.raw) === 0n) {
    throw new DecodeError('Input Amount and Expected Output must be positive');
  }
  if (quote.minimumOutput !== null) {
    assertAmountFormat(quote.minimumOutput, pair.destination, '$.quote.minimumOutput');
    if (BigInt(quote.minimumOutput.raw) > BigInt(quote.expectedOutput.raw)) {
      throw new DecodeError('$.quote.minimumOutput.raw must not exceed Expected Output');
    }
  }

  if (routeSummary.kind === 'same-chain') {
    if (
      routeSummary.sourceChainId !== routeSummary.destinationChainId ||
      routeSummary.bridge !== null ||
      statusContext !== null
    ) {
      throw new DecodeError(
        'same-chain quotes require equal chains, a null bridge, and null Status Context',
      );
    }
  } else {
    if (
      routeSummary.sourceChainId === routeSummary.destinationChainId ||
      routeSummary.bridge === null ||
      statusContext === null
    ) {
      throw new DecodeError(
        'cross-chain quotes require distinct chains, a bridge, and Status Context',
      );
    }
    if (
      statusContext.sourceChainId !== routeSummary.sourceChainId ||
      statusContext.destinationChainId !== routeSummary.destinationChainId ||
      statusContext.bridge !== routeSummary.bridge
    ) {
      throw new DecodeError('$.statusContext must match $.routeSummary');
    }
  }

  for (const [index, approval] of executionPlan.approvalSteps.entries()) {
    const path = `$.executionPlan.approvalSteps[${index}]`;
    assertPreparedTransaction(
      approval.transaction,
      routeSummary.sourceChainId,
      expected.fromAddress,
      path,
    );
    if (!assetsMatch(approval.token, pair.source)) {
      throw new DecodeError(`${path}.token must match $.pair.source`);
    }
    assertAmountFormat(approval.requiredAmount, pair.source, `${path}.requiredAmount`);
    if (!isAddressEqual(approval.transaction.recipient, approval.token.address)) {
      throw new DecodeError(`${path}.transaction.recipient must match the approval token`);
    }
    if (approval.transaction.value !== '0') {
      throw new DecodeError(`${path}.transaction.value must be 0`);
    }
    assertApprovalCalldata(approval, path);
  }
  assertPreparedTransaction(
    executionPlan.executionStep.transaction,
    routeSummary.sourceChainId,
    expected.fromAddress,
    '$.executionPlan.executionStep',
  );
}

function assertAmountFormat(
  amount: OseroApiSwapAmount,
  asset: OseroApiSwapAsset,
  path: string,
): void {
  if (formatUnits(BigInt(amount.raw), asset.decimals) !== amount.formatted) {
    throw new DecodeError(`${path}.formatted must match its raw amount and asset decimals`);
  }
}

function assetsMatch(left: OseroApiSwapAsset, right: OseroApiSwapAsset): boolean {
  return (
    left.assetId === right.assetId &&
    left.chainId === right.chainId &&
    left.chainKey === right.chainKey &&
    left.chainName === right.chainName &&
    left.chainShortName === right.chainShortName &&
    left.symbol === right.symbol &&
    left.decimals === right.decimals &&
    isAddressEqual(left.address, right.address) &&
    left.label === right.label
  );
}

function assertRequestedAsset(
  asset: OseroApiSwapAsset,
  requestedRef: string,
  role: 'source' | 'destination',
): void {
  const locator = parseAssetLocatorString(requestedRef);
  if (locator === undefined) {
    if (asset.assetId !== requestedRef) {
      throw new DecodeError(`$.pair.${role}.assetId must match the requested asset id`);
    }
    return;
  }
  if (asset.chainId !== locator.chainId || !isAddressEqual(asset.address, locator.address)) {
    throw new DecodeError(`$.pair.${role} must match the requested asset locator`);
  }
}

function assertPreparedTransaction(
  transaction: OseroApiPreparedTransaction,
  sourceChainId: number,
  sender: Address,
  path: string,
): void {
  if (transaction.chainId !== sourceChainId) {
    throw new DecodeError(`${path}.transaction.chainId must match the source chain`);
  }
  if (!isAddressEqual(transaction.sender, sender)) {
    throw new DecodeError(`${path}.transaction.sender must match the requested wallet`);
  }
}

function assertApprovalCalldata(approval: OseroApiApprovalStep, path: string): void {
  let decoded: DecodeFunctionDataReturnType<typeof erc20Abi>;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: approval.transaction.calldata });
  } catch (cause) {
    throw new DecodeError(
      `${path}.transaction.calldata must encode ERC-20 approve: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    decoded.functionName !== 'approve' ||
    decoded.args[0] === undefined ||
    decoded.args[1] === undefined ||
    !isAddressEqual(decoded.args[0], approval.spender) ||
    decoded.args[1] !== BigInt(approval.requiredAmount.raw)
  ) {
    throw new DecodeError(
      `${path}.transaction.calldata must match approve(spender, requiredAmount.raw)`,
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
    source: decodeSwapAsset(requiredField(record, 'source', `${path}.source`), `${path}.source`),
    destination: decodeSwapAsset(
      requiredField(record, 'destination', `${path}.destination`),
      `${path}.destination`,
    ),
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

function decodeSwapQuoteEconomics(value: unknown, path: string): OseroApiSwapQuoteEconomics {
  const record = asRecord(value, path);
  return {
    inputAmount: decodeSwapAmount(
      requiredField(record, 'inputAmount', `${path}.inputAmount`),
      `${path}.inputAmount`,
    ),
    expectedOutput: decodeSwapAmount(
      requiredField(record, 'expectedOutput', `${path}.expectedOutput`),
      `${path}.expectedOutput`,
    ),
    minimumOutput: nullableField(
      record,
      'minimumOutput',
      `${path}.minimumOutput`,
      decodeSwapAmount,
    ),
    slippage: decodeSlippage(
      requiredField(record, 'slippage', `${path}.slippage`),
      `${path}.slippage`,
    ),
    referralAttribution: decodeReferralAttribution(
      requiredField(record, 'referralAttribution', `${path}.referralAttribution`),
      `${path}.referralAttribution`,
    ),
    quotedAt: timestampField(record, 'quotedAt', `${path}.quotedAt`),
    expiresAt: timestampField(record, 'expiresAt', `${path}.expiresAt`),
  };
}

function decodeReferralAttribution(value: unknown, path: string): OseroApiReferralAttribution {
  const record = asRecord(value, path);
  const status = nonEmptyStringField(record, 'status', `${path}.status`);
  if (status !== 'not-requested' && status !== 'applied' && status !== 'not-applied') {
    throw new DecodeError(`${path}.status is not a valid Referral Attribution status`);
  }
  const requestedCode = nullableField(
    record,
    'requestedCode',
    `${path}.requestedCode`,
    decodeReferralCode,
  );
  if ((status === 'not-requested') !== (requestedCode === null)) {
    throw new DecodeError(
      `${path}.requestedCode must be null exactly when no referral was requested`,
    );
  }
  return { requestedCode, status };
}

function decodeRouteSummary(value: unknown, path: string): OseroApiRouteSummary {
  const record = asRecord(value, path);
  const kind = nonEmptyStringField(record, 'kind', `${path}.kind`);
  if (kind !== 'same-chain' && kind !== 'cross-chain') {
    throw new DecodeError(`${path}.kind must be same-chain or cross-chain`);
  }
  return {
    kind,
    sourceChainId: positiveChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: positiveChainIdField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
    ),
    bridge: nullableField(record, 'bridge', `${path}.bridge`, decodeNonEmptyString),
  };
}

function decodeSwapAmount(value: unknown, path: string): OseroApiSwapAmount {
  const record = asRecord(value, path);
  return {
    raw: uint256StringField(record, 'raw', `${path}.raw`),
    formatted: decimalStringField(record, 'formatted', `${path}.formatted`),
  };
}

function decodeSlippage(value: unknown, path: string): OseroApiSwapSlippage {
  const record = asRecord(value, path);
  const bps = stringField(record, 'bps', `${path}.bps`);
  if (parseSlippage(bps).isErr()) {
    throw new DecodeError(`${path}.bps must be a decimal basis-point value from 0 to 10000`);
  }
  const percent = decimalStringField(record, 'percent', `${path}.percent`);
  if (percent !== slippageBpsToPercent(bps)) {
    throw new DecodeError(`${path}.percent must match ${path}.bps`);
  }
  return {
    bps,
    percent,
  };
}

function slippageBpsToPercent(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const scale = fraction.length + 2;
  const numerator = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const padded = numerator.padStart(scale + 1, '0');
  const percentWhole = padded.slice(0, -scale);
  const percentFraction = padded.slice(-scale).replace(/0+$/, '');
  return percentFraction ? `${percentWhole}.${percentFraction}` : percentWhole;
}

function decodeApiExecutionPlan(value: unknown, path: string): OseroApiExecutionPlan {
  const record = asRecord(value, path);
  return {
    approvalSteps: arrayField(record, 'approvalSteps', `${path}.approvalSteps`, decodeApprovalStep),
    executionStep: decodeExecutionStep(
      requiredField(record, 'executionStep', `${path}.executionStep`),
      `${path}.executionStep`,
    ),
  };
}

function decodeApprovalStep(value: unknown, path: string): OseroApiApprovalStep {
  const record = asRecord(value, path);
  return {
    token: decodeSwapAsset(requiredField(record, 'token', `${path}.token`), `${path}.token`),
    spender: addressField(record, 'spender', `${path}.spender`),
    requiredAmount: decodeSwapAmount(
      requiredField(record, 'requiredAmount', `${path}.requiredAmount`),
      `${path}.requiredAmount`,
    ),
    transaction: decodePreparedTransaction(
      requiredField(record, 'transaction', `${path}.transaction`),
      `${path}.transaction`,
    ),
  };
}

function decodeExecutionStep(value: unknown, path: string): OseroApiExecutionStep {
  const record = asRecord(value, path);
  return {
    transaction: decodePreparedTransaction(
      requiredField(record, 'transaction', `${path}.transaction`),
      `${path}.transaction`,
    ),
  };
}

function decodePreparedTransaction(value: unknown, path: string): OseroApiPreparedTransaction {
  const record = asRecord(value, path);
  return {
    chainId: positiveChainIdField(record, 'chainId', `${path}.chainId`),
    sender: addressField(record, 'sender', `${path}.sender`),
    recipient: addressField(record, 'recipient', `${path}.recipient`),
    calldata: calldataField(record, 'calldata', `${path}.calldata`),
    value: uint256StringField(record, 'value', `${path}.value`),
    gasLimit: nullableField(record, 'gasLimit', `${path}.gasLimit`, decodeUint256String),
  };
}

function decodeRefreshContext(value: unknown, path: string): OseroApiRefreshContext {
  const record = asRecord(value, path);
  return {
    provider: decodeQuoteProvider(
      requiredField(record, 'provider', `${path}.provider`),
      `${path}.provider`,
    ),
    walletAddress: addressField(record, 'walletAddress', `${path}.walletAddress`),
    sourceAssetId: nonEmptyStringField(record, 'sourceAssetId', `${path}.sourceAssetId`),
    destinationAssetId: nonEmptyStringField(
      record,
      'destinationAssetId',
      `${path}.destinationAssetId`,
    ),
    amount: uint256StringField(record, 'amount', `${path}.amount`),
    slippage: decodeSlippage(
      requiredField(record, 'slippage', `${path}.slippage`),
      `${path}.slippage`,
    ),
    referralCode: nullableField(record, 'referralCode', `${path}.referralCode`, decodeReferralCode),
  };
}

function decodeStatusContext(value: unknown, path: string): OseroApiStatusContext {
  const record = asRecord(value, path);
  return {
    provider: decodeQuoteProvider(
      requiredField(record, 'provider', `${path}.provider`),
      `${path}.provider`,
    ),
    sourceChainId: positiveChainIdField(record, 'sourceChainId', `${path}.sourceChainId`),
    destinationChainId: positiveChainIdField(
      record,
      'destinationChainId',
      `${path}.destinationChainId`,
    ),
    bridge: nonEmptyStringField(record, 'bridge', `${path}.bridge`),
  };
}

function decodeQuoteProvider(value: unknown, path: string): OseroApiQuoteProvider {
  return decodeNonEmptyString(value, path) as OseroApiQuoteProvider;
}

function decodeQuoteProviderDetails(value: unknown, path: string): OseroApiQuoteProviderDetails {
  const record = asRecord(value, path);
  const provider = nonEmptyStringField(record, 'provider', `${path}.provider`);
  if (provider === 'enso') return decodeEnsoProviderDetails(record, path);
  if (provider === 'lifi') return decodeLifiProviderDetails(record, path);
  return { ...record, provider: provider as OseroApiUnknownQuoteProvider };
}

function decodeEnsoProviderDetails(
  record: Record<string, unknown>,
  path: string,
): OseroApiEnsoProviderDetails {
  return {
    provider: 'enso',
    route: arrayField(record, 'route', `${path}.route`, decodeEnsoRouteLabel),
    gasUnits: nullableField(record, 'gasUnits', `${path}.gasUnits`, decodeUint256String),
    priceImpactBps: nullableField(record, 'priceImpactBps', `${path}.priceImpactBps`, decodeNumber),
    simulationBlockNumber: nullableField(
      record,
      'simulationBlockNumber',
      `${path}.simulationBlockNumber`,
      decodeNonNegativeSafeInteger,
    ),
  };
}

function decodeEnsoRouteLabel(value: unknown, path: string): OseroApiEnsoRouteLabel {
  const record = asRecord(value, path);
  return {
    protocol: nonEmptyStringField(record, 'protocol', `${path}.protocol`),
    action: nonEmptyStringField(record, 'action', `${path}.action`),
  };
}

function decodeLifiProviderDetails(
  record: Record<string, unknown>,
  path: string,
): OseroApiLifiProviderDetails {
  return {
    provider: 'lifi',
    routeId: nonEmptyStringField(record, 'routeId', `${path}.routeId`),
    usesComposer: booleanField(record, 'usesComposer', `${path}.usesComposer`),
    gasCostUsd: nullableField(record, 'gasCostUsd', `${path}.gasCostUsd`, decodeString),
    steps: arrayField(record, 'steps', `${path}.steps`, decodeLifiStep),
  };
}

function decodeLifiStep(value: unknown, path: string): OseroApiLifiStep {
  const record = asRecord(value, path);
  return {
    id: nonEmptyStringField(record, 'id', `${path}.id`),
    type: nonEmptyStringField(record, 'type', `${path}.type`),
    tool: nonEmptyStringField(record, 'tool', `${path}.tool`),
    executionDurationSeconds: nullableField(
      record,
      'executionDurationSeconds',
      `${path}.executionDurationSeconds`,
      decodeNonNegativeNumber,
    ),
    feeCosts: arrayField(record, 'feeCosts', `${path}.feeCosts`, decodeLifiFeeCost),
    gasCosts: arrayField(record, 'gasCosts', `${path}.gasCosts`, decodeLifiGasCost),
    includedSteps: arrayField(
      record,
      'includedSteps',
      `${path}.includedSteps`,
      decodeLifiIncludedStep,
    ),
  };
}

function decodeLifiFeeCost(value: unknown, path: string): OseroApiLifiFeeCost {
  const record = asRecord(value, path);
  return {
    name: nonEmptyStringField(record, 'name', `${path}.name`),
    description: nullableField(record, 'description', `${path}.description`, decodeString),
    amount: nonNegativeIntegerStringField(record, 'amount', `${path}.amount`),
    amountUsd: nullableField(record, 'amountUsd', `${path}.amountUsd`, decodeString),
    percentage: nullableField(record, 'percentage', `${path}.percentage`, decodeString),
    included: booleanField(record, 'included', `${path}.included`),
    token: decodeLifiToken(requiredField(record, 'token', `${path}.token`), `${path}.token`),
  };
}

function decodeLifiGasCost(value: unknown, path: string): OseroApiLifiGasCost {
  const record = asRecord(value, path);
  return {
    type: nonEmptyStringField(record, 'type', `${path}.type`),
    price: nonNegativeIntegerStringField(record, 'price', `${path}.price`),
    estimate: nonNegativeIntegerStringField(record, 'estimate', `${path}.estimate`),
    limit: nonNegativeIntegerStringField(record, 'limit', `${path}.limit`),
    amount: nonNegativeIntegerStringField(record, 'amount', `${path}.amount`),
    amountUsd: nullableField(record, 'amountUsd', `${path}.amountUsd`, decodeString),
    token: decodeLifiToken(requiredField(record, 'token', `${path}.token`), `${path}.token`),
  };
}

function decodeLifiToken(value: unknown, path: string): OseroApiLifiToken {
  const record = asRecord(value, path);
  return {
    chainId: positiveChainIdField(record, 'chainId', `${path}.chainId`),
    address: addressField(record, 'address', `${path}.address`, true),
    symbol: nonEmptyStringField(record, 'symbol', `${path}.symbol`),
    decimals: decimalsField(record, 'decimals', `${path}.decimals`),
  };
}

function decodeLifiIncludedStep(value: unknown, path: string): OseroApiLifiIncludedStep {
  const record = asRecord(value, path);
  return {
    id: nonEmptyStringField(record, 'id', `${path}.id`),
    type: nonEmptyStringField(record, 'type', `${path}.type`),
    tool: nonEmptyStringField(record, 'tool', `${path}.tool`),
  };
}

function decodeTransferState(value: unknown, path: string): OseroApiTransferState {
  const state = decodeNonEmptyString(value, path);
  if (state !== 'pending' && state !== 'completed' && state !== 'failed' && state !== 'unknown') {
    throw new DecodeError(`${path} must be pending, completed, failed, or unknown`);
  }
  return state;
}

function decodeTransferStatusProviderDetails(
  value: unknown,
  path: string,
): OseroApiTransferStatusProviderDetails {
  const record = asRecord(value, path);
  const provider = nonEmptyStringField(record, 'provider', `${path}.provider`);
  if (provider === 'enso') {
    return {
      provider,
      status: nonEmptyStringField(record, 'status', `${path}.status`),
    };
  }
  if (provider === 'lifi') {
    return {
      provider,
      status: nonEmptyStringField(record, 'status', `${path}.status`),
      substatus: nullableField(record, 'substatus', `${path}.substatus`, decodeNonEmptyString),
    };
  }
  return { ...record, provider: provider as OseroApiUnknownQuoteProvider };
}

function assertTransferStatusInvariants(
  status: OseroApiTransferStatus,
  request: OseroApiTransferStatusRequest,
): void {
  const context = request.statusContext;
  if (status.provider !== context.provider) {
    throw new DecodeError('$.provider must match Status Context');
  }
  if (status.providerDetails.provider !== status.provider) {
    throw new DecodeError('$.providerDetails.provider must match $.provider');
  }
  if (
    status.sourceChainId !== context.sourceChainId ||
    status.destinationChainId !== context.destinationChainId ||
    status.bridge !== context.bridge
  ) {
    throw new DecodeError('Transfer Status route must match Status Context');
  }
  if (status.sourceChainId === status.destinationChainId) {
    throw new DecodeError('Transfer Status must describe a cross-chain transfer');
  }
  if (status.sourceTransactionHash.toLowerCase() !== request.sourceTransactionHash.toLowerCase()) {
    throw new DecodeError('$.sourceTransactionHash must match the requested source transaction');
  }
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

function decodeNonNegativeNumber(value: unknown, path: string): number {
  const number = decodeNumber(value, path);
  if (number < 0) {
    throw new DecodeError(`${path} must be non-negative`);
  }
  return number;
}

function decodeNonNegativeSafeInteger(value: unknown, path: string): number {
  const number = decodeNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new DecodeError(`${path} must be a non-negative safe integer`);
  }
  return number;
}

function decodeReferralCode(value: unknown, path: string): number {
  const code = decodeNonNegativeSafeInteger(value, path);
  if (code < OSERO_API_REFERRAL_CODE_MIN || code > OSERO_API_REFERRAL_CODE_MAX) {
    throw new DecodeError(
      `${path} must be between ${OSERO_API_REFERRAL_CODE_MIN} and ${OSERO_API_REFERRAL_CODE_MAX}`,
    );
  }
  return code;
}

function addressField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  allowZero = false,
): Address {
  const value = stringField(record, field, path);
  if (!isAddress(value) || (!allowZero && /^0x0{40}$/i.test(value))) {
    throw new DecodeError(`${path} must be a non-zero EVM address`);
  }
  return value as Address;
}

function calldataField(record: Record<string, unknown>, field: string, path: string): Hex {
  const value = stringField(record, field, path);
  if (!isHex(value, { strict: true }) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new DecodeError(`${path} must be byte-aligned 0x-prefixed hex data`);
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
  return decodeUint256String(requiredField(record, field, path), path);
}

function decodeUint256String(value: unknown, path: string): OseroApiIntegerString {
  return encodeUint256String(BigInt(decodeNonNegativeIntegerString(value, path)), path);
}

function decodeNonNegativeIntegerString(value: unknown, path: string): OseroApiIntegerString {
  const text = decodeString(value, path);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new DecodeError(`${path} must be a non-negative integer string`);
  }
  return text as OseroApiIntegerString;
}

function encodeUint256String(value: bigint, path: string): OseroApiIntegerString {
  if (value > UINT256_MAX) {
    throw new DecodeError(`${path} must fit within uint256`);
  }
  return value.toString() as OseroApiIntegerString;
}

function decimalStringField(record: Record<string, unknown>, field: string, path: string): string {
  const value = stringField(record, field, path);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new DecodeError(`${path} must be a non-negative decimal string`);
  }
  return value;
}

function timestampField(record: Record<string, unknown>, field: string, path: string): string {
  const value = stringField(record, field, path);
  if (validateQuoteExpiry(value, path).isErr()) {
    throw new DecodeError(`${path} must be a valid UTC instant`);
  }
  return value;
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
