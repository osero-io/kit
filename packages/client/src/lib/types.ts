import type { Address, Hex } from 'viem';

import type {
  CancelError,
  InsufficientBalanceError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
} from './errors.js';
import type { ResultAsync } from './result.js';

/**
 * Stable identifier for what an on-chain transaction is doing. Used as
 * a lightweight provenance tag on every {@link TransactionRequest} so
 * that adapters and callers can classify the step they're looking at
 * without having to decode calldata.
 */
export type OperationType =
  | 'APPROVE_ERC20'
  | 'MINT_USDS'
  | 'MINT_SUSDS'
  | 'DEPOSIT_USDS_FOR_SUSDS'
  | 'REDEEM_USDS_FOR_USDC'
  | 'REDEEM_SUSDS_FOR_USDC'
  | 'REDEEM_SUSDS_FOR_USDS';

/**
 * A fully-baked EVM transaction that can be handed to a wallet with
 * no further processing. The wallet is responsible only for gas
 * estimation, nonce selection, and signing.
 */
export type TransactionRequest = {
  readonly __typename: 'TransactionRequest';
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly operation: OperationType;
};

/**
 * A single ERC-20 approval prerequisite attached to an
 * {@link Erc20ApprovalRequired} plan. The `byTransaction` field is
 * the concrete transaction that performs the approval.
 */
export type Erc20Approval = {
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
  readonly byTransaction: TransactionRequest;
};

/**
 * An action whose final transaction cannot be sent until one or more
 * ERC-20 approvals have landed on-chain. The executor is expected to
 * submit every approval in order before broadcasting
 * {@link Erc20ApprovalRequired.originalTransaction | originalTransaction}.
 */
export type Erc20ApprovalRequired = {
  readonly __typename: 'Erc20ApprovalRequired';
  readonly approvals: readonly Erc20Approval[];
  readonly originalTransaction: TransactionRequest;
};

/**
 * Either a self-contained tx or an approval-gated tx — i.e. anything
 * that an executor can process in a single linear phase.
 */
export type ExecutionStep = TransactionRequest | Erc20ApprovalRequired;

/**
 * A multi-phase action (e.g. mainnet USDC → USDS → sUSDS) whose
 * downstream steps depend on upstream ones having landed on-chain.
 * Steps are executed strictly in order and every step in `steps[i]`
 * must confirm before `steps[i+1]` starts.
 */
export type MultiStepExecution = {
  readonly __typename: 'MultiStepExecution';
  readonly steps: readonly ExecutionStep[];
};

/**
 * The full union of things an action can return. Adapters
 * ({@link ExecutionPlanHandler}) pattern-match on `__typename` to
 * dispatch to the right execution strategy.
 */
export type ExecutionPlan = TransactionRequest | Erc20ApprovalRequired | MultiStepExecution;

/**
 * The outcome of running an {@link ExecutionPlan} end-to-end. `txHash`
 * is the hash of the *final* transaction in the plan — the tx that
 * produces the caller's intended state change.
 *
 * `operations` lists every semantic operation that ran, in order. For
 * a simple swap this is a single entry; for a mainnet sUSDS mint it
 * is `['APPROVE_ERC20', 'MINT_USDS', 'APPROVE_ERC20', 'DEPOSIT_USDS_FOR_SUSDS']`.
 */
export type TransactionResult = {
  readonly txHash: Hex;
  readonly operations: readonly OperationType[];
};

/**
 * Every error an {@link ExecutionPlanHandler} can produce.
 */
export type SendWithError = CancelError | SigningError | TransactionError | UnexpectedError;

/**
 * An executor function that takes an {@link ExecutionPlan} and runs it
 * against a concrete wallet (viem `WalletClient`, ethers `Signer`,
 * etc.). Adapters curry it so that `sendWith(wallet)` returns an
 * {@link ExecutionPlanHandler} ready to be chained with `.andThen()`.
 */
export type ExecutionPlanHandler<T extends ExecutionPlan = ExecutionPlan> = (
  result: T,
) => ResultAsync<TransactionResult, SendWithError>;

/**
 * The superset of errors that a plan-building action can return before
 * it is handed off to a wallet adapter. Actions surface validation
 * problems, unsupported chains, insufficient balance, and transport
 * failures through this union.
 */
export type ActionError =
  | ValidationError
  | UnsupportedChainError
  | InsufficientBalanceError
  | UnexpectedError;
