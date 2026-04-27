import { installMockPublicClient } from './actions/_testing.js';
import { getSsr, getSUsdsApy, SECONDS_PER_YEAR, ssrToApy } from './apy.js';
import { UnexpectedError, UnsupportedChainError } from './errors.js';
import { OseroClient } from './OseroClient.js';

// Live SSR on mainnet at the time this test was written: the per-second
// rate that compounds to roughly 3.65% APY.
const SSR_VALUE = 1_000_000_001_136_785_036_595_443_334n;
const EXPECTED_APY = (Number(SSR_VALUE) / 1e27) ** SECONDS_PER_YEAR - 1;

const MAINNET_SUSDS = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const BASE_SSR_ORACLE = '0x65d946e533748A998B1f0E430803e39A6388f7a1';

describe('SSR / APY helpers', () => {
  it('reads ssr() directly on mainnet and converts to APY', async () => {
    const client = OseroClient.create();
    const mock = installMockPublicClient(client, 1, ({ address, functionName }) => {
      expect(address).toBe(MAINNET_SUSDS);
      expect(functionName).toBe('ssr');
      return SSR_VALUE;
    });

    const result = await getSUsdsApy(client, { chainId: 1 });

    expect(mock.readContract).toHaveBeenCalledOnce();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(EXPECTED_APY);
      expect(result.value).toBeCloseTo(0.0365, 3);
    }
  });

  it('reads getSSR() from the SSRAuthOracle on Base and converts to APY', async () => {
    const client = OseroClient.create();
    const mock = installMockPublicClient(client, 8453, ({ address, functionName }) => {
      expect(address).toBe(BASE_SSR_ORACLE);
      expect(functionName).toBe('getSSR');
      return SSR_VALUE;
    });

    const result = await getSUsdsApy(client, { chainId: 8453 });

    expect(mock.readContract).toHaveBeenCalledOnce();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(EXPECTED_APY);
      expect(result.value).toBeCloseTo(0.0365, 3);
    }
  });

  it('exposes the raw RAY-scaled rate via getSsr', async () => {
    const client = OseroClient.create();
    installMockPublicClient(client, 1, () => SSR_VALUE);

    const result = await getSsr(client, { chainId: 1 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(SSR_VALUE);
    }
  });

  it('returns 0 APY when the rate is exactly RAY (no growth)', () => {
    expect(ssrToApy(1_000_000_000_000_000_000_000_000_000n)).toBe(0);
  });

  it('rejects unsupported chains', async () => {
    const client = OseroClient.create();
    const result = await getSUsdsApy(client, { chainId: 137 });

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

    const result = await getSUsdsApy(client, { chainId: 42161 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
    }
  });
});
