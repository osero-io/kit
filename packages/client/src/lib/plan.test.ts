import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import {
  makeApprovalRequiredPlan,
  makeApprovalTransaction,
  makeMultiStepPlan,
  makeSingleApprovalPlan,
  makeTransactionRequest,
} from './plan.js';

const SENDER: Address = '0x1111111111111111111111111111111111111111';
const TOKEN: Address = '0x2222222222222222222222222222222222222222';
const SPENDER: Address = '0x3333333333333333333333333333333333333333';

describe('makeTransactionRequest', () => {
  it('defaults `value` to 0n', () => {
    const tx = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: TOKEN,
      data: '0xdeadbeef',
      operation: 'MINT_USDS',
    });
    expect(tx.value).toBe(0n);
    expect(tx.__typename).toBe('TransactionRequest');
    expect(tx.operation).toBe('MINT_USDS');
  });

  it('respects a provided value', () => {
    const tx = makeTransactionRequest({
      chainId: 8453,
      from: SENDER,
      to: TOKEN,
      data: '0xdeadbeef',
      value: 42n,
      operation: 'APPROVE_ERC20',
    });
    expect(tx.value).toBe(42n);
    expect(tx.chainId).toBe(8453);
  });
});

describe('makeApprovalTransaction', () => {
  it('encodes an ERC-20 approve call with the given spender/amount', () => {
    const tx = makeApprovalTransaction({
      chainId: 8453,
      from: SENDER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1_000_000n,
    });
    expect(tx.operation).toBe('APPROVE_ERC20');
    expect(tx.to).toBe(TOKEN);
    expect(tx.from).toBe(SENDER);
    expect(tx.value).toBe(0n);
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args?.[0]).toBe(SPENDER);
    expect(decoded.args?.[1]).toBe(1_000_000n);
  });
});

describe('makeSingleApprovalPlan', () => {
  it('packages approval + main tx into an Erc20ApprovalRequired', () => {
    const mainTx = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: SPENDER,
      data: '0xbeef' satisfies Hex,
      operation: 'MINT_USDS',
    });
    const plan = makeSingleApprovalPlan({
      chainId: 1,
      from: SENDER,
      token: TOKEN,
      spender: SPENDER,
      amount: 500n,
      mainTransaction: mainTx,
    });
    expect(plan.__typename).toBe('Erc20ApprovalRequired');
    expect(plan.approvals).toHaveLength(1);
    expect(plan.approvals[0]!.token).toBe(TOKEN);
    expect(plan.approvals[0]!.spender).toBe(SPENDER);
    expect(plan.approvals[0]!.amount).toBe(500n);
    expect(plan.originalTransaction).toBe(mainTx);
  });
});

describe('makeApprovalRequiredPlan', () => {
  it('builds a plan from a pre-computed approval list', () => {
    const mainTx = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: SPENDER,
      data: '0xcafe',
      operation: 'MINT_USDS',
    });
    const approveTx = makeApprovalTransaction({
      chainId: 1,
      from: SENDER,
      token: TOKEN,
      spender: SPENDER,
      amount: 1n,
    });
    const plan = makeApprovalRequiredPlan(mainTx, [
      {
        token: TOKEN,
        spender: SPENDER,
        amount: 1n,
        byTransaction: approveTx,
      },
    ]);
    expect(plan.approvals[0]!.byTransaction).toBe(approveTx);
    expect(plan.originalTransaction).toBe(mainTx);
  });
});

describe('makeMultiStepPlan', () => {
  it('wraps an ordered list of steps into a MultiStepExecution', () => {
    const step1 = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: SPENDER,
      data: '0x01',
      operation: 'MINT_USDS',
    });
    const step2 = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: SPENDER,
      data: '0x02',
      operation: 'DEPOSIT_USDS_FOR_SUSDS',
    });
    const plan = makeMultiStepPlan([step1, step2]);
    expect(plan.__typename).toBe('MultiStepExecution');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toBe(step1);
    expect(plan.steps[1]).toBe(step2);
  });
});

// Sanity check that our ABI encoding agrees with viem's canonical
// encoder for ERC-20 approve.
describe('encoding parity with viem', () => {
  it('produces the same approve calldata as encodeFunctionData', () => {
    const sdkData = makeApprovalTransaction({
      chainId: 1,
      from: SENDER,
      token: TOKEN,
      spender: SPENDER,
      amount: 12345n,
    }).data;
    const viemData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [SPENDER, 12345n],
    });
    expect(sdkData).toBe(viemData);
  });
});
