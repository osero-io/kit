import { createWalletClient, custom } from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { UnexpectedError } from './lib/errors.js';
import { makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest } from './lib/plan.js';
import type { ExecutionPlan } from './lib/types.js';
import { sendWith } from './viem.js';

const actionMocks = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: unknown[]) => Promise<bigint>>(),
  sendTransaction: vi.fn<(...args: unknown[]) => Promise<`0x${string}`>>(),
  waitForTransactionReceipt: vi.fn<
    (...args: unknown[]) => Promise<{
      readonly status: 'success';
      readonly transactionHash: `0x${string}`;
    }>
  >(),
}));

vi.mock('viem/actions', () => ({
  estimateGas: actionMocks.estimateGas,
  sendTransaction: actionMocks.sendTransaction,
  waitForTransactionReceipt: actionMocks.waitForTransactionReceipt,
}));

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x3333333333333333333333333333333333333333';
const TARGET = '0x4444444444444444444444444444444444444444';

describe('viem sendWith', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    actionMocks.estimateGas.mockResolvedValue(21_000n);
    actionMocks.sendTransaction.mockResolvedValue(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    actionMocks.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it.each([
    ['bare transaction', () => makeTargetTransaction()],
    [
      'approval-gated plan',
      () =>
        makeSingleApprovalPlan({
          chainId: mainnet.id,
          from: ACCOUNT,
          token: TOKEN,
          spender: SPENDER,
          amount: 1n,
          mainTransaction: makeTargetTransaction(),
        }),
    ],
    [
      'multi-step plan',
      () =>
        makeMultiStepPlan([
          makeSingleApprovalPlan({
            chainId: mainnet.id,
            from: ACCOUNT,
            token: TOKEN,
            spender: SPENDER,
            amount: 1n,
            mainTransaction: makeTargetTransaction(),
          }),
          makeTargetTransaction(),
        ]),
    ],
  ] satisfies ReadonlyArray<readonly [string, () => ExecutionPlan]>)(
    'rejects a %s targeting a different chain before estimating gas',
    async (_label, makePlan) => {
      const wallet = createWalletClient({
        account: ACCOUNT,
        chain: base,
        transport: custom({
          request:
            vi.fn<
              (args: { readonly method: string; readonly params?: unknown }) => Promise<unknown>
            >(),
        }),
      });

      const result = await sendWith(wallet, makePlan());

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnexpectedError);
        expect(result.error.message).toBe(
          'viem WalletClient is on chain 8453 but the transaction targets chain 1',
        );
      }
      expect(actionMocks.estimateGas).not.toHaveBeenCalled();
      expect(actionMocks.sendTransaction).not.toHaveBeenCalled();
      expect(actionMocks.waitForTransactionReceipt).not.toHaveBeenCalled();
    },
  );
});

function makeTargetTransaction() {
  return makeTransactionRequest({
    chainId: mainnet.id,
    from: ACCOUNT,
    to: TARGET,
    data: '0x',
    operation: 'MINT_USDS',
  });
}
