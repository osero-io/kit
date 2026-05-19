import type { Chain } from 'viem';
import { vi } from 'vitest';

import { UnexpectedError } from './lib/errors.js';
import { makeTransactionRequest } from './lib/plan.js';
import { sendWith, type ConnectedWalletClient } from './viem.js';

const viemActions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: readonly unknown[]) => Promise<bigint>>(),
  sendTransaction: vi.fn<(...args: readonly unknown[]) => Promise<`0x${string}`>>(),
  waitForTransactionReceipt: vi.fn<
    (...args: readonly unknown[]) => Promise<{
      readonly status: 'success' | 'reverted';
      readonly transactionHash: `0x${string}`;
    }>
  >(),
}));

vi.mock('viem/actions', () => viemActions);

const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'a'.repeat(64)}` as `0x${string}`;

const chain = {
  id: 1,
  name: 'Ethereum',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://example.invalid'],
    },
  },
} satisfies Chain;

const walletClient = {
  account: {
    address: from,
    type: 'json-rpc',
  },
  chain,
} as unknown as ConnectedWalletClient;

const request = makeTransactionRequest({
  chainId: 1,
  from,
  to,
  data: '0x1234',
  operation: 'MINT_USDS',
});

describe('viem sendWith', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('preserves the transaction hash when receipt polling fails', async () => {
    const pollingError = new Error('receipt polling timed out');
    viemActions.estimateGas.mockResolvedValue(100_000n);
    viemActions.sendTransaction.mockResolvedValue(txHash);
    viemActions.waitForTransactionReceipt.mockRejectedValue(pollingError);

    const result = await sendWith(walletClient, request);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      expect(error).toBeInstanceOf(UnexpectedError);
      if (!(error instanceof UnexpectedError)) {
        throw new Error(`Expected UnexpectedError, received ${error.name}`);
      }
      expect(error.txHash).toBe(txHash);
      expect(error.cause).toBe(pollingError);
    }
    expect(viemActions.waitForTransactionReceipt).toHaveBeenCalledWith(walletClient, {
      hash: txHash,
      confirmations: 1,
    });
  });
});
