import { installMockPublicClient } from './actions/_testing.js';
import {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
} from './balances.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from './errors.js';
import { OseroClient } from './OseroClient.js';
import { getToken } from './tokens.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

describe('balance helpers', () => {
  it('reads the requested token balance', async () => {
    const client = OseroClient.create();
    const balance = 123_456_789n;
    const mock = installMockPublicClient(client, 8453, ({ address, functionName, args }) => {
      expect(address).toBe(getToken(8453, 'USDS').address);
      expect(functionName).toBe('balanceOf');
      expect(args).toEqual([ACCOUNT]);
      return balance;
    });

    const result = await getTokenBalance(client, {
      chainId: 8453,
      account: ACCOUNT,
      token: 'USDS',
    });

    expect(mock.readContract).toHaveBeenCalledOnce();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(balance);
    }
  });

  it('reads the balance of an arbitrary ERC-20 address', async () => {
    const client = OseroClient.create();
    // Base WETH — deliberately outside the canonical token registry.
    const wethOnBase = '0x4200000000000000000000000000000000000006' as const;
    const balance = 987n;
    const mock = installMockPublicClient(client, 8453, ({ address, functionName, args }) => {
      expect(address).toBe(wethOnBase);
      expect(functionName).toBe('balanceOf');
      expect(args).toEqual([ACCOUNT]);
      return balance;
    });

    const result = await getTokenBalance(client, {
      chainId: 8453,
      account: ACCOUNT,
      token: wethOnBase,
    });

    expect(mock.readContract).toHaveBeenCalledOnce();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(balance);
    }
  });

  it('rejects 0x-prefixed tokens that are not valid addresses instead of throwing', async () => {
    const client = OseroClient.create();
    const mock = installMockPublicClient(client, 1, () => {
      throw new Error('must not reach the RPC');
    });

    // Mixed-case with a broken EIP-55 checksum, and truncated hex: both are
    // `0x${string}` at the type level but must fail as Results, never throw.
    const badChecksum = '0xa0B86991c6218b36c1d19D4a2e9eb0cE3606eB48' as const;
    const truncated = '0x1234' as const;

    const results = await Promise.all(
      [badChecksum, truncated].map((token) =>
        getTokenBalance(client, {
          chainId: 1,
          account: ACCOUNT,
          token,
        }),
      ),
    );
    for (const result of results) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
    }
    expect(mock.readContract).not.toHaveBeenCalled();
  });

  it('rejects unsupported chains before resolving an address token', async () => {
    const client = OseroClient.create();
    const result = await getTokenBalance(client, {
      chainId: 137,
      account: ACCOUNT,
      token: '0x4200000000000000000000000000000000000006',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedChainError);
    }
  });

  it('reads all canonical balances in one call', async () => {
    const client = OseroClient.create();
    const balances = {
      [getToken(8453, 'USDC').address]: 10n,
      [getToken(8453, 'USDS').address]: 20n,
      [getToken(8453, 'sUSDS').address]: 30n,
    } as const;

    const mock = installMockPublicClient(client, 8453, ({ address, functionName, args }) => {
      expect(functionName).toBe('balanceOf');
      expect(args).toEqual([ACCOUNT]);
      return balances[address as keyof typeof balances];
    });

    const result = await getTokenBalances(client, {
      chainId: 8453,
      account: ACCOUNT,
    });

    expect(mock.readContract).toHaveBeenCalledTimes(3);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        USDC: 10n,
        USDS: 20n,
        sUSDS: 30n,
      });
    }
  });

  it('exposes convenience wrappers for each token', async () => {
    const client = OseroClient.create();
    const mock = installMockPublicClient(client, 1, ({ address }) => {
      if (address === getToken(1, 'USDC').address) return 1n;
      if (address === getToken(1, 'USDS').address) return 2n;
      if (address === getToken(1, 'sUSDS').address) return 3n;
      throw new Error(`unexpected token ${address}`);
    });

    const [usdcResult, usdsResult, susdsResult] = await Promise.all([
      getUsdcBalance(client, { chainId: 1, account: ACCOUNT }),
      getUsdsBalance(client, { chainId: 1, account: ACCOUNT }),
      getSUsdsBalance(client, { chainId: 1, account: ACCOUNT }),
    ]);

    expect(mock.readContract).toHaveBeenCalledTimes(3);
    expect(usdcResult.isOk() && usdcResult.value === 1n).toBe(true);
    expect(usdsResult.isOk() && usdsResult.value === 2n).toBe(true);
    expect(susdsResult.isOk() && susdsResult.value === 3n).toBe(true);
  });

  it('rejects unsupported chains', async () => {
    const client = OseroClient.create();
    const result = await getTokenBalance(client, {
      chainId: 137,
      account: ACCOUNT,
      token: 'USDC',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedChainError);
    }
  });

  it('wraps RPC failures in UnexpectedError', async () => {
    const client = OseroClient.create();
    installMockPublicClient(client, 42161, () => {
      throw new Error('rpc timeout');
    });

    const result = await getSUsdsBalance(client, {
      chainId: 42161,
      account: ACCOUNT,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });
});
