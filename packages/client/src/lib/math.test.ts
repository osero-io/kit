import {
  applySlippage,
  BPS,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  USDC_TO_USDS_SCALE,
  usdsNeededForUsdcViaBuyGem,
  WAD,
} from './math.js';

describe('applySlippage', () => {
  it('returns the quote unchanged for 0 bps', () => {
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  it('applies 5 bps = 0.05% correctly', () => {
    expect(applySlippage(1_000_000n, 5)).toBe(999_500n);
  });

  it('applies 100 bps = 1% correctly', () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
  });

  it('returns 0 at 10000 bps (100%)', () => {
    expect(applySlippage(1_000_000n, 10_000)).toBe(0n);
  });

  it('rounds down when the result would not be an integer', () => {
    // 1001 * 9995 / 10000 = 10_004.995 / 10 → 1000.4995 → floor 1000
    expect(applySlippage(1001n, 5)).toBe(1000n);
  });

  it('rejects negative slippage', () => {
    expect(() => applySlippage(1n, -1)).toThrow(RangeError);
  });

  it('rejects slippage over 10000 bps', () => {
    expect(() => applySlippage(1n, 10_001)).toThrow(RangeError);
  });

  it('rejects non-integer slippage', () => {
    expect(() => applySlippage(1n, 0.5)).toThrow(RangeError);
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
