import { createMockClient, mockFn } from './_testing.js';
import { getSsr, getSUsdsApy, RAY, SECONDS_PER_YEAR, ssrToApy } from './apy.js';
import { RpcError, UnsupportedChainError, ValidationError } from './errors.js';
import { OseroClient } from './OseroClient.js';

const SSR_VALUE = 1_000_000_001_136_785_036_595_443_334n;
const EXPECTED_APY = Math.expm1(SECONDS_PER_YEAR * Math.log1p(Number(SSR_VALUE - RAY) / 1e27));
const MAINNET_SUSDS = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const BASE_SSR_ORACLE = '0x65d946e533748A998B1f0E430803e39A6388f7a1';

describe('SSR / APY helpers', () => {
  it.each([
    [1, MAINNET_SUSDS, 'ssr'],
    [8453, BASE_SSR_ORACLE, 'getSSR'],
  ] as const)(
    'reads the configured SSR source on chain %s',
    async (chainId, address, functionName) => {
      const readContract = mockFn(async (request: { address: string; functionName: string }) => {
        expect(request.address).toBe(address);
        expect(request.functionName).toBe(functionName);
        return SSR_VALUE;
      });
      const { client } = createMockClient(chainId, { readContract });

      const result = await getSUsdsApy(client, { chainId });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeCloseTo(EXPECTED_APY, 12);
        expect(result.value).toBeCloseTo(0.0365, 3);
      }
      expect(readContract).toHaveBeenCalledOnce();
    },
  );

  it('exposes the raw RAY-scaled SSR', async () => {
    const { client } = createMockClient(1, {
      readContract: mockFn(async () => SSR_VALUE),
    });

    const result = await getSsr(client, { chainId: 1 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(SSR_VALUE);
  });

  it('returns exact zero at RAY and stable log-domain compounding above RAY', () => {
    const zero = ssrToApy(RAY);
    const compounded = ssrToApy(SSR_VALUE);

    expect(zero.isOk()).toBe(true);
    if (zero.isOk()) expect(zero.value).toBe(0);
    expect(compounded.isOk()).toBe(true);
    if (compounded.isOk()) expect(compounded.value).toBeCloseTo(EXPECTED_APY, 12);
  });

  it('rejects invalid and out-of-range SSR values as typed validation errors', () => {
    const belowRay = ssrToApy(RAY - 1n);
    const overflow = ssrToApy(RAY + 10n ** 400n);

    expect(belowRay.isErr()).toBe(true);
    if (belowRay.isErr()) expect(belowRay.error).toBeInstanceOf(ValidationError);
    expect(overflow.isErr()).toBe(true);
    if (overflow.isErr()) expect(overflow.error).toBeInstanceOf(ValidationError);
  });

  it('returns typed unsupported-chain and RPC failures', async () => {
    const unsupported = await getSUsdsApy(OseroClient.create(), { chainId: 137 });
    const { client } = createMockClient(42161, {
      readContract: mockFn(async () => {
        throw new Error('rpc timeout');
      }),
    });
    const rpc = await getSUsdsApy(client, { chainId: 42161 });

    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) expect(unsupported.error).toBeInstanceOf(UnsupportedChainError);
    expect(rpc.isErr()).toBe(true);
    if (rpc.isErr()) expect(rpc.error).toBeInstanceOf(RpcError);
  });
});
