import { createWalletClient, custom } from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { UnexpectedError } from './lib/errors.js';
import { makeTransactionRequest } from './lib/plan.js';
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

  it('rejects transactions targeting a different chain before estimating gas', async () => {
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
    const request = makeTransactionRequest({
      chainId: mainnet.id,
      from: ACCOUNT,
      to: '0x2222222222222222222222222222222222222222',
      data: '0x',
      operation: 'MINT_USDS',
    });

    const result = await sendWith(wallet, request);

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
  });
});
