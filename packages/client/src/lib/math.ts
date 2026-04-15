/**
 * BigInt-friendly WAD constant (`1e18`). Used by Sky PSM math to apply
 * and reverse fee-in / fee-out percentages.
 */
export const WAD = 1_000_000_000_000_000_000n;

/**
 * 10 ^ 12 — the scale factor used to convert from USDC's 6 decimals
 * to USDS's 18 decimals.
 */
export const USDC_TO_USDS_SCALE = 1_000_000_000_000n;

/**
 * Total basis points, i.e. 100% expressed in bps. Used as the
 * denominator for slippage math.
 */
export const BPS = 10_000n;

/**
 * Apply a slippage tolerance (in basis points) to a quoted amount,
 * yielding the minimum-acceptable amount to pass to a swap router.
 *
 * ```ts
 * applySlippage(1_000_000n, 5); // → 999_500n  (5 bps = 0.05%)
 * ```
 *
 * @throws if `slippageBps` is outside `[0, 10000]`.
 */
export function applySlippage(quote: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000 || !Number.isInteger(slippageBps)) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000], received ${slippageBps}`);
  }
  return (quote * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * Compute the USDS output of the Sky `sellGem` flow for a given USDC
 * input, reading the current `tin` (fee-in) from the Lite PSM.
 *
 * Mirrors the solidity formula from the PSM guide:
 *
 * ```text
 * usdsOutWad = gemAmt * 1e12 * (WAD - tin) / WAD
 * ```
 *
 * When `tin = 0` (current governance setting) this is exactly
 * `gemAmt * 1e12`.
 */
export function usdsFromUsdcViaSellGem(gemAmt: bigint, tin: bigint): bigint {
  const scaled = gemAmt * USDC_TO_USDS_SCALE;
  return (scaled * (WAD - tin)) / WAD;
}

/**
 * Compute the USDS input required to buy a given USDC output via
 * `buyGem`, reading the current `tout` (fee-out).
 *
 * ```text
 * usdsInWad = gemAmt * 1e12 + gemAmt * 1e12 * tout / WAD
 * ```
 */
export function usdsNeededForUsdcViaBuyGem(gemAmt: bigint, tout: bigint): bigint {
  const scaled = gemAmt * USDC_TO_USDS_SCALE;
  return scaled + (scaled * tout) / WAD;
}

/**
 * Inverse of {@link usdsNeededForUsdcViaBuyGem}: given the USDS a
 * caller is willing to spend and the current `tout`, compute the
 * maximum USDC `gemAmt` they can ask for. Floors so that the result
 * is always safely within the USDS budget.
 */
export function usdcFromUsdsViaBuyGem(usdsInWad: bigint, tout: bigint): bigint {
  return (usdsInWad * WAD) / ((WAD + tout) * USDC_TO_USDS_SCALE);
}
