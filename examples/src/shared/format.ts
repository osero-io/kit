import type {
  Erc20ApprovalRequired,
  ExecutionPlan,
  MultiStepExecution,
  TransactionRequest,
  TransactionResult,
} from '@osero/client';
import { formatUnits } from 'viem';

/**
 * Print a section banner so the script output reads like a narrative
 * instead of a wall of hex.
 */
export function banner(title: string): void {
  const line = '='.repeat(Math.max(title.length + 4, 40));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

/**
 * Format an amount of USDC (6 dec), USDS or sUSDS (18 dec).
 */
export function formatToken(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

/**
 * Render an {@link ExecutionPlan} as a short human-readable tree so
 * you can eyeball what `sendWith` is about to broadcast.
 */
export function describePlan(plan: ExecutionPlan): string {
  switch (plan.__typename) {
    case 'TransactionRequest':
      return `TransactionRequest\n${describeTransactionRequest(plan, '  ')}`;
    case 'Erc20ApprovalRequired':
      return describeApprovalPlan(plan);
    case 'MultiStepExecution':
      return describeMultiStepPlan(plan);
  }
}

function describeTransactionRequest(tx: TransactionRequest, indent: string): string {
  const lines = [
    `${indent}operation: ${tx.operation}`,
    `${indent}chainId:   ${tx.chainId}`,
    `${indent}from:      ${tx.from}`,
    `${indent}to:        ${tx.to}`,
    `${indent}value:     ${tx.value}`,
    `${indent}data:      ${truncateHex(tx.data)}`,
  ];
  return lines.join('\n');
}

function describeApprovalPlan(plan: Erc20ApprovalRequired): string {
  const lines: string[] = ['Erc20ApprovalRequired'];
  plan.approvals.forEach((approval, i) => {
    lines.push(`  approval[${i}]: ${approval.token} → ${approval.spender}`);
    lines.push(`    amount: ${approval.amount}`);
    lines.push(`    tx:`);
    lines.push(describeTransactionRequest(approval.byTransaction, '      '));
  });
  lines.push('  originalTransaction:');
  lines.push(describeTransactionRequest(plan.originalTransaction, '    '));
  return lines.join('\n');
}

function describeMultiStepPlan(plan: MultiStepExecution): string {
  const lines: string[] = [`MultiStepExecution (${plan.steps.length} steps)`];
  plan.steps.forEach((step, i) => {
    lines.push(`  step[${i}]:`);
    if (step.__typename === 'TransactionRequest') {
      lines.push(describeTransactionRequest(step, '    '));
    } else {
      const sub = describeApprovalPlan(step)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(sub);
    }
  });
  return lines.join('\n');
}

function truncateHex(hex: string): string {
  if (hex.length <= 22) return hex;
  return `${hex.slice(0, 18)}…${hex.slice(-4)}`;
}

/**
 * Render a {@link TransactionResult} after a successful `sendWith`.
 */
export function describeResult(result: TransactionResult, explorerUrl?: string): string {
  const link = explorerUrl
    ? `${explorerUrl.replace(/\/$/, '')}/tx/${result.txHash}`
    : result.txHash;
  return [
    `  txHash:     ${result.txHash}`,
    `  operations: ${result.operations.join(' → ')}`,
    `  explorer:   ${link}`,
  ].join('\n');
}
