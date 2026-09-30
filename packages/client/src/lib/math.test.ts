import { parseSlippage, type Slippage } from './domain.js';
import {
  applySlippageDown,
  applySlippageUp,
  BPS,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  USDC_TO_USDS_SCALE,
  usdsNeededForUsdcViaBuyGem,
  WAD,
} from './math.js';

function slippage(value: string): Slippage {
  const result = parseSlippage({ bps: value });
  if (result.isErr()) throw result.error;
  return result.value;
}

describe('slippage bounds', () => {
  it('returns the quote unchanged at zero', () => {
    expect(applySlippageDown(1_000_000n, slippage('0'))).toBe(1_000_000n);
    expect(applySlippageUp(1_000_000n, slippage('0'))).toBe(1_000_000n);
  });

  it('applies minimum-output slippage downward with floor rounding', () => {
    expect(applySlippageDown(1_000_000n, slippage('5'))).toBe(999_500n);
    expect(applySlippageDown(1001n, slippage('5'))).toBe(1000n);
    expect(applySlippageDown(1_000_000n, slippage('10000'))).toBe(0n);
  });

  it('applies maximum-input slippage upward with ceiling rounding', () => {
    expect(applySlippageUp(1_000_000n, slippage('100'))).toBe(1_010_000n);
    expect(applySlippageUp(1001n, slippage('0.5'))).toBe(1002n);
  });
});

describe('USDS <-> USDC conversion math', () => {
  it('converts USDC to USDS 1:1 when tin = 0', () => {
    // 100 USDC (6 dec) → 100 USDS (18 dec)
    const usdcIn = 100n * 10n ** 6n;
    const expected = 100n * 10n ** 18n;
    expect(usdsFromUsdcViaSellGem(usdcIn, 0n)).toBe(expected);
  });

  it('applies a non-zero tin fee correctly', () => {
    // tin = 1e16 (1%) → usdsOut should be 99% of scaled USDC
    const usdcIn = 100n * 10n ** 6n;
    const tin = 10n ** 16n; // 1 %
    const result = usdsFromUsdcViaSellGem(usdcIn, tin);
    expect(result).toBe((100n * 10n ** 18n * 99n) / 100n);
  });

  it('returns exact 1:1 USDS input for USDC output when tout = 0', () => {
    // 100 USDC out → 100 USDS in
    const gemAmt = 100n * 10n ** 6n;
    expect(usdsNeededForUsdcViaBuyGem(gemAmt, 0n)).toBe(100n * 10n ** 18n);
  });

  it('adds the fee on top of the base amount when tout > 0', () => {
    const gemAmt = 100n * 10n ** 6n;
    const tout = 10n ** 16n; // 1 %
    const result = usdsNeededForUsdcViaBuyGem(gemAmt, tout);
    expect(result).toBe((100n * 10n ** 18n * 101n) / 100n);
  });

  it('inverts usdsNeededForUsdcViaBuyGem with usdcFromUsdsViaBuyGem when tout = 0', () => {
    const gemAmt = 100n * 10n ** 6n;
    const usdsIn = usdsNeededForUsdcViaBuyGem(gemAmt, 0n);
    expect(usdcFromUsdsViaBuyGem(usdsIn, 0n)).toBe(gemAmt);
  });

  it('floors during the reverse conversion when tout > 0', () => {
    // With a live tout fee, dust may be left over — the reverse
    // function must never over-estimate the USDC you can afford.
    const usdsIn = 1000n * 10n ** 18n;
    const tout = 10n ** 15n; // 0.1 %
    const gemAmt = usdcFromUsdsViaBuyGem(usdsIn, tout);
    const usdsForThatGem = usdsNeededForUsdcViaBuyGem(gemAmt, tout);
    expect(usdsForThatGem).toBeLessThanOrEqual(usdsIn);
  });
});

describe('constants', () => {
  it('WAD is 1e18', () => {
    expect(WAD).toBe(1_000_000_000_000_000_000n);
  });
  it('USDC_TO_USDS_SCALE is 1e12', () => {
    expect(USDC_TO_USDS_SCALE).toBe(1_000_000_000_000n);
  });
  it('BPS is 10000', () => {
    expect(BPS).toBe(10_000n);
  });
});
