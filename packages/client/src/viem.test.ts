import type { WalletClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { UnexpectedError } from './lib/errors.js';
import { makeTransactionRequest } from './lib/plan.js';
import { sendWith } from './viem.js';

const actions = vi.hoisted(() => ({
  estimateGas: vi.fn<() => Promise<bigint>>(),
  sendTransaction: vi.fn<() => Promise<`0x${string}`>>(),
  waitForTransactionReceipt:
    vi.fn<() => Promise<{ readonly status: 'success'; readonly transactionHash: `0x${string}` }>>(),
}));

vi.mock('viem/actions', () => actions);

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;
const HASH = `0x${'1'.repeat(64)}` as const;

function walletOn(chain: typeof mainnet | typeof base): WalletClient {
  return {
    account: { address: WALLET, type: 'json-rpc' },
    chain,
  } as unknown as WalletClient;
}

function requestFor(chainId: number) {
  return makeTransactionRequest({
    chainId,
    from: WALLET,
    to: TARGET,
    data: '0x1234',
    operation: 'MINT_SUSDS',
  });
}

describe('viem sendWith', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects before estimating gas when the wallet chain does not match the plan chain', async () => {
    const result = await sendWith(walletOn(mainnet), requestFor(base.id));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe(
        'viem WalletClient is on chain 1 but the transaction targets chain 8453',
      );
    }
    expect(actions.estimateGas).not.toHaveBeenCalled();
    expect(actions.sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('sends when the wallet chain matches the plan chain', async () => {
    actions.estimateGas.mockResolvedValue(100n);
    actions.sendTransaction.mockResolvedValue(HASH);
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: HASH,
    });

    const result = await sendWith(walletOn(base), requestFor(base.id));

    expect(result.isOk()).toBe(true);
    expect(actions.estimateGas).toHaveBeenCalledTimes(1);
    expect(actions.sendTransaction).toHaveBeenCalledTimes(1);
    expect(actions.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hash: HASH }),
    );
    if (result.isOk()) {
      expect(result.value.txHash).toBe(HASH);
      expect(result.value.operations).toEqual(['MINT_SUSDS']);
    }
  });
});
