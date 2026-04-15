import { type Address, encodeFunctionData, type Hex } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import type {
  Erc20Approval,
  Erc20ApprovalRequired,
  ExecutionStep,
  MultiStepExecution,
  OperationType,
  TransactionRequest,
} from './types.js';

/**
 * Build a concrete {@link TransactionRequest} from its pre-encoded
 * calldata. Does no ABI work itself — callers that need to encode
 * arguments should do that with viem's `encodeFunctionData` and pass
 * the result here.
 *
 * @internal
 */
export function makeTransactionRequest(args: {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  operation: OperationType;
}): TransactionRequest {
  return {
    __typename: 'TransactionRequest',
    chainId: args.chainId,
    from: args.from,
    to: args.to,
    data: args.data,
    value: args.value ?? 0n,
    operation: args.operation,
  };
}

/**
 * Build a standalone ERC-20 `approve` transaction.
 *
 * @internal
 */
export function makeApprovalTransaction(args: {
  chainId: number;
  from: Address;
  token: Address;
  spender: Address;
  amount: bigint;
}): TransactionRequest {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [args.spender, args.amount],
  });
  return makeTransactionRequest({
    chainId: args.chainId,
    from: args.from,
    to: args.token,
    data,
    operation: 'APPROVE_ERC20',
  });
}

/**
 * Build an {@link Erc20ApprovalRequired} plan — a single main tx
 * gated behind one or more ERC-20 approvals.
 *
 * @internal
 */
export function makeApprovalRequiredPlan(
  originalTransaction: TransactionRequest,
  approvals: readonly Erc20Approval[],
): Erc20ApprovalRequired {
  return {
    __typename: 'Erc20ApprovalRequired',
    approvals,
    originalTransaction,
  };
}

/**
 * Helper that packages an approval tx + main tx into a single
 * {@link Erc20ApprovalRequired} step. The most common shape produced
 * by a PSM swap action.
 *
 * @internal
 */
export function makeSingleApprovalPlan(args: {
  chainId: number;
  from: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  mainTransaction: TransactionRequest;
}): Erc20ApprovalRequired {
  const approvalTx = makeApprovalTransaction({
    chainId: args.chainId,
    from: args.from,
    token: args.token,
    spender: args.spender,
    amount: args.amount,
  });
  return makeApprovalRequiredPlan(args.mainTransaction, [
    {
      token: args.token,
      spender: args.spender,
      amount: args.amount,
      byTransaction: approvalTx,
    },
  ]);
}

/**
 * Build a {@link MultiStepExecution} from an ordered list of steps.
 *
 * @internal
 */
export function makeMultiStepPlan(steps: readonly ExecutionStep[]): MultiStepExecution {
  return {
    __typename: 'MultiStepExecution',
    steps,
  };
}
