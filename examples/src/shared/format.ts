import {
  tokenAmount,
  type ExecutionPlan,
  type TokenAmount,
  type TokenSymbol,
  type TransactionRequest,
  type TransactionResult,
} from '@osero/client';
import { formatUnits } from 'viem';

export function banner(title: string): void {
  const line = '='.repeat(Math.max(title.length + 4, 40));
  console.log(`\n${line}\n  ${title}\n${line}`);
}

export function formatToken(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

export function requireTokenAmount<Symbol extends TokenSymbol>(
  symbol: Symbol,
  raw: bigint,
): TokenAmount<Symbol> {
  const result = tokenAmount(symbol, raw);
  if (result.isErr()) throw result.error;
  return result.value;
}

export function describePlan(plan: ExecutionPlan): string {
  const lines = [
    `ExecutionPlan ${plan.id}`,
    `  source: ${plan.metadata.source}`,
    `  steps:  ${plan.steps.length}`,
  ];
  plan.steps.forEach((step, index) => {
    lines.push(`  step[${index}] ${step.id}:`);
    lines.push(describeTransactionRequest(step, '    '));
  });
  return lines.join('\n');
}

function describeTransactionRequest(tx: TransactionRequest, indent: string): string {
  return [
    `${indent}operation: ${tx.operation}`,
    `${indent}chainId:   ${tx.chainId}`,
    `${indent}from:      ${tx.from}`,
    `${indent}to:        ${tx.to}`,
    `${indent}value:     ${tx.value}`,
    `${indent}data:      ${truncateHex(tx.data)}`,
    ...(tx.estimatedGas === undefined
      ? []
      : [`${indent}estimatedGas: ${tx.estimatedGas.gas} (${tx.estimatedGas.source}, advisory)`]),
  ].join('\n');
}

function truncateHex(hex: string): string {
  if (hex.length <= 22) return hex;
  return `${hex.slice(0, 18)}…${hex.slice(-4)}`;
}

export function describeResult(result: TransactionResult, explorerUrl?: string): string {
  const finalLink = explorerUrl
    ? `${explorerUrl.replace(/\/$/, '')}/tx/${result.txHash}`
    : result.txHash;
  return [
    `  planId:      ${result.planId}`,
    `  transactions: ${result.transactions.length}`,
    `  operations:  ${result.transactions.map((transaction) => transaction.operation).join(' → ')}`,
    `  final hash:  ${result.txHash}`,
    `  explorer:    ${finalLink}`,
  ].join('\n');
}
