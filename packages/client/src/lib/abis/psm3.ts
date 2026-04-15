/**
 * Spark PSM3 ABI — the three-asset peg stability module that lets users
 * swap between USDC, USDS, and sUSDS atomically at oracle rates on all
 * supported L2s (Base, Arbitrum, Optimism, Unichain).
 *
 * See the PSM guide for the full contract specification.
 */
export const psm3Abi = [
  {
    type: 'function',
    name: 'swapExactIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assetIn', type: 'address' },
      { name: 'assetOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'referralCode', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapExactOut',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assetIn', type: 'address' },
      { name: 'assetOut', type: 'address' },
      { name: 'amountOut', type: 'uint256' },
      { name: 'maxAmountIn', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'referralCode', type: 'uint256' },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewSwapExactIn',
    stateMutability: 'view',
    inputs: [
      { name: 'assetIn', type: 'address' },
      { name: 'assetOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewSwapExactOut',
    stateMutability: 'view',
    inputs: [
      { name: 'assetIn', type: 'address' },
      { name: 'assetOut', type: 'address' },
      { name: 'amountOut', type: 'uint256' },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'usds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'susds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;
