import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
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
import { prepareSwap } from '../src/lib/actions/prepareSwap.js';
import { CHAIN_CAPABILITIES, type OseroChainId } from '../src/lib/capabilities.js';
import { parseSlippage, tokenAmount, UINT256_MAX } from '../src/lib/domain.js';
import { usdsFromUsdcViaSellGem, usdsNeededForUsdcViaBuyGem } from '../src/lib/math.js';
import { OseroClient, type OseroPublicClient } from '../src/lib/OseroClient.js';
import { simulateExecutionPlan } from '../src/lib/simulation.js';

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
  transport: http(rpcUrl, { retryCount: 0 }),
});

async function anvil(method: string, params: readonly unknown[]): Promise<unknown> {
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

function expectCode(code: Hex | undefined, address: Address): void {
  expect(code, `${address} must contain deployed bytecode`).toMatch(/^0x[0-9a-f]+$/i);
  expect(code).not.toBe('0x');
}

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
    const holder = capability.contracts.litePsm ?? capability.contracts.psm;
    await anvil('anvil_setBalance', [holder, '0x8ac7230489e80000']);
    await anvil('anvil_impersonateAccount', [holder]);

    try {
      const walletClient = createWalletClient({
        account: holder,
        chain: capability.viemChain,
        transport: http(rpcUrl, { retryCount: 0 }),
      });
      const approvalHash = await walletClient.sendTransaction({
        account: holder,
        chain: capability.viemChain,
        to: capability.tokens.USDC.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [capability.contracts.psm, UINT256_MAX],
        }),
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });

      const publicClients = {
        [chainId]: publicClient as unknown as OseroPublicClient,
      } as Partial<Record<OseroChainId, OseroPublicClient>>;
      const client = OseroClient.create({ publicClients });
      const input = tokenAmount('USDC', 1_000_000n);
      const slippage = parseSlippage('5');
      if (input.isErr() || slippage.isErr()) throw new Error('fork test input failed');
      const prepared = await prepareSwap(client, {
        chainId,
        account: holder,
        mode: 'exact-in',
        amountIn: input.value,
        assetOut: 'USDS',
        slippage: slippage.value,
        referral: false,
        approvalPolicy: 'none',
      });
      if (prepared.isErr()) throw prepared.error;

      expect(prepared.value.plan.steps).toHaveLength(1);
      const simulation = await simulateExecutionPlan(client, prepared.value.plan, holder);
      if (simulation.isErr()) throw simulation.error;
      expect(simulation.value.steps).toHaveLength(1);
      expect(simulation.value.steps[0]?.result.status).toBe('success');
    } finally {
      await anvil('anvil_stopImpersonatingAccount', [holder]);
    }
  });
});
