import { slippageRatio, type Slippage } from './domain.js';

export const WAD = 1_000_000_000_000_000_000n;
export const USDC_TO_USDS_SCALE = 1_000_000_000_000n;
export const BPS = 10_000n;

export function applySlippageDown(quote: bigint, slippage: Slippage): bigint {
  const { units, scale } = slippageRatio(slippage);
  return (quote * (BPS * scale - units)) / (BPS * scale);
}

export function applySlippageUp(quote: bigint, slippage: Slippage): bigint {
  const { units, scale } = slippageRatio(slippage);
  const numerator = quote * (BPS * scale + units);
  const denominator = BPS * scale;
  return (numerator + denominator - 1n) / denominator;
}

export function usdsFromUsdcViaSellGem(gemAmt: bigint, tin: bigint): bigint {
  const scaled = gemAmt * USDC_TO_USDS_SCALE;
  return (scaled * (WAD - tin)) / WAD;
}

export function usdsNeededForUsdcViaBuyGem(gemAmt: bigint, tout: bigint): bigint {
  const scaled = gemAmt * USDC_TO_USDS_SCALE;
  return scaled + (scaled * tout) / WAD;
}

export function usdcFromUsdsViaBuyGem(usdsInWad: bigint, tout: bigint): bigint {
  return (usdsInWad * WAD) / ((WAD + tout) * USDC_TO_USDS_SCALE);
}
