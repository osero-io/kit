import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi as fullErc20Abi,
  http,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { erc20Abi } from '../src/lib/abis/erc20.js';
import { erc4626Abi } from '../src/lib/abis/erc4626.js';
import { litePsmAbi } from '../src/lib/abis/litePsm.js';
import { psm3Abi } from '../src/lib/abis/psm3.js';
import { ssrAbi } from '../src/lib/abis/ssr.js';
import { usdsPsmWrapperAbi } from '../src/lib/abis/usdsPsmWrapper.js';
import { prepareSwap } from '../src/lib/actions/prepareSwap.js';
import { quoteSwap, type SwapQuoteRequest } from '../src/lib/actions/quoteSwap.js';
import {
  CHAIN_CAPABILITIES,
  type OseroChainId,
  type SwapMode,
  type TokenSymbol,
} from '../src/lib/capabilities.js';
import { parseSlippage, tokenAmount, UINT256_MAX, type Slippage } from '../src/lib/domain.js';
import { SimulationError } from '../src/lib/errors.js';
import { usdsFromUsdcViaSellGem, usdsNeededForUsdcViaBuyGem } from '../src/lib/math.js';
import { OseroClient, type OseroPublicClient } from '../src/lib/OseroClient.js';
import { simulateExecutionPlan } from '../src/lib/simulation.js';
import type { SwapQuote } from '../src/lib/types.js';

const PINNED_BLOCKS: Readonly<Record<OseroChainId, bigint>> = {
  1: 25_525_000n,
  10: 154_184_000n,
  130: 53_219_000n,
  8453: 48_589_000n,
  42161: 483_508_000n,
};

const configuredChainId = Number(process.env['OSERO_FORK_CHAIN_ID']);
const configuredRpcUrl = process.env['OSERO_FORK_RPC_URL'];
if (!(configuredChainId in PINNED_BLOCKS)) {
  throw new Error('OSERO_FORK_CHAIN_ID must select a supported pinned chain');
}
if (configuredRpcUrl === undefined || configuredRpcUrl.length === 0) {
  throw new Error('OSERO_FORK_RPC_URL is required; fork tests never use implicit public RPCs');
}
const rpcUrl: string = configuredRpcUrl;
const chainId = configuredChainId as OseroChainId;
const capability = CHAIN_CAPABILITIES[chainId];
const pinnedBlock = PINNED_BLOCKS[chainId];
const publicClient = createPublicClient({
  chain: capability.viemChain,
  // The SDK pins reads to getBlockNumber(); a cached head would predate the test's own transactions.
  cacheTime: 0,
  transport: http(rpcUrl, { retryCount: 0 }),
});

async function anvil(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = (await response.json()) as {
    readonly result?: unknown;
    readonly error?: { readonly message?: string };
  };
  if (!response.ok || payload.error !== undefined) {
    throw new Error(payload.error?.message ?? `Anvil RPC ${method} failed with ${response.status}`);
  }
  return payload.result;
}

const FORK_SWAPPER: Address = '0x05e0000000000000000000000000000000000001';

async function sendAs(
  account: Address,
  call: { readonly to: Address; readonly data: Hex; readonly value?: bigint },
) {
  await anvil('anvil_setBalance', [account, '0x8ac7230489e80000']);
  await anvil('anvil_impersonateAccount', [account]);
  try {
    const walletClient = createWalletClient({
      account,
      chain: capability.viemChain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });
    const hash = await walletClient.sendTransaction({
      account,
      chain: capability.viemChain,
      ...call,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [account]);
  }
}

function expectCode(code: Hex | undefined, address: Address): void {
  expect(code, `${address} must contain deployed bytecode`).toMatch(/^0x[0-9a-f]+$/i);
  expect(code).not.toBe('0x');
}

const forkClient = OseroClient.create({
  publicClients: {
    [chainId]: publicClient as unknown as OseroPublicClient,
  } as Partial<Record<OseroChainId, OseroPublicClient>>,
});

type RouteMode = {
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  readonly mode: SwapMode;
};

// Every route and mode the capability matrix enables for this chain; nothing is filtered out.
const ROUTE_MODES: readonly RouteMode[] = capability.routes.flatMap(
  ({ assetIn, assetOut, exactIn, exactOut }) => [
    ...(exactIn ? [{ assetIn, assetOut, mode: 'exact-in' as const }] : []),
    ...(exactOut ? [{ assetIn, assetOut, mode: 'exact-out' as const }] : []),
  ],
);
if (ROUTE_MODES.length === 0) {
  throw new Error(`chain ${chainId} enables no route, so the route tests would assert nothing`);
}

const TOKEN_SYMBOLS = ['USDC', 'USDS', 'sUSDS'] as const satisfies readonly TokenSymbol[];

// Deliberately non-round, so every division on the quote path leaves a remainder to round.
// A symbol's amount is the input of its exact-in routes and the output of its exact-out routes.
const ROUTE_AMOUNTS: Readonly<Record<TokenSymbol, bigint>> = {
  USDC: 1_234_567n,
  USDS: 1_234_567_890_123_456_789n,
  sUSDS: 1_234_567_890_123_456_789n,
};

const WAD = 10n ** 18n;
// DssLitePsm.to18ConversionFactor for 6-decimal USDC.
const USDC_TO_USDS = 10n ** 12n;

function routeLabel({ assetIn, assetOut, mode }: RouteMode): string {
  return `${mode} ${assetIn} -> ${assetOut}`;
}

function slippageOf(bps: string): Slippage {
  const slippage = parseSlippage({ bps });
  if (slippage.isErr()) throw slippage.error;
  return slippage.value;
}
const FIVE_BPS = slippageOf('5');
// With no slippage the encoded bound is the quoted amount itself, so a settlement that prices one
// wei worse than the quote reverts instead of passing inside a tolerance.
const NO_SLIPPAGE = slippageOf('0');

function quoteRequest({ assetIn, assetOut, mode }: RouteMode, slippage: Slippage) {
  const symbol = mode === 'exact-in' ? assetIn : assetOut;
  const amount = tokenAmount(symbol, ROUTE_AMOUNTS[symbol]);
  if (amount.isErr()) throw amount.error;
  return (
    mode === 'exact-in'
      ? { chainId, mode, amountIn: amount.value, assetOut, slippage }
      : { chainId, mode, assetIn, amountOut: amount.value, slippage }
  ) satisfies SwapQuoteRequest;
}

async function quoteRoute(routeMode: RouteMode, slippage: Slippage): Promise<SwapQuote> {
  const quote = await quoteSwap(forkClient, quoteRequest(routeMode, slippage));
  if (quote.isErr()) throw quote.error;
  return quote.value;
}

/** What a quote says the account pays and receives, in one shape for both modes. */
function quotedSettlement(quote: SwapQuote) {
  return quote.mode === 'exact-in'
    ? {
        amountIn: quote.amountIn.raw,
        amountOut: quote.expectedAmountOut.raw,
        maximumIn: quote.amountIn.raw,
      }
    : {
        amountIn: quote.expectedAmountIn.raw,
        amountOut: quote.amountOut.raw,
        maximumIn: quote.maximumAmountIn.raw,
      };
}

function readVaultPreview(
  functionName: 'previewDeposit' | 'previewMint' | 'previewRedeem' | 'previewWithdraw',
  amount: bigint,
): Promise<bigint> {
  return publicClient.readContract({
    address: capability.tokens.sUSDS.address,
    abi: erc4626Abi,
    functionName,
    args: [amount],
    blockNumber: pinnedBlock,
  });
}

function readLitePsmFee(functionName: 'tin' | 'tout'): Promise<bigint> {
  const litePsm = capability.contracts.litePsm;
  if (litePsm === undefined) throw new Error('mainnet Lite PSM is not configured');
  return publicClient.readContract({
    address: litePsm,
    abi: litePsmAbi,
    functionName,
    blockNumber: pinnedBlock,
  });
}

// The two functions below restate DssLitePsm's own arithmetic rather than importing the SDK's
// math helpers, so the expectation cannot inherit a rounding mistake from the code under test.

/** DssLitePsm._sellGem: `daiOutWad = gemAmt * to18ConversionFactor; daiOutWad -= daiOutWad * tin / WAD`. */
function litePsmSellGem(usdcIn: bigint, tin: bigint): bigint {
  const usds = usdcIn * USDC_TO_USDS;
  return usds - (usds * tin) / WAD;
}

/** DssLitePsm._buyGem: `daiInWad = gemAmt * to18ConversionFactor; daiInWad += daiInWad * tout / WAD`. */
function litePsmBuyGem(usdcOut: bigint, tout: bigint): bigint {
  const usds = usdcOut * USDC_TO_USDS;
  return usds + (usds * tout) / WAD;
}

/** The most USDC whose buyGem cost fits in `usds`, found by search instead of a closed form. */
function largestBuyableUsdc(usds: bigint, tout: bigint): bigint {
  let low = 0n;
  let high = usds / USDC_TO_USDS;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (litePsmBuyGem(middle, tout) <= usds) low = middle;
    else high = middle - 1n;
  }
  return low;
}

/**
 * The amount the deployed contracts settle for at the pinned block: the output of an exact-in
 * route, the input of an exact-out route. PSM3 chains expose it as a preview; mainnet composes it
 * from the sUSDS vault's ERC-4626 previews and the Lite PSM's on-chain fees.
 */
async function onChainSettlement(routeMode: RouteMode, amount: bigint): Promise<bigint> {
  const { assetIn, assetOut, mode } = routeMode;
  if (capability.protocol === 'psm3') {
    return publicClient.readContract({
      address: capability.contracts.psm,
      abi: psm3Abi,
      functionName: mode === 'exact-in' ? 'previewSwapExactIn' : 'previewSwapExactOut',
      args: [capability.tokens[assetIn].address, capability.tokens[assetOut].address, amount],
      blockNumber: pinnedBlock,
    });
  }

  switch (`${mode}:${assetIn}:${assetOut}`) {
    case 'exact-in:USDC:USDS':
      return litePsmSellGem(amount, await readLitePsmFee('tin'));
    case 'exact-in:USDC:sUSDS':
      return readVaultPreview(
        'previewDeposit',
        litePsmSellGem(amount, await readLitePsmFee('tin')),
      );
    case 'exact-out:USDS:USDC':
      return litePsmBuyGem(amount, await readLitePsmFee('tout'));
    case 'exact-in:USDS:sUSDS':
      return readVaultPreview('previewDeposit', amount);
    case 'exact-out:USDS:sUSDS':
      return readVaultPreview('previewMint', amount);
    case 'exact-in:sUSDS:USDS':
      return readVaultPreview('previewRedeem', amount);
    case 'exact-out:sUSDS:USDS':
      return readVaultPreview('previewWithdraw', amount);
    case 'exact-in:sUSDS:USDC':
      return largestBuyableUsdc(
        await readVaultPreview('previewRedeem', amount),
        await readLitePsmFee('tout'),
      );
    default:
      // A route added to the mainnet matrix must arrive with its own independent expectation.
      throw new Error(`no independent on-chain preview is defined for ${routeLabel(routeMode)}`);
  }
}

function tokenBalance(symbol: TokenSymbol, holder: Address, blockNumber: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: capability.tokens[symbol].address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [holder],
    blockNumber,
  });
}

async function swapperBalances(blockNumber: bigint): Promise<Record<TokenSymbol, bigint>> {
  const [USDC, USDS, sUSDS] = await Promise.all(
    TOKEN_SYMBOLS.map((symbol) => tokenBalance(symbol, FORK_SWAPPER, blockNumber)),
  );
  if (USDC === undefined || USDS === undefined || sUSDS === undefined) {
    throw new Error('a swapper balance read is missing');
  }
  return { USDC, USDS, sUSDS };
}

let pinnedTimestamp: Promise<bigint> | undefined;

/**
 * Mines `call` in a block that reuses the pinned block's timestamp. The sUSDS rate accrues per
 * second on every chain, so a block stamped even one second later settles at a different price
 * than the pinned state quoted; holding time still is what makes exact equality meaningful.
 */
async function sendAtPinnedTime(
  account: Address,
  call: { readonly to: Address; readonly data: Hex; readonly value?: bigint },
) {
  pinnedTimestamp ??= publicClient
    .getBlock({ blockNumber: pinnedBlock })
    .then((block) => block.timestamp);
  await anvil('evm_setNextBlockTimestamp', [Number(await pinnedTimestamp)]);
  return sendAs(account, call);
}

function transferCall(symbol: TokenSymbol, to: Address, amount: bigint) {
  return {
    to: capability.tokens[symbol].address,
    data: encodeFunctionData({ abi: fullErc20Abi, functionName: 'transfer', args: [to, amount] }),
  };
}

function approveCall(symbol: TokenSymbol, spender: Address, amount: bigint) {
  return {
    to: capability.tokens[symbol].address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  };
}

/**
 * Gives the code-free swapper at least `amount` of `symbol` out of the protocol's own liquidity.
 * Call it inside a snapshot: it mines blocks.
 */
async function fundSwapper(symbol: TokenSymbol, amount: bigint): Promise<void> {
  const { psm, litePsm } = capability.contracts;
  if (symbol === 'USDC') {
    // The Lite PSM's pocket on mainnet; the PSM3's pocket (the PSM3 itself today) on L2s.
    const pocket = await publicClient.readContract({
      address: litePsm ?? psm,
      abi: litePsm === undefined ? psm3Abi : litePsmAbi,
      functionName: 'pocket',
      blockNumber: pinnedBlock,
    });
    await sendAtPinnedTime(pocket, transferCall('USDC', FORK_SWAPPER, amount));
    return;
  }
  if (capability.protocol === 'psm3') {
    // A PSM3 custodies its USDS and sUSDS directly.
    await sendAtPinnedTime(psm, transferCall(symbol, FORK_SWAPPER, amount));
    return;
  }

  // Mainnet has no pool to draw USDS or sUSDS from, so mint them through the protocol. Each
  // approval is for exactly what the next call pulls, which leaves no allowance behind to change
  // the approvals of the plan under test.
  if (symbol === 'USDS') {
    const tin = await readLitePsmFee('tin');
    const usdcIn = (amount * WAD) / ((WAD - tin) * USDC_TO_USDS) + 1n;
    await fundSwapper('USDC', usdcIn);
    await sendAtPinnedTime(FORK_SWAPPER, approveCall('USDC', psm, usdcIn));
    await sendAtPinnedTime(FORK_SWAPPER, {
      to: psm,
      data: encodeFunctionData({
        abi: usdsPsmWrapperAbi,
        functionName: 'sellGem',
        args: [FORK_SWAPPER, usdcIn],
      }),
    });
    return;
  }
  const usdsIn = await readVaultPreview('previewMint', amount);
  await fundSwapper('USDS', usdsIn);
  await sendAtPinnedTime(
    FORK_SWAPPER,
    approveCall('USDS', capability.tokens.sUSDS.address, usdsIn),
  );
  await sendAtPinnedTime(FORK_SWAPPER, {
    to: capability.tokens.sUSDS.address,
    data: encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'mint',
      args: [amount, FORK_SWAPPER],
    }),
  });
}

/**
 * Why a PSM3 route cannot settle on this fork, read from the pool's USDS balance at the pinned
 * block, or `undefined` when it can. A PSM3 pays out only what it holds, and it is also the only
 * USDS source the pinned state guarantees for funding a USDS input.
 */
async function psm3UsdsShortfall(
  { assetIn, assetOut }: RouteMode,
  quoted: ReturnType<typeof quotedSettlement>,
): Promise<string | undefined> {
  if (capability.protocol !== 'psm3') return undefined;
  const held = await tokenBalance('USDS', capability.contracts.psm, pinnedBlock);
  if (assetOut === 'USDS' && held < quoted.amountOut) {
    return `the PSM3 holds ${held} USDS and cannot pay out ${quoted.amountOut}`;
  }
  if (assetIn === 'USDS' && held < quoted.maximumIn) {
    return `the PSM3 holds ${held} USDS, so a ${quoted.maximumIn} USDS input cannot be funded from it`;
  }
  return undefined;
}

function thirdAsset({ assetIn, assetOut }: RouteMode): TokenSymbol {
  const third = TOKEN_SYMBOLS.find((symbol) => symbol !== assetIn && symbol !== assetOut);
  if (third === undefined) throw new Error('a route must leave one asset untouched');
  return third;
}

// Mainnet is slow to mine on: each step is its own transaction against lazily fetched fork state.
const SETTLEMENT_TIMEOUT = 180_000;

describe(`pinned ${capability.name} fork at block ${pinnedBlock}`, () => {
  it('matches the pinned head and every configured deployment contains bytecode', async () => {
    expect(await publicClient.getBlockNumber()).toBe(pinnedBlock);
    const addresses = new Set<Address>([
      capability.contracts.psm,
      capability.ssr.address,
      ...Object.values(capability.tokens).map((token) => token.address),
      ...(capability.contracts.litePsm === undefined ? [] : [capability.contracts.litePsm]),
    ]);

    const deployedCode = await Promise.all(
      [...addresses].map(
        async (address) =>
          [address, await publicClient.getCode({ address, blockNumber: pinnedBlock })] as const,
      ),
    );
    for (const [address, code] of deployedCode) expectCode(code, address);
  });

  it('reads the configured SSR ABI and protocol quote math at the pinned state', async () => {
    const ssr = await publicClient.readContract({
      address: capability.ssr.address,
      abi: ssrAbi,
      functionName: capability.ssr.functionName,
      blockNumber: pinnedBlock,
    });
    expect(ssr).toBeGreaterThanOrEqual(10n ** 27n);

    if (capability.protocol === 'psm3') {
      const amountIn = 1_000_000n;
      const amountOut = await publicClient.readContract({
        address: capability.contracts.psm,
        abi: psm3Abi,
        functionName: 'previewSwapExactIn',
        args: [capability.tokens.USDC.address, capability.tokens.USDS.address, amountIn],
        blockNumber: pinnedBlock,
      });
      const requiredInput = await publicClient.readContract({
        address: capability.contracts.psm,
        abi: psm3Abi,
        functionName: 'previewSwapExactOut',
        args: [capability.tokens.USDC.address, capability.tokens.USDS.address, amountOut],
        blockNumber: pinnedBlock,
      });
      expect(amountOut).toBeGreaterThan(0n);
      expect(requiredInput).toBeLessThanOrEqual(amountIn);
      return;
    }

    const litePsm = capability.contracts.litePsm;
    if (litePsm === undefined) throw new Error('mainnet Lite PSM is not configured');
    const [tin, tout, shares] = await Promise.all([
      publicClient.readContract({
        address: litePsm,
        abi: litePsmAbi,
        functionName: 'tin',
        blockNumber: pinnedBlock,
      }),
      publicClient.readContract({
        address: litePsm,
        abi: litePsmAbi,
        functionName: 'tout',
        blockNumber: pinnedBlock,
      }),
      publicClient.readContract({
        address: capability.tokens.sUSDS.address,
        abi: erc4626Abi,
        functionName: 'previewDeposit',
        args: [10n ** 18n],
        blockNumber: pinnedBlock,
      }),
    ]);
    expect(usdsFromUsdcViaSellGem(1_000_000n, tin)).toBeGreaterThan(0n);
    expect(usdsNeededForUsdcViaBuyGem(1_000_000n, tout)).toBeGreaterThanOrEqual(10n ** 18n);
    expect(shares).toBeGreaterThan(0n);
  });

  it('prepares and independently simulates a real plan without broadcasting the swap', async () => {
    const amountIn = 1_000_000n;
    // Leave the shared fork untouched for the other fork files.
    const snapshot = (await anvil('evm_snapshot')) as Hex;
    try {
      // The protocol's USDC lives in its pocket (the Lite PSM's pocket on mainnet, the PSM3 itself
      // on L2s), so fund a fresh code-free swapper from there instead of impersonating the protocol.
      const pocket = await publicClient.readContract({
        address: capability.contracts.litePsm ?? capability.contracts.psm,
        abi: capability.contracts.litePsm === undefined ? psm3Abi : litePsmAbi,
        functionName: 'pocket',
      });
      expect(await publicClient.getCode({ address: FORK_SWAPPER })).toBeUndefined();
      await sendAs(pocket, {
        to: capability.tokens.USDC.address,
        data: encodeFunctionData({
          abi: fullErc20Abi,
          functionName: 'transfer',
          args: [FORK_SWAPPER, amountIn],
        }),
      });
      await sendAs(FORK_SWAPPER, {
        to: capability.tokens.USDC.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [capability.contracts.psm, UINT256_MAX],
        }),
      });

      const publicClients = {
        [chainId]: publicClient as unknown as OseroPublicClient,
      } as Partial<Record<OseroChainId, OseroPublicClient>>;
      const client = OseroClient.create({ publicClients });
      const input = tokenAmount('USDC', amountIn);
      const slippage = parseSlippage({ bps: '5' });
      if (input.isErr() || slippage.isErr()) throw new Error('fork test input failed');
      const isPsm3 = capability.protocol === 'psm3';
      const prepared = await prepareSwap(client, {
        chainId,
        account: FORK_SWAPPER,
        mode: 'exact-in',
        amountIn: input.value,
        // PSM3 pools are not guaranteed to hold USDS (OP and Unichain hold none at their pinned
        // blocks); sUSDS is the liquid L2 route. Mainnet's single-step route is USDC -> USDS.
        assetOut: isPsm3 ? 'sUSDS' : 'USDS',
        slippage: slippage.value,
        referral: false,
        approvalPolicy: 'none',
        // The mainnet wrapper's sellGem takes no minimum output, so that route needs explicit consent.
        allowUnprotectedSlippage: !isPsm3,
      });
      if (prepared.isErr()) throw prepared.error;

      expect(prepared.value.plan.steps).toHaveLength(1);
      const simulation = await simulateExecutionPlan(client, prepared.value.plan, FORK_SWAPPER);
      if (simulation.isErr()) throw simulation.error;
      expect(simulation.value.steps).toHaveLength(1);
      expect(simulation.value.steps[0]?.result.status).toBe('success');
    } finally {
      await anvil('evm_revert', [snapshot]);
    }
  });

  it('declares a Multicall3 that is deployed and callable at the pinned block', async () => {
    const multicall3 = capability.viemChain.contracts?.multicall3?.address;
    expect(multicall3, `${capability.name} must declare contracts.multicall3`).toBeDefined();
    if (multicall3 === undefined) return;
    if (chainId === 130) {
      // viem ships no Unichain entry here: capabilities.ts declares the canonical deployment inline.
      expect(multicall3.toLowerCase()).toBe('0xca11bde05977b3631167028862be2a173976ca11');
    }
    expectCode(
      await publicClient.getCode({ address: multicall3, blockNumber: pinnedBlock }),
      multicall3,
    );

    // Bytecode alone does not make it Multicall3; viem's multicall action must get answers from it.
    const decimals = await publicClient.multicall({
      allowFailure: false,
      blockNumber: pinnedBlock,
      contracts: TOKEN_SYMBOLS.map((symbol) => ({
        address: capability.tokens[symbol].address,
        abi: erc20Abi,
        functionName: 'decimals' as const,
      })),
    });
    expect(decimals).toEqual(TOKEN_SYMBOLS.map((symbol) => capability.tokens[symbol].decimals));
  });

  for (const routeMode of ROUTE_MODES) {
    const { assetIn, assetOut, mode } = routeMode;
    const label = routeLabel(routeMode);

    it(`quotes ${label} exactly as the pinned chain previews it`, async () => {
      const quote = await quoteRoute(routeMode, FIVE_BPS);
      expect(quote.quotedAt.blockNumber).toBe(pinnedBlock);

      if (quote.mode === 'exact-in') {
        expect(quote.amountIn.raw).toBe(ROUTE_AMOUNTS[assetIn]);
        const expectedOut = await onChainSettlement(routeMode, quote.amountIn.raw);
        expect(expectedOut).toBeGreaterThan(0n);
        expect(quote.expectedAmountOut.raw).toBe(expectedOut);
        // 5 bps below the preview, rounded down: the minimum the route would be held to.
        expect(quote.minimumAmountOut.raw).toBe((expectedOut * 9_995n) / 10_000n);
        return;
      }
      expect(quote.amountOut.raw).toBe(ROUTE_AMOUNTS[assetOut]);
      const expectedIn = await onChainSettlement(routeMode, quote.amountOut.raw);
      expect(expectedIn).toBeGreaterThan(0n);
      expect(quote.expectedAmountIn.raw).toBe(expectedIn);
      // 5 bps above the preview, rounded up: the maximum the route would be allowed to pull.
      expect(quote.maximumAmountIn.raw).toBe((expectedIn * 10_005n + 9_999n) / 10_000n);
    });

    it(
      `settles ${label} for exactly the quoted amounts`,
      async (context) => {
        const quote = await quoteRoute(routeMode, NO_SLIPPAGE);
        expect(quote.mode).toBe(mode);
        const quoted = quotedSettlement(quote);
        // The liquidity test below asserts how the SDK reports a route this skip leaves out.
        const shortfall = await psm3UsdsShortfall(routeMode, quoted);
        if (shortfall !== undefined) context.skip(shortfall);

        const snapshot = (await anvil('evm_snapshot')) as Hex;
        try {
          await fundSwapper(assetIn, quoted.maximumIn);
          const fundedBlock = await publicClient.getBlockNumber();
          const before = await swapperBalances(fundedBlock);
          expect(before[assetIn]).toBeGreaterThanOrEqual(quoted.maximumIn);

          const prepared = await prepareSwap(forkClient, {
            ...quoteRequest(routeMode, NO_SLIPPAGE),
            account: FORK_SWAPPER,
            referral: false,
            approvalPolicy: 'exact',
            // Several mainnet routes have no on-chain slippage bound and need explicit consent.
            allowUnprotectedSlippage: quote.slippageProtection.enforcedBy === 'none',
          });
          if (prepared.isErr()) throw prepared.error;
          // Funding moved balances and mined blocks, but time stood still, so the plan is built on
          // the same amounts the untouched pinned state quoted.
          expect(quotedSettlement(prepared.value)).toEqual(quoted);

          let settledBlock = fundedBlock;
          // oxlint-disable no-await-in-loop -- Plan steps settle in order, one block each.
          for (const step of prepared.value.plan.steps) {
            const receipt = await sendAtPinnedTime(FORK_SWAPPER, {
              to: step.to,
              data: step.data,
              value: step.value,
            });
            settledBlock = receipt.blockNumber;
          }
          // oxlint-enable no-await-in-loop

          const after = await swapperBalances(settledBlock);
          expect(before[assetIn] - after[assetIn], `${assetIn} spent`).toBe(quoted.amountIn);
          expect(after[assetOut] - before[assetOut], `${assetOut} received`).toBe(quoted.amountOut);

          // The third asset is untouched, except that mainnet sUSDS -> USDC redeems into USDS and
          // buys whole USDC units with it, which leaves the account the sub-unit USDS remainder.
          const intermediate = thirdAsset(routeMode);
          const remainder =
            capability.protocol === 'psm3' || assetIn !== 'sUSDS' || assetOut !== 'USDC'
              ? 0n
              : (await readVaultPreview('previewRedeem', quoted.amountIn)) -
                litePsmBuyGem(quoted.amountOut, await readLitePsmFee('tout'));
          expect(after[intermediate] - before[intermediate], `${intermediate} left over`).toBe(
            remainder,
          );
        } finally {
          await anvil('evm_revert', [snapshot]);
        }
      },
      SETTLEMENT_TIMEOUT,
    );

    if (capability.protocol !== 'psm3' || assetOut !== 'USDS') continue;

    it(
      `simulates ${label} as a failed step exactly when the PSM3 holds too little USDS`,
      async () => {
        const { psm } = capability.contracts;
        const usdsHeld = await tokenBalance('USDS', psm, pinnedBlock);
        const quoted = quotedSettlement(await quoteRoute(routeMode, FIVE_BPS));

        const snapshot = (await anvil('evm_snapshot')) as Hex;
        try {
          // Give the account everything the swap needs from it, so that the pool's USDS is the
          // only thing left that can fail the step.
          await fundSwapper(assetIn, quoted.maximumIn);
          await sendAtPinnedTime(FORK_SWAPPER, approveCall(assetIn, psm, UINT256_MAX));

          const prepared = await prepareSwap(forkClient, {
            ...quoteRequest(routeMode, FIVE_BPS),
            account: FORK_SWAPPER,
            referral: false,
            approvalPolicy: 'none',
          });
          if (prepared.isErr()) throw prepared.error;
          expect(prepared.value.plan.steps).toHaveLength(1);

          // An Err here would be the failure escaping the report, which is what must not happen.
          const simulation = await simulateExecutionPlan(
            forkClient,
            prepared.value.plan,
            FORK_SWAPPER,
          );
          if (simulation.isErr()) throw simulation.error;
          expect(simulation.value.tokenBalances.map(({ balance }) => balance)).toEqual([
            quoted.maximumIn,
          ]);
          expect(simulation.value.allowances.map(({ allowance }) => allowance)).toEqual([
            UINT256_MAX,
          ]);
          expect(simulation.value.steps).toHaveLength(1);
          const result = simulation.value.steps[0]?.result;

          if (usdsHeld >= quoted.amountOut) {
            expect(result?.status, `the PSM3 holds ${usdsHeld} USDS`).toBe('success');
            return;
          }
          expect(result?.status, `the PSM3 holds ${usdsHeld} USDS`).toBe('failed');
          if (result?.status !== 'failed') return;
          expect(result.error).toBeInstanceOf(SimulationError);
          expect(result.error.execution?.stepId).toBe(prepared.value.plan.steps[0]?.id);

          // Control: the same account, balance and allowance simulate cleanly once the payout is
          // the pool's other asset, so the failure above is the missing USDS and nothing else.
          const amountIn = tokenAmount(assetIn, quoted.maximumIn);
          if (amountIn.isErr()) throw amountIn.error;
          const control = await prepareSwap(forkClient, {
            chainId,
            account: FORK_SWAPPER,
            mode: 'exact-in',
            amountIn: amountIn.value,
            assetOut: thirdAsset(routeMode),
            slippage: FIVE_BPS,
            referral: false,
            approvalPolicy: 'none',
          });
          if (control.isErr()) throw control.error;
          const controlSimulation = await simulateExecutionPlan(
            forkClient,
            control.value.plan,
            FORK_SWAPPER,
          );
          if (controlSimulation.isErr()) throw controlSimulation.error;
          expect(controlSimulation.value.steps.map((step) => step.result.status)).toEqual([
            'success',
          ]);
        } finally {
          await anvil('evm_revert', [snapshot]);
        }
      },
      SETTLEMENT_TIMEOUT,
    );
  }
});
