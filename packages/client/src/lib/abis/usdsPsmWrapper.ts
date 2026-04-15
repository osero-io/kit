/**
 * Spark UsdsPsmWrapper ABI — the thin L1 contract that routes USDC ⇄ USDS
 * through Sky's Lite PSM so that end users never see the legacy DAI hop.
 *
 * {@link sellGem} converts USDC to USDS with exact-in semantics.
 * {@link buyGem} converts USDS to USDC with **exact-out** semantics:
 * `gemAmt` is the desired USDC output in 6 decimals, not a USDS input.
 *
 * See the PSM guide for the parameter math around `tin` and `tout`.
 */
export const usdsPsmWrapperAbi = [
  {
    type: 'function',
    name: 'sellGem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'usr', type: 'address' },
      { name: 'gemAmt', type: 'uint256' },
    ],
    outputs: [{ name: 'usdsOutWad', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'buyGem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'usr', type: 'address' },
      { name: 'gemAmt', type: 'uint256' },
    ],
    outputs: [{ name: 'usdsInWad', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tin',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;
