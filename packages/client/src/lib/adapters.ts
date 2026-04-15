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
  const transactions = flattenExecutionPlan(plan);
  const operations = transactions.map((tx) => tx.operation);

  if (transactions.length === 0) {
    return errAsync(UnexpectedError.from(new Error('Execution plan has no transactions')));
  }

  const initial: ResultAsync<`0x${string}`, SendWithError> = execute(transactions[0]!);

  const final = transactions
    .slice(1)
    .reduce<typeof initial>((acc, tx) => acc.andThen(() => execute(tx)), initial);

  return final.andThen((txHash) =>
    okAsync({
      txHash,
      operations,
    } satisfies TransactionResult),
  );
}
