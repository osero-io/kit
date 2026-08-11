import { CancelError, SigningError, TransactionError, UnexpectedError } from './errors.js';
import { errAsync, okAsync, type ResultAsync } from './result.js';
import type {
  Erc20ApprovalRequired,
  ExecutionPlan,
  ExecutionStep,
  MultiStepExecution,
  OperationType,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './types.js';

/**
 * Narrowing guard for a concrete {@link TransactionRequest}.
 *
 * @internal
 */
export function isTransactionRequest(
  plan: ExecutionPlan | ExecutionStep,
): plan is TransactionRequest {
  return plan.__typename === 'TransactionRequest';
}

/**
 * Narrowing guard for an approval-gated plan.
 *
 * @internal
 */
export function isErc20ApprovalRequired(
  plan: ExecutionPlan | ExecutionStep,
): plan is Erc20ApprovalRequired {
  return plan.__typename === 'Erc20ApprovalRequired';
}

/**
 * Narrowing guard for a multi-phase plan.
 *
 * @internal
 */
export function isMultiStepExecution(plan: ExecutionPlan): plan is MultiStepExecution {
  return plan.__typename === 'MultiStepExecution';
}

/**
 * Walk an {@link ExecutionPlan} and return the ordered sequence of
 * {@link TransactionRequest}s that a wallet needs to broadcast,
 * exactly as they will be executed.
 *
 * Useful for previews, gas estimation, and inspection. The adapters
 * use this internally too — it keeps the viem and ethers send loops
 * identical aside from the actual `sendTransaction` call.
 *
 * Dynamic `refresh` hooks are not executed here. For refreshable
 * multi-step plans this returns the static fallback transactions that
 * are suitable for display, not necessarily the exact phase-2 calldata
 * the SDK adapters will rebuild during execution.
 */
export function flattenExecutionPlan(plan: ExecutionPlan): readonly TransactionRequest[] {
  if (isTransactionRequest(plan)) {
    return [plan];
  }
  if (isErc20ApprovalRequired(plan)) {
    const approvalTxs = plan.approvals.map((a) => a.byTransaction);
    return [...approvalTxs, plan.originalTransaction];
  }
  return plan.steps.flatMap((step) => flattenExecutionPlan(step));
}

/**
 * Extract the semantic {@link OperationType} sequence from an
 * execution plan, in the same order that
 * {@link flattenExecutionPlan} produces.
 *
 * @internal
 */
export function operationsFor(plan: ExecutionPlan): readonly OperationType[] {
  return flattenExecutionPlan(plan).map((tx) => tx.operation);
}

/**
 * Signature of the low-level per-transaction sender that each wallet
 * adapter provides. It takes a single {@link TransactionRequest},
 * broadcasts it, waits for confirmation, and returns the final tx
 * hash (or a typed error).
 *
 * @internal
 */
export type SingleTxExecutor = (
  tx: TransactionRequest,
) => ResultAsync<`0x${string}`, CancelError | SigningError | TransactionError | UnexpectedError>;

type RunState = {
  readonly txHash?: TransactionResult['txHash'];
  readonly operations: readonly OperationType[];
};

function runTransaction(
  tx: TransactionRequest,
  execute: SingleTxExecutor,
  state: RunState,
): ResultAsync<RunState, SendWithError> {
  return execute(tx).map((txHash) => ({
    txHash,
    operations: [...state.operations, tx.operation],
  }));
}

function runTransactions(
  transactions: readonly TransactionRequest[],
  execute: SingleTxExecutor,
  state: RunState,
): ResultAsync<RunState, SendWithError> {
  return transactions.reduce<ResultAsync<RunState, SendWithError>>(
    (acc, tx) => acc.andThen((current) => runTransaction(tx, execute, current)),
    okAsync(state),
  );
}

function runApprovalRequired(
  plan: Erc20ApprovalRequired,
  execute: SingleTxExecutor,
  state: RunState,
): ResultAsync<RunState, SendWithError> {
  const resolved = plan.refresh ? plan.refresh({ previousTxHash: state.txHash }) : okAsync(plan);

  return resolved.andThen((current) =>
    runTransactions(
      [...current.approvals.map((approval) => approval.byTransaction), current.originalTransaction],
      execute,
      state,
    ),
  );
}

function runExecutionNode(
  plan: ExecutionPlan | ExecutionStep,
  execute: SingleTxExecutor,
  state: RunState,
): ResultAsync<RunState, SendWithError> {
  if (isTransactionRequest(plan)) {
    return runTransaction(plan, execute, state);
  }
  if (isErc20ApprovalRequired(plan)) {
    return runApprovalRequired(plan, execute, state);
  }

  return plan.steps.reduce<ResultAsync<RunState, SendWithError>>(
    (acc, step) => acc.andThen((current) => runExecutionNode(step, execute, current)),
    okAsync(state),
  );
}

/**
 * Run an {@link ExecutionPlan} against a wallet-specific
 * {@link SingleTxExecutor}. Every adapter in the SDK reduces to this
 * loop: viem and ethers only differ in how they send a single
 * transaction.
 *
 * The executor is called once per transaction, in strict order.
 * Each call must resolve before the next one is started — so an
 * approval lands before the swap that relies on it, and the first
 * phase of a multi-step plan confirms before the second phase
 * begins.
 *
 * @internal
 */
export function runExecutionPlan(
  plan: ExecutionPlan,
  execute: SingleTxExecutor,
): ResultAsync<TransactionResult, SendWithError> {
  return runExecutionNode(plan, execute, { operations: [] }).andThen((state) => {
    if (!state.txHash) {
      return errAsync(UnexpectedError.from(new Error('Execution plan has no transactions')));
    }
    return okAsync({
      txHash: state.txHash,
      operations: state.operations,
    } satisfies TransactionResult);
  });
}
