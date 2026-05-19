import { createWalletClient, custom, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { vi } from 'vitest';

import { installMockPublicClient } from './lib/actions/_testing.js';
import { mintUsds } from './lib/actions/mintUsds.js';
import { UnexpectedError } from './lib/errors.js';
import { OseroClient } from './lib/OseroClient.js';
import { sendWith } from './viem.js';

const viemActions = vi.hoisted(() => ({
  estimateGas: vi.fn<(...args: readonly unknown[]) => Promise<bigint>>(),
  readContract: vi.fn<(...args: readonly unknown[]) => Promise<bigint>>(),
  sendTransaction: vi.fn<(...args: readonly unknown[]) => Promise<`0x${string}`>>(),
  waitForTransactionReceipt: vi.fn<
    (...args: readonly unknown[]) => Promise<{
      readonly status: 'success';
      readonly transactionHash: `0x${string}`;
    }>
  >(),
}));

vi.mock('viem/actions', () => viemActions);

const sender = '0x1111111111111111111111111111111111111111' as const;
const txHash = `0x${'c'.repeat(64)}` as `0x${string}`;

describe('viem preflight checks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    viemActions.estimateGas.mockResolvedValue(100_000n);
    viemActions.readContract.mockResolvedValue(10n ** 16n);
    viemActions.sendTransaction.mockResolvedValue(txHash);
    viemActions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: txHash,
    });
  });

  it('rejects guarded mainnet mintUsds before estimating sellGem gas when live tin moved', async () => {
    const client = OseroClient.create({ defaultSlippageBps: 0 });
    installMockPublicClient(client, 1, ({ functionName }) => {
      if (functionName === 'tin') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    });
    const wallet = createWalletClient({
      account: sender,
      chain: mainnet,
      transport: custom({
        request:
          vi.fn<
            (args: { readonly method: string; readonly params?: unknown }) => Promise<unknown>
          >(),
      }),
    });

    const result = await mintUsds(client, {
      chainId: 1,
      amount: parseUnits('100', 6),
      sender,
    }).andThen(sendWith(wallet));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toContain('below guarded minimum');
    }
    expect(viemActions.sendTransaction).toHaveBeenCalledTimes(1);
    expect(viemActions.estimateGas).toHaveBeenCalledTimes(1);
    expect(viemActions.readContract).toHaveBeenCalledTimes(1);
  });
});
