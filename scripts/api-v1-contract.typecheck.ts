import type {
  ApprovalStep,
  Asset,
  CreateQuoteRequest,
  EnsoProviderDetails,
  EnsoStatusContext,
  EnsoTransferStatusProviderDetails,
  ExecutionPlan as ApiExecutionPlan,
  ExecutionStep,
  LifiProviderDetails,
  LifiStatusContext,
  LifiTransferStatusProviderDetails,
  Pair,
  PreparedTransaction,
  Quote,
  QuoteProvider,
  RecoveryAction,
  RecoveryContext,
  RecoveryReason,
  RecoveryState,
  RecoveryTransaction,
  RefreshContext,
  RefreshQuoteRequest,
  RouteSummary,
  StatusContext,
  SwapQuote,
  TransferStatus,
  TransferStatusQuery,
  ZeroXFee,
  ZeroXFees,
  ZeroXProviderDetails,
  ZeroXRouteEntry,
  ZeroXStatusContext,
  ZeroXTransferStatusProviderDetails,
} from 'osero-api-v1-contract';

import type {
  OseroApiApprovalStep,
  OseroApiEnsoProviderDetails,
  OseroApiEnsoStatusContext,
  OseroApiEnsoTransferStatusProviderDetails,
  OseroApiExecutionPlan,
  OseroApiExecutionStep,
  OseroApiLifiProviderDetails,
  OseroApiLifiStatusContext,
  OseroApiLifiTransferStatusProviderDetails,
  OseroApiPreparedTransaction,
  OseroApiQuoteProvider,
  OseroApiRecoveryAction,
  OseroApiRecoveryContext,
  OseroApiRecoveryReason,
  OseroApiRecoveryState,
  OseroApiRecoveryTransaction,
  OseroApiRefreshContext,
  OseroApiRouteSummary,
  OseroApiStatusContext,
  OseroApiSwapAsset,
  OseroApiSwapPair,
  OseroApiSwapQuoteEconomics,
  OseroApiSwapQuoteRequest,
  OseroApiSwapQuoteResponse,
  OseroApiTransferStatus,
  OseroApiTransferStatusRequest,
  OseroApiZeroXFee,
  OseroApiZeroXFees,
  OseroApiZeroXProviderDetails,
  OseroApiZeroXRouteEntry,
  OseroApiZeroXStatusContext,
  OseroApiZeroXTransferStatusProviderDetails,
} from '../packages/client/src/api.js';
import type { ExecutionPlan as WalletExecutionPlan } from '../packages/client/src/index.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type KeysMatch<Left, Right> = Equal<keyof Left, keyof Right>;
type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;
type ProviderQuoteDetails = {
  readonly enso: OseroApiEnsoProviderDetails;
  readonly lifi: OseroApiLifiProviderDetails;
  readonly '0x': OseroApiZeroXProviderDetails;
};
type ProviderStatusContext = {
  readonly enso: OseroApiEnsoStatusContext;
  readonly lifi: OseroApiLifiStatusContext;
  readonly '0x': OseroApiZeroXStatusContext;
};
type ProviderTransferStatusDetails = {
  readonly enso: OseroApiEnsoTransferStatusProviderDetails;
  readonly lifi: OseroApiLifiTransferStatusProviderDetails;
  readonly '0x': OseroApiZeroXTransferStatusProviderDetails;
};
type KnownProvider = keyof ProviderQuoteDetails;
type KnownQuote<Provider extends KnownProvider> = Omit<
  OseroApiSwapQuoteResponse,
  'provider' | 'providerDetails' | 'refreshContext' | 'statusContext'
> & {
  readonly provider: Provider;
  readonly providerDetails: ProviderQuoteDetails[Provider];
  readonly refreshContext: Omit<OseroApiRefreshContext, 'provider'> & {
    readonly provider: Provider;
  };
  readonly statusContext: ProviderStatusContext[Provider] | null;
};
type KnownTransferStatus<Provider extends KnownProvider> = Omit<
  OseroApiTransferStatus,
  'provider' | 'providerDetails'
> & {
  readonly provider: Provider;
  readonly providerDetails: ProviderTransferStatusDetails[Provider];
};

export type ApiV1ContractAssertions = [
  Assert<
    Equal<
      keyof OseroApiSwapQuoteRequest,
      'fromAddress' | 'fromAssetId' | 'toAssetId' | 'amount' | 'slippage' | 'referral'
    >
  >,
  Assert<
    Equal<
      keyof CreateQuoteRequest,
      'fromAddress' | 'fromAssetId' | 'toAssetId' | 'amount' | 'slippage' | 'referralCode'
    >
  >,
  Assert<KeysMatch<OseroApiSwapQuoteResponse, SwapQuote>>,
  Assert<KeysMatch<OseroApiSwapPair, Pair>>,
  Assert<KeysMatch<OseroApiSwapQuoteEconomics, Quote>>,
  Assert<KeysMatch<OseroApiRouteSummary, RouteSummary>>,
  Assert<KeysMatch<OseroApiExecutionPlan, ApiExecutionPlan>>,
  Assert<KeysMatch<OseroApiApprovalStep, ApprovalStep>>,
  Assert<KeysMatch<OseroApiExecutionStep, ExecutionStep>>,
  Assert<KeysMatch<OseroApiPreparedTransaction, PreparedTransaction>>,
  Assert<KeysMatch<OseroApiRefreshContext, RefreshContext>>,
  Assert<KeysMatch<OseroApiRefreshContext, RefreshQuoteRequest>>,
  Assert<KeysMatch<OseroApiStatusContext, StatusContext>>,
  Assert<KeysMatch<OseroApiStatusContext, TransferStatusQuery>>,
  Assert<Equal<keyof OseroApiTransferStatusRequest, 'sourceTransactionHash' | 'statusContext'>>,
  Assert<KeysMatch<OseroApiTransferStatus, TransferStatus>>,
  Assert<KeysMatch<OseroApiSwapAsset, Asset>>,
  Assert<OseroApiSwapAsset extends DeepReadonly<Asset> ? true : false>,
  Assert<OseroApiSwapPair extends DeepReadonly<Pair> ? true : false>,
  Assert<OseroApiSwapQuoteEconomics extends DeepReadonly<Quote> ? true : false>,
  Assert<OseroApiRouteSummary extends DeepReadonly<RouteSummary> ? true : false>,
  Assert<OseroApiExecutionPlan extends DeepReadonly<ApiExecutionPlan> ? true : false>,
  Assert<OseroApiApprovalStep extends DeepReadonly<ApprovalStep> ? true : false>,
  Assert<OseroApiExecutionStep extends DeepReadonly<ExecutionStep> ? true : false>,
  Assert<OseroApiPreparedTransaction extends DeepReadonly<PreparedTransaction> ? true : false>,
  Assert<OseroApiEnsoProviderDetails extends DeepReadonly<EnsoProviderDetails> ? true : false>,
  Assert<OseroApiLifiProviderDetails extends DeepReadonly<LifiProviderDetails> ? true : false>,
  Assert<
    OseroApiEnsoTransferStatusProviderDetails extends DeepReadonly<EnsoTransferStatusProviderDetails>
      ? true
      : false
  >,
  Assert<
    OseroApiLifiTransferStatusProviderDetails extends DeepReadonly<LifiTransferStatusProviderDetails>
      ? true
      : false
  >,
  Assert<KnownQuote<'enso'> extends DeepReadonly<SwapQuote> ? true : false>,
  Assert<KnownQuote<'lifi'> extends DeepReadonly<SwapQuote> ? true : false>,
  Assert<KnownTransferStatus<'enso'> extends DeepReadonly<TransferStatus> ? true : false>,
  Assert<KnownTransferStatus<'lifi'> extends DeepReadonly<TransferStatus> ? true : false>,
  Assert<OseroApiExecutionPlan extends WalletExecutionPlan ? false : true>,

  // 0x is one Quote Provider across the same-chain and cross-chain 0x APIs.
  Assert<'0x' extends QuoteProvider ? true : false>,
  Assert<'0x' extends OseroApiQuoteProvider ? true : false>,
  Assert<KnownQuote<'0x'> extends DeepReadonly<SwapQuote> ? true : false>,
  Assert<KnownTransferStatus<'0x'> extends DeepReadonly<TransferStatus> ? true : false>,
  Assert<KeysMatch<OseroApiEnsoStatusContext, EnsoStatusContext>>,
  Assert<KeysMatch<OseroApiLifiStatusContext, LifiStatusContext>>,
  Assert<KeysMatch<OseroApiZeroXStatusContext, ZeroXStatusContext>>,
  Assert<OseroApiZeroXStatusContext extends DeepReadonly<ZeroXStatusContext> ? true : false>,
  // Only 0x carries a Provider Quote ID, and it is required there.
  Assert<'providerQuoteId' extends keyof OseroApiZeroXStatusContext ? true : false>,
  Assert<'providerQuoteId' extends keyof OseroApiEnsoStatusContext ? false : true>,
  Assert<'providerQuoteId' extends keyof OseroApiLifiStatusContext ? false : true>,
  Assert<KeysMatch<OseroApiZeroXProviderDetails, ZeroXProviderDetails>>,
  Assert<KeysMatch<OseroApiZeroXRouteEntry, ZeroXRouteEntry>>,
  Assert<KeysMatch<OseroApiZeroXFees, ZeroXFees>>,
  Assert<KeysMatch<OseroApiZeroXFee, ZeroXFee>>,
  Assert<OseroApiZeroXProviderDetails extends DeepReadonly<ZeroXProviderDetails> ? true : false>,
  Assert<KeysMatch<OseroApiZeroXTransferStatusProviderDetails, ZeroXTransferStatusProviderDetails>>,
  Assert<
    OseroApiZeroXTransferStatusProviderDetails extends DeepReadonly<ZeroXTransferStatusProviderDetails>
      ? true
      : false
  >,

  // Recovery is normalized by the API, so both enumerations are closed.
  Assert<Equal<OseroApiRecoveryState, RecoveryState>>,
  Assert<Equal<OseroApiRecoveryReason, RecoveryReason>>,
  Assert<KeysMatch<OseroApiRecoveryContext, RecoveryContext>>,
  Assert<KeysMatch<OseroApiRecoveryAction, RecoveryAction>>,
  Assert<KeysMatch<OseroApiRecoveryTransaction, RecoveryTransaction>>,
  Assert<OseroApiRecoveryContext extends DeepReadonly<RecoveryContext> ? true : false>,
  Assert<OseroApiRecoveryAction extends DeepReadonly<RecoveryAction> ? true : false>,
  Assert<OseroApiRecoveryTransaction extends DeepReadonly<RecoveryTransaction> ? true : false>,
  // A Recovery Transaction is sender-free: any caller may submit it.
  Assert<'sender' extends keyof RecoveryTransaction ? false : true>,
  Assert<'sender' extends keyof OseroApiRecoveryTransaction ? false : true>,
  Assert<'recoveryContext' extends keyof OseroApiTransferStatus ? true : false>,
];
