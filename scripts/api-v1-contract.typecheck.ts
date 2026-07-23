import type {
  ApprovalStep,
  Asset,
  CreateQuoteRequest,
  EnsoProviderDetails,
  EnsoTransferStatusProviderDetails,
  ExecutionPlan as ApiExecutionPlan,
  ExecutionStep,
  LifiProviderDetails,
  LifiTransferStatusProviderDetails,
  Pair,
  PreparedTransaction,
  Quote,
  RefreshContext,
  RefreshQuoteRequest,
  RouteSummary,
  StatusContext,
  SwapQuote,
  TransferStatus,
  TransferStatusQuery,
} from 'osero-api-v1-contract';

import type {
  OseroApiApprovalStep,
  OseroApiEnsoProviderDetails,
  OseroApiEnsoTransferStatusProviderDetails,
  OseroApiExecutionPlan,
  OseroApiExecutionStep,
  OseroApiLifiProviderDetails,
  OseroApiLifiTransferStatusProviderDetails,
  OseroApiPreparedTransaction,
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
type KnownQuote<Provider extends 'enso' | 'lifi'> = Omit<
  OseroApiSwapQuoteResponse,
  'provider' | 'providerDetails' | 'refreshContext' | 'statusContext'
> & {
  readonly provider: Provider;
  readonly providerDetails: Provider extends 'enso'
    ? OseroApiEnsoProviderDetails
    : OseroApiLifiProviderDetails;
  readonly refreshContext: Omit<OseroApiRefreshContext, 'provider'> & {
    readonly provider: Provider;
  };
  readonly statusContext:
    | (Omit<OseroApiStatusContext, 'provider'> & { readonly provider: Provider })
    | null;
};
type KnownTransferStatus<Provider extends 'enso' | 'lifi'> = Omit<
  OseroApiTransferStatus,
  'provider' | 'providerDetails'
> & {
  readonly provider: Provider;
  readonly providerDetails: Provider extends 'enso'
    ? OseroApiEnsoTransferStatusProviderDetails
    : OseroApiLifiTransferStatusProviderDetails;
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
];
