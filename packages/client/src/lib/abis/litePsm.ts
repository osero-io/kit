/**
 * Sky/MakerDAO Lite PSM (DssLitePsm) ABI subset. Used as an authoritative
 * source of the governance-set `tin` and `tout` fees on Ethereum mainnet.
 * The Spark {@link usdsPsmWrapperAbi | UsdsPsmWrapper} forwards these
 * fees verbatim.
 */
export const litePsmAbi = [
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
  {
    type: 'function',
    name: 'pocket',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;
