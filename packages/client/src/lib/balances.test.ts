import { createMockClient, mockFn } from './_testing.js';
import {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
} from './balances.js';
import { RpcError, UnsupportedChainError, ValidationError } from './errors.js';
import { OseroClient } from './OseroClient.js';
import { getToken } from './tokens.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;

describe('single-token balance helpers', () => {
  it('reads canonical symbols and arbitrary ERC-20 addresses with validated inputs', async () => {
    const arbitrary = '0x4200000000000000000000000000000000000006' as const;
    const readContract = mockFn(
      async (request: { address: string; functionName: string; args: readonly unknown[] }) => {
        expect(request.functionName).toBe('balanceOf');
        expect(request.args).toEqual([ACCOUNT]);
        return request.address === arbitrary ? 987n : 123n;
      },
    );
    const { client } = createMockClient(8453, { readContract });

    const canonical = await getTokenBalance(client, {
      chainId: 8453,
      account: ACCOUNT,
      token: 'USDS',
    });
    const custom = await getTokenBalance(client, {
      chainId: 8453,
      account: ACCOUNT,
      token: arbitrary,
    });

    expect(canonical.isOk()).toBe(true);
    if (canonical.isOk()) expect(canonical.value).toBe(123n);
    expect(custom.isOk()).toBe(true);
    if (custom.isOk()) expect(custom.value).toBe(987n);
    expect(readContract.mock.calls[0]?.[0]).toMatchObject({
      address: getToken(8453, 'USDS').address,
    });
  });

  it('rejects malformed account, token, and chain before RPC access', async () => {
    const readContract = mockFn(async () => 0n);
    const { client } = createMockClient(1, { readContract });
    const badAccount = await getTokenBalance(client, {
      chainId: 1,
      account: '0x1234',
      token: 'USDC',
    });
    const badToken = await getTokenBalance(client, {
      chainId: 1,
      account: ACCOUNT,
      token: '0xa0B86991c6218b36c1d19D4a2e9eb0cE3606eB48',
    });
    const unsupported = await getTokenBalance(OseroClient.create(), {
      chainId: 137,
      account: ACCOUNT,
      token: 'USDC',
    });

    expect(badAccount.isErr()).toBe(true);
    expect(badToken.isErr()).toBe(true);
    if (badToken.isErr()) expect(badToken.error).toBeInstanceOf(ValidationError);
    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) expect(unsupported.error).toBeInstanceOf(UnsupportedChainError);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('returns RPC failures with operation and contract context', async () => {
    const { client } = createMockClient(42161, {
      readContract: mockFn(async () => {
        throw new Error('rpc timeout');
      }),
    });

    const result = await getSUsdsBalance(client, { chainId: 42161, account: ACCOUNT });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(RpcError);
      if (result.error instanceof RpcError) {
        expect(result.error.operation).toBe('readContract');
        expect(result.error.functionName).toBe('balanceOf');
      }
    }
  });

  it('keeps convenience wrappers equivalent to explicit token reads', async () => {
    const readContract = mockFn(async (request: { address: string }) => {
      if (request.address === getToken(1, 'USDC').address) return 1n;
      if (request.address === getToken(1, 'USDS').address) return 2n;
      return 3n;
    });
    const { client } = createMockClient(1, { readContract });

    const [usdc, usds, susds] = await Promise.all([
      getUsdcBalance(client, { chainId: 1, account: ACCOUNT }),
      getUsdsBalance(client, { chainId: 1, account: ACCOUNT }),
      getSUsdsBalance(client, { chainId: 1, account: ACCOUNT }),
    ]);

    expect(usdc.isOk() && usdc.value === 1n).toBe(true);
    expect(usds.isOk() && usds.value === 2n).toBe(true);
    expect(susds.isOk() && susds.value === 3n).toBe(true);
  });
});

describe('aggregate balance strategy', () => {
  it('uses multicall by default and maps all three results deterministically', async () => {
    const multicall = mockFn(async () => [
      { status: 'success' as const, result: 10n },
      { status: 'success' as const, result: 20n },
      { status: 'success' as const, result: 30n },
    ]);
    const readContract = mockFn(async () => 0n);
    const { client } = createMockClient(8453, { multicall, readContract });

    const result = await getTokenBalances(client, { chainId: 8453, account: ACCOUNT });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ USDC: 10n, USDS: 20n, sUSDS: 30n });
    expect(multicall).toHaveBeenCalledOnce();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('falls back to three isolated reads only when prefer multicall cannot execute', async () => {
    const multicall = mockFn(async () => {
      throw new Error('multicall unavailable');
    });
    let value = 0n;
    const readContract = mockFn(async () => {
      value += 1n;
      return value;
    });
    const { client } = createMockClient(8453, { multicall, readContract });

    const result = await getTokenBalances(client, {
      chainId: 8453,
      account: ACCOUNT,
      multicall: 'prefer',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ USDC: 1n, USDS: 2n, sUSDS: 3n });
    expect(readContract).toHaveBeenCalledTimes(3);
  });

  it('does not hide required multicall failure behind fallback reads', async () => {
    const multicall = mockFn(async () => {
      throw new Error('multicall unavailable');
    });
    const readContract = mockFn(async () => 0n);
    const { client } = createMockClient(8453, { multicall, readContract });

    const result = await getTokenBalances(client, {
      chainId: 8453,
      account: ACCOUNT,
      multicall: 'require',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(RpcError);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('surfaces per-contract and malformed aggregate responses with token context', async () => {
    const failureMulticall = mockFn(async () => [
      { status: 'success' as const, result: 10n },
      { status: 'failure' as const, error: new Error('USDS read failed') },
      { status: 'success' as const, result: 30n },
    ]);
    const failed = createMockClient(8453, { multicall: failureMulticall });
    const failureResult = await getTokenBalances(failed.client, {
      chainId: 8453,
      account: ACCOUNT,
    });

    const short = createMockClient(8453, {
      multicall: mockFn(async () => [{ status: 'success' as const, result: 10n }]),
    });
    const shortResult = await getTokenBalances(short.client, {
      chainId: 8453,
      account: ACCOUNT,
    });

    expect(failureResult.isErr()).toBe(true);
    if (failureResult.isErr() && failureResult.error instanceof RpcError) {
      expect(failureResult.error.contract).toBe(getToken(8453, 'USDS').address);
    }
    expect(shortResult.isErr()).toBe(true);
    if (shortResult.isErr()) expect(shortResult.error).toBeInstanceOf(RpcError);
  });

  it('honors never and validates the strategy vocabulary', async () => {
    let value = 0n;
    const readContract = mockFn(async () => {
      value += 1n;
      return value;
    });
    const multicall = mockFn(async () => []);
    const { client } = createMockClient(8453, { multicall, readContract });

    const never = await getTokenBalances(client, {
      chainId: 8453,
      account: ACCOUNT,
      multicall: 'never',
    });
    const invalid = await getTokenBalances(client, {
      chainId: 8453,
      account: ACCOUNT,
      multicall: 'sometimes' as never,
    });

    expect(never.isOk()).toBe(true);
    expect(readContract).toHaveBeenCalledTimes(3);
    expect(multicall).not.toHaveBeenCalled();
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) expect(invalid.error).toBeInstanceOf(ValidationError);
  });
});
