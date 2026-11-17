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

// F19: the expected values below are derived with bigint fixed-point arithmetic only.
// `ssrToApy` works in the log domain (`log1p`/`expm1`); this reference never touches that
// formula, so the two can only agree if the implementation is numerically right.
const REFERENCE_DIGITS = 60;
const REFERENCE_SCALE = 10n ** BigInt(REFERENCE_DIGITS);

/** `(ssr / RAY) ^ SECONDS_PER_YEAR - 1` as a 60-decimal fixed-point bigint. */
function referenceApyFixedPoint(ssr: bigint): bigint {
  // Exact: REFERENCE_SCALE is a multiple of RAY, so the per-second factor loses nothing.
  let factor = (ssr * REFERENCE_SCALE) / RAY;
  let compounded = REFERENCE_SCALE;
  // Exponentiation by squaring; each truncating division drops less than 1e-60.
  for (let exponent = BigInt(SECONDS_PER_YEAR); exponent > 0n; exponent >>= 1n) {
    if ((exponent & 1n) === 1n) compounded = (compounded * factor) / REFERENCE_SCALE;
    factor = (factor * factor) / REFERENCE_SCALE;
  }
  return compounded - REFERENCE_SCALE;
}

function fixedPointToDecimalString(value: bigint): string {
  const digits = value.toString().padStart(REFERENCE_DIGITS + 1, '0');
  return `${digits.slice(0, -REFERENCE_DIGITS)}.${digits.slice(-REFERENCE_DIGITS)}`;
}

function referenceApy(ssr: bigint): number {
  return Number(fixedPointToDecimalString(referenceApyFixedPoint(ssr)));
}

describe('ssrToApy high-precision fixtures', () => {
  it('keeps the bigint reference independent of the log-domain formula', () => {
    expect(REFERENCE_SCALE % RAY).toBe(0n);
    expect(referenceApyFixedPoint(RAY)).toBe(0n);
    // Hand-checkable: (1 + 1e-27)^n - 1 = n * 1e-27 + C(n, 2) * 1e-54 + ...
    expect(fixedPointToDecimalString(referenceApyFixedPoint(RAY + 1n)).slice(0, 42)).toBe(
      '0.0000000000000000000315360000000000000004',
    );
    expect(fixedPointToDecimalString(referenceApyFixedPoint(RAY + 10n ** 18n)).slice(0, 32)).toBe(
      '0.032038528297639106730113880074',
    );
  });

  it('compounds RAY + 1e18 to 0.03203852829763911 within 1e-15', () => {
    const result = ssrToApy(RAY + 10n ** 18n);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Math.abs(result.value - 0.03203852829763911)).toBeLessThan(1e-15);
      expect(Math.abs(result.value - referenceApy(RAY + 10n ** 18n))).toBeLessThan(1e-15);
    }
  });

  it('keeps the smallest rate above RAY strictly positive instead of rounding to zero', () => {
    const result = ssrToApy(RAY + 1n);
    const expected = referenceApy(RAY + 1n);

    expect(expected).toBeGreaterThan(3.15e-20);
    expect(expected).toBeLessThan(3.16e-20);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeGreaterThan(0);
      expect(Math.abs(result.value - expected) / expected).toBeLessThan(1e-12);
    }
  });

  it.each([
    ['one wei above RAY', RAY + 1n],
    ['three wei above RAY', RAY + 3n],
    ['a 1e-18 per-second rate', RAY + 10n ** 9n],
    ['a 1e-9 per-second rate', RAY + 10n ** 18n],
    ['the mainnet SSR fixture', SSR_VALUE],
    ['a rate that roughly doubles in a year', RAY + 21_979_553_151_239_153_027n],
    ['a 1e-7 per-second rate', RAY + 10n ** 20n],
  ])('matches the fixed-point reference to 12 significant digits for %s', (_label, ssr) => {
    const result = ssrToApy(ssr);
    const expected = referenceApy(ssr);

    expect(expected).toBeGreaterThan(0);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Math.abs(result.value - expected) / expected).toBeLessThan(1e-12);
    }
  });
});
