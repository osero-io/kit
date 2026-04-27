/**
 * Sky Savings Rate read ABI. Combines the two surfaces the SDK reads
 * from depending on chain:
 *
 * - `ssr()` is exposed by Sky's sUSDS vault on Ethereum mainnet.
 * - `getSSR()` is exposed by Spark's `SSRAuthOracle` on every L2 — the
 *   same oracle PSM3 uses to price sUSDS deposits and redemptions.
 *
 * Both return the per-second savings rate scaled by RAY (1e27).
 */
export const ssrAbi = [
  {
    type: 'function',
    name: 'ssr',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getSSR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;
