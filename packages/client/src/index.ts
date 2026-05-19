// ABIs -----------------------------------------------------------------
export {
  erc20Abi,
  erc4626Abi,
  litePsmAbi,
  psm3Abi,
  ssrAbi,
  usdsPsmWrapperAbi,
} from './lib/abis/index.js';

// Adapters (shared helpers) --------------------------------------------
export {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  isTransactionRequest,
} from './lib/adapters.js';

// Addresses -------------------------------------------------------------
export { PSM_ADDRESSES, type PsmAddresses } from './lib/addresses.js';

// APY / SSR -------------------------------------------------------------
export {
  type GetSsrError,
  type GetSsrRequest,
  getSsr,
  getSUsdsApy,
  RAY,
  SECONDS_PER_YEAR,
  ssrToApy,
} from './lib/apy.js';

// API client ------------------------------------------------------------
export {
  DEFAULT_OSERO_API_BASE_URL,
  OseroApiClient,
  OSERO_API_BRIDGE_PROTOCOLS,
  OSERO_API_COUNTER_ASSET_IDS,
  OSERO_API_KEY_MAX_LENGTH,
  OSERO_API_KEY_PREFIX,
  OSERO_API_PUBLIC_ASSET_IDS,
  OSERO_API_REFERRAL_CODE_MAX,
  OSERO_API_REFERRAL_CODE_MIN,
  OSERO_API_SOURCE_CHAIN_IDS,
  OSERO_API_SUSDS_ASSET_ID,
  swapQuoteToExecutionPlan,
  type OseroApiAssetKind,
  type OseroApiAssetSymbol,
  type OseroApiBridgeProtocol,
  type OseroApiBridgeProviderStatus,
  type OseroApiBridgeState,
  type OseroApiChainKey,
  type OseroApiClientConfig,
  type OseroApiClientError,
  type OseroApiCounterAssetId,
  type OseroApiFetch,
  type OseroApiFetchInit,
  type OseroApiFetchResponse,
  type OseroApiFromSusdsQuoteRequest,
  type OseroApiIntegerString,
  type OseroApiPublicAssetId,
  type OseroApiReferralCode,
  type OseroApiRequestOptions,
  type OseroApiSourceChainId,
  type OseroApiSupportedAsset,
  type OseroApiSupportedAssetsResponse,
  type OseroApiSusdsAssetId,
  type OseroApiSwapAmount,
  type OseroApiSwapApproval,
  type OseroApiSwapAsset,
  type OseroApiSwapBridge,
  type OseroApiSwapBridgeStatusRequest,
  type OseroApiSwapDirection,
  type OseroApiSwapExecution,
  type OseroApiSwapExecutionKind,
  type OseroApiSwapPair,
  type OseroApiSwapQuote,
  type OseroApiSwapQuoteInfo,
  type OseroApiSwapQuoteRequest,
  type OseroApiSwapQuoteResponse,
  type OseroApiSwapRouteHop,
  type OseroApiSwapStatusBridge,
  type OseroApiSwapStatusRequest,
  type OseroApiSwapStatusResponse,
  type OseroApiSwapTransaction,
  type OseroApiToSusdsQuoteRequest,
  type ResolvedOseroApiClientConfig,
} from './lib/api.js';

// Balances --------------------------------------------------------------
export {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
  type GetBalancesRequest,
  type GetTokenBalanceError,
  type GetTokenBalanceRequest,
  type TokenBalances,
} from './lib/balances.js';

// Chain registry --------------------------------------------------------
export {
  CHAINS,
  type ChainMetadata,
  getChain,
  isSupportedChainId,
  listChains,
  type OseroChainId,
  SUPPORTED_CHAIN_IDS,
} from './lib/chains.js';

// Client config ---------------------------------------------------------
export type { ClientConfig, ResolvedClientConfig } from './lib/config.js';

// Errors ----------------------------------------------------------------
export {
  ApiRequestError,
  CancelError,
  InsufficientBalanceError,
  OseroError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
} from './lib/errors.js';

// Math helpers ----------------------------------------------------------
export {
  applySlippage,
  BPS,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  USDC_TO_USDS_SCALE,
  usdsNeededForUsdcViaBuyGem,
  WAD,
} from './lib/math.js';

// Client class ----------------------------------------------------------
export { OseroClient, type OseroPublicClient } from './lib/OseroClient.js';

// Plan construction helpers --------------------------------------------
export {
  makeApprovalRequiredPlan,
  makeApprovalTransaction,
  makeMultiStepPlan,
  makeSingleApprovalPlan,
  makeTransactionRequest,
} from './lib/plan.js';

// Referrals ------------------------------------------------------------
export {
  DEFAULT_REFERRAL_CODE,
  resolveReferralCode,
  validateReferralCode,
} from './lib/referrals.js';

// Result type re-exports ------------------------------------------------
export {
  err,
  errAsync,
  fromAsyncThrowable,
  fromPromise,
  fromThrowable,
  ok,
  okAsync,
  Result,
  ResultAsync,
} from './lib/result.js';

// Tokens ----------------------------------------------------------------
export { getToken, listTokens, type Token, type TokenSymbol } from './lib/tokens.js';

// Core types ------------------------------------------------------------
export type {
  ActionError,
  Erc20Approval,
  Erc20ApprovalRequired,
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutionStep,
  ExecutionStepRefresh,
  ExecutionStepRefreshContext,
  MultiStepExecution,
  OperationType,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';
