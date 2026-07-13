import type { Address, Hex } from 'viem';

import type { OseroChainId, ProtocolKind, SwapMode, TokenSymbol } from './capabilities.js';
import type { AdvisoryGasEstimate, AllowanceSnapshot, Slippage, TokenAmount } from './domain.js';
import type {
  AccountMismatchError,
  BroadcastError,
  CancelError,
  ChainMismatchError,
  ConfigurationError,
  ConfirmationError,
  ProgressCallbackError,
  RpcError,
  SimulationError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedCapabilityError,
  ValidationError,
} from './errors.js';
import type { ResultAsync } from './result.js';

export type OperationType =
  | 'APPROVE_ERC20'
  | 'SWAP_EXACT_IN'
  | 'SWAP_EXACT_OUT'
  | 'MINT_USDS'
  | 'DEPOSIT_USDS_FOR_SUSDS'
  | 'MINT_SUSDS_WITH_USDS'
  | 'REDEEM_USDS_FOR_USDC'
  | 'REDEEM_SUSDS_FOR_USDS'
  | 'WITHDRAW_USDS_FROM_SUSDS';

export type ApprovalAuthorization = {
  readonly kind: 'erc20-approval';
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly amount: bigint;
};

export type TransactionRequest = {
  readonly __typename: 'TransactionRequest';
  readonly id: string;
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly operation: OperationType;
  readonly authorization?: ApprovalAuthorization;
  readonly estimatedGas?: AdvisoryGasEstimate;
};

export type ExecutorRequirements = {
  readonly execution: 'sequential' | 'atomic-batch';
  readonly authorization: 'transactions' | 'permit';
  readonly sponsored: boolean;
  readonly chainTransitions: boolean;
};

export type ExecutionPlanMetadata = {
  readonly source: 'local' | 'hosted-api' | 'custom';
  readonly allowanceSnapshots?: readonly AllowanceSnapshot[];
  readonly quoteId?: string;
};

export type ExecutionPlan = {
  readonly __typename: 'ExecutionPlan';
  readonly version: 1;
  readonly id: string;
  readonly steps: readonly TransactionRequest[];
  readonly requirements: ExecutorRequirements;
  readonly metadata: ExecutionPlanMetadata;
};

export type TransactionConfirmation = {
  readonly status: 'success';
  readonly transactionHash: Hex;
  readonly blockNumber?: bigint;
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
  readonly confirmations: number;
};

export type ConfirmedTransaction = {
  readonly planId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly operation: OperationType;
  readonly submittedHash: Hex;
  readonly hash: Hex;
  readonly replacement?: {
    readonly reason: string;
    readonly originalHash: Hex;
    readonly replacementHash: Hex;
  };
  readonly confirmation: TransactionConfirmation;
};

export type TransactionResult = {
  readonly planId: string;
  readonly transactions: readonly ConfirmedTransaction[];
  /** Convenience alias for the final effective transaction hash. */
  readonly txHash: Hex;
};

export type ExecutionResumeState = {
  readonly planId: string;
  readonly confirmed: readonly ConfirmedTransaction[];
};

export type ExecutionProgress =
  | {
      readonly type: 'preflight-complete';
      readonly planId: string;
      readonly totalSteps: number;
      readonly resumedSteps: number;
    }
  | {
      readonly type: 'step-started';
      readonly planId: string;
      readonly stepId: string;
      readonly stepIndex: number;
      readonly operation: OperationType;
    }
  | {
      readonly type: 'step-submitted';
      readonly planId: string;
      readonly stepId: string;
      readonly stepIndex: number;
      readonly operation: OperationType;
      readonly hash: Hex;
    }
  | {
      readonly type: 'step-confirmed';
      readonly transaction: ConfirmedTransaction;
    }
  | {
      readonly type: 'plan-completed';
      readonly result: TransactionResult;
    };

export type ProgressHandler = (progress: ExecutionProgress) => void | Promise<void>;

export type ExecutorCapabilities = {
  readonly name: string;
  readonly sequentialTransactions: true;
  readonly atomicBatch: boolean;
  readonly permitAuthorization: boolean;
  readonly sponsoredTransactions: boolean;
  readonly chainSwitching: 'none' | 'explicit';
  readonly simulation: 'none' | 'independent-steps' | 'full-plan';
};

export type ConfirmationOptions = {
  readonly confirmations?: number;
  readonly onProgress?: ProgressHandler;
  readonly resume?: ExecutionResumeState;
};

export type SendWithError =
  | ValidationError
  | ConfigurationError
  | AccountMismatchError
  | ChainMismatchError
  | UnsupportedCapabilityError
  | CancelError
  | SimulationError
  | SigningError
  | BroadcastError
  | ConfirmationError
  | TransactionError
  | ProgressCallbackError
  | RpcError
  | UnexpectedError;

export type ExecutionPlanHandler = (
  plan: ExecutionPlan,
) => ResultAsync<TransactionResult, SendWithError>;

export type PreparedSwapRoute = {
  readonly chainId: OseroChainId;
  readonly protocol: ProtocolKind;
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  readonly mode: SwapMode;
  readonly steps: readonly OperationType[];
};

export type PreparedSwapQuoteCommon<AssetIn extends TokenSymbol, AssetOut extends TokenSymbol> = {
  readonly assetIn: AssetIn;
  readonly assetOut: AssetOut;
  readonly slippage: Slippage;
  readonly route: PreparedSwapRoute;
  readonly slippageProtection: {
    readonly bound: 'minimum-output' | 'maximum-input';
    readonly enforcedBy: 'calldata' | 'allowance' | 'none';
  };
  readonly quotedAt: {
    readonly blockNumber: bigint;
  };
  readonly protocolFee: {
    readonly kind: 'none' | 'lite-psm';
    readonly tin?: bigint;
    readonly tout?: bigint;
  };
  readonly plan: ExecutionPlan;
};

export type PreparedExactInSwapQuote<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = PreparedSwapQuoteCommon<AssetIn, AssetOut> & {
  readonly mode: 'exact-in';
  readonly amountIn: TokenAmount<AssetIn>;
  readonly expectedAmountOut: TokenAmount<AssetOut>;
  readonly minimumAmountOut: TokenAmount<AssetOut>;
};

export type PreparedExactOutSwapQuote<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = PreparedSwapQuoteCommon<AssetIn, AssetOut> & {
  readonly mode: 'exact-out';
  readonly amountOut: TokenAmount<AssetOut>;
  readonly expectedAmountIn: TokenAmount<AssetIn>;
  readonly maximumAmountIn: TokenAmount<AssetIn>;
};

export type PreparedSwapQuote<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = PreparedExactInSwapQuote<AssetIn, AssetOut> | PreparedExactOutSwapQuote<AssetIn, AssetOut>;
