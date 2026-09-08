import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Address,
  type EIP1193RequestFn,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { sendWith, supportsAtomicBatch } from '../src/eip5792.js';
import { erc20Abi } from '../src/lib/abis/erc20.js';
import { prepareSwap } from '../src/lib/actions/prepareSwap.js';
import { CHAIN_CAPABILITIES } from '../src/lib/capabilities.js';
import { parseSlippage, tokenAmount } from '../src/lib/domain.js';
import { OseroClient, type OseroPublicClient } from '../src/lib/OseroClient.js';

const PINNED_MAINNET_BLOCK = 25_525_000n;
const ANVIL_ACCOUNT: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const USDC_WHALE: Address = '0x55FE002aefF02F77364de339a1292923A15844B8';
const USDC_IN = 1_000_000n;

const BATCH_EXECUTOR_RUNTIME =
  '0x60806040526004361061001d575f3560e01c80633f707e6b14610021575b5f5ffd5b61003461002f366004610145565b610036565b005b5f5b81811015610140575f5f848484818110610054576100546101b6565b905060200281019061006691906101ca565b6100749060208101906101e8565b6001600160a01b031685858581811061008f5761008f6101b6565b90506020028101906100a191906101ca565b602001358686868181106100b7576100b76101b6565b90506020028101906100c991906101ca565b6100d7906040810190610215565b6040516100e592919061025f565b5f6040518083038185875af1925050503d805f811461011f576040519150601f19603f3d011682016040523d82523d5f602084013e610124565b606091505b50915091508161013657805160208201fd5b5050600101610038565b505050565b5f5f60208385031215610156575f5ffd5b823567ffffffffffffffff81111561016c575f5ffd5b8301601f8101851361017c575f5ffd5b803567ffffffffffffffff811115610192575f5ffd5b8560208260051b84010111156101a6575f5ffd5b6020919091019590945092505050565b634e487b7160e01b5f52603260045260245ffd5b5f8235605e198336030181126101de575f5ffd5b9190910192915050565b5f602082840312156101f8575f5ffd5b81356001600160a01b038116811461020e575f5ffd5b9392505050565b5f5f8335601e1984360301811261022a575f5ffd5b83018035915067ffffffffffffffff821115610244575f5ffd5b602001915036819003821315610258575f5ffd5b9250929050565b818382375f910190815291905056fea2646970667358221220ae39f4701b891744131e2759c145459aab84e1c9350afe3c5039e2e404450c8464736f6c634300081e0033' as Hex;

const batchExecutorAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const erc20TransferAbi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const configuredChainId = Number(process.env['OSERO_FORK_CHAIN_ID']);
const configuredRpcUrl = process.env['OSERO_FORK_RPC_URL'];
if (configuredRpcUrl === undefined || configuredRpcUrl.length === 0) {
  throw new Error('OSERO_FORK_RPC_URL is required; fork tests never use implicit public RPCs');
}
const rpcUrl: string = configuredRpcUrl;
const capability = CHAIN_CAPABILITIES[1];
const publicClient = createPublicClient({
  chain: capability.viemChain,
  transport: http(rpcUrl, { retryCount: 0 }),
});

const describeMainnet = configuredChainId === 1 ? describe : describe.skip;

type JsonRpcError = {
  readonly code?: number;
  readonly message?: string;
};

type JsonRpcPayload = {
  readonly result?: unknown;
  readonly error?: JsonRpcError;
};

type WalletCall = {
  readonly to?: Address;
  readonly data?: Hex;
  readonly value?: Hex;
};

type SendCallsRequest = {
  readonly from?: Address;
  readonly calls?: readonly WalletCall[];
};

type StoredBatch = {
  readonly status: 200 | 500;
  readonly receipt: Record<string, unknown>;
};

async function anvil(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = (await response.json()) as JsonRpcPayload;
  if (!response.ok || payload.error !== undefined) {
    const error = new Error(payload.error?.message ?? `Anvil RPC ${method} failed`);
    Object.assign(error, { code: payload.error?.code });
    throw error;
  }
  return payload.result;
}

function createEip5792Provider(): { request: EIP1193RequestFn } {
  const batches = new Map<string, StoredBatch>();
  let nextBatch = 0;

  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === 'wallet_getCapabilities') {
      return { '0x1': { atomic: { status: 'supported' } } };
    }
    if (method === 'wallet_sendCalls') {
      const body = Array.isArray(params) ? params[0] : undefined;
      if (typeof body !== 'object' || body === null) {
        throw Object.assign(new Error('wallet_sendCalls requires a call bundle'), { code: -32602 });
      }
      const bundle = body as SendCallsRequest;
      if (bundle.from === undefined || bundle.calls === undefined || bundle.calls.length === 0) {
        throw Object.assign(new Error('wallet_sendCalls requires from and calls'), {
          code: -32602,
        });
      }
      const originalCode = (await anvil('eth_getCode', [bundle.from, 'latest'])) as Hex;
      await anvil('anvil_setCode', [bundle.from, BATCH_EXECUTOR_RUNTIME]);
      try {
        const hash = (await anvil('eth_sendTransaction', [
          {
            from: bundle.from,
            to: bundle.from,
            gas: '0x1e8480',
            data: encodeFunctionData({
              abi: batchExecutorAbi,
              functionName: 'execute',
              args: [
                bundle.calls.map((call) => ({
                  to: call.to ?? bundle.from,
                  value: BigInt(call.value ?? '0x0'),
                  data: call.data ?? '0x',
                })),
              ],
            }),
          },
        ])) as Hex;
        const receipt = (await publicClient.waitForTransactionReceipt({
          hash,
        })) as unknown as Record<string, unknown>;
        const id = `0x${(++nextBatch).toString(16).padStart(8, '0')}`;
        batches.set(id, {
          status: receipt['status'] === 'success' ? 200 : 500,
          receipt: {
            ...receipt,
            status: receipt['status'] === 'success' ? '0x1' : '0x0',
            blockNumber:
              typeof receipt['blockNumber'] === 'bigint'
                ? `0x${receipt['blockNumber'].toString(16)}`
                : receipt['blockNumber'],
            gasUsed:
              typeof receipt['gasUsed'] === 'bigint'
                ? `0x${receipt['gasUsed'].toString(16)}`
                : receipt['gasUsed'],
            transactionHash: hash,
          },
        });
        return { id };
      } finally {
        await anvil('anvil_setCode', [bundle.from, originalCode === '0x' ? '0x' : originalCode]);
      }
    }
    if (method === 'wallet_getCallsStatus') {
      const id = Array.isArray(params) ? params[0] : undefined;
      if (typeof id !== 'string') {
        throw Object.assign(new Error('wallet_getCallsStatus requires a batch id'), {
          code: -32602,
        });
      }
      const batch = batches.get(id);
      if (batch === undefined) {
        throw Object.assign(new Error(`unknown batch ${id}`), { code: -32602 });
      }
      return {
        version: '2.0.0',
        chainId: '0x1',
        atomic: true,
        status: batch.status,
        receipts: [batch.receipt],
      };
    }
    return anvil(method, Array.isArray(params) ? params : []);
  };

  return { request: request as EIP1193RequestFn };
}

async function fundUsdc(account: Address, amount: bigint): Promise<void> {
  await anvil('anvil_setBalance', [USDC_WHALE, '0x56bc75e2d63100000']);
  await anvil('anvil_impersonateAccount', [USDC_WHALE]);
  try {
    const funded = await publicClient.readContract({
      address: capability.tokens.USDC.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [USDC_WHALE],
    });
    if (funded < amount) {
      throw new Error(`USDC whale balance ${funded} is below the ${amount} needed for the test`);
    }
    const wallet = createWalletClient({
      account: USDC_WHALE,
      chain: capability.viemChain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });
    const hash = await wallet.sendTransaction({
      account: USDC_WHALE,
      chain: capability.viemChain,
      to: capability.tokens.USDC.address,
      data: encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: 'transfer',
        args: [account, amount],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash });
  } finally {
    await anvil('anvil_stopImpersonatingAccount', [USDC_WHALE]);
  }
}

async function prepareUsdcSwap(
  account: Address,
  assetOut: 'USDS' | 'sUSDS',
  execution: 'sequential' | 'atomic-batch' = 'sequential',
) {
  const client = OseroClient.create({
    publicClients: {
      1: publicClient as unknown as OseroPublicClient,
    },
  });
  const input = tokenAmount('USDC', USDC_IN);
  const slippage = parseSlippage({ bps: '5' });
  if (input.isErr() || slippage.isErr()) throw new Error('fork test input failed');
  const prepared = await prepareSwap(client, {
    chainId: 1,
    account,
    mode: 'exact-in',
    amountIn: input.value,
    assetOut,
    slippage: slippage.value,
    referral: false,
    allowUnprotectedSlippage: true,
    execution,
  });
  if (prepared.isErr()) throw prepared.error;
  return prepared.value;
}

describeMainnet(`eip5792 mainnet fork at block ${PINNED_MAINNET_BLOCK}`, () => {
  it('reports no atomic batch on stock Anvil and falls back to sequential sendWith', async () => {
    const snapshot = (await anvil('evm_snapshot')) as Hex;
    try {
      await fundUsdc(ANVIL_ACCOUNT, USDC_IN);
      const wallet = createWalletClient({
        account: privateKeyToAccount(ANVIL_PRIVATE_KEY),
        chain: capability.viemChain,
        transport: http(rpcUrl, { retryCount: 0 }),
      });
      expect(await supportsAtomicBatch(wallet)).toBe(false);

      const prepared = await prepareUsdcSwap(ANVIL_ACCOUNT, 'USDS');
      expect(prepared.plan.steps.map((step) => step.operation)).toEqual([
        'APPROVE_ERC20',
        'MINT_USDS',
      ]);

      const nonceBefore = await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT });
      const sent = await sendWith(wallet, prepared.plan);
      if (sent.isErr()) throw sent.error;

      expect(sent.value.transactions).toHaveLength(2);
      expect(new Set(sent.value.transactions.map((tx) => tx.hash)).size).toBe(2);
      expect(await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT })).toBe(
        nonceBefore + 2,
      );
      expect(
        await publicClient.readContract({
          address: capability.tokens.USDS.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBeGreaterThan(0n);
    } finally {
      await anvil('evm_revert', [snapshot]);
    }
  });

  it('sends approve and mint as one atomic wallet_sendCalls batch', async () => {
    const snapshot = (await anvil('evm_snapshot')) as Hex;
    try {
      await fundUsdc(ANVIL_ACCOUNT, USDC_IN);
      const wallet = createWalletClient({
        account: privateKeyToAccount(ANVIL_PRIVATE_KEY),
        chain: capability.viemChain,
        transport: custom(createEip5792Provider()),
      });
      expect(await supportsAtomicBatch(wallet)).toBe(true);

      const prepared = await prepareUsdcSwap(ANVIL_ACCOUNT, 'USDS');
      expect(prepared.plan.steps).toHaveLength(2);

      const nonceBefore = await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT });
      const usdsBefore = await publicClient.readContract({
        address: capability.tokens.USDS.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [ANVIL_ACCOUNT],
      });
      const sent = await sendWith(wallet, prepared.plan, { fallbackToSequential: false });
      if (sent.isErr()) throw sent.error;

      expect(sent.value.transactions).toHaveLength(2);
      expect(sent.value.transactions[0]?.hash).toBe(sent.value.txHash);
      expect(sent.value.transactions[1]?.hash).toBe(sent.value.txHash);
      expect(sent.value.transactions.map((tx) => tx.operation)).toEqual([
        'APPROVE_ERC20',
        'MINT_USDS',
      ]);
      expect(await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT })).toBe(
        nonceBefore + 1,
      );
      expect(
        await publicClient.readContract({
          address: capability.tokens.USDS.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBeGreaterThan(usdsBefore);
      expect(
        await publicClient.readContract({
          address: capability.tokens.USDC.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBe(0n);
    } finally {
      await anvil('evm_revert', [snapshot]);
    }
  });

  it('sends USDC to sUSDS as one atomic four-call batch', async () => {
    const snapshot = (await anvil('evm_snapshot')) as Hex;
    try {
      await fundUsdc(ANVIL_ACCOUNT, USDC_IN);
      const wallet = createWalletClient({
        account: privateKeyToAccount(ANVIL_PRIVATE_KEY),
        chain: capability.viemChain,
        transport: custom(createEip5792Provider()),
      });
      const prepared = await prepareUsdcSwap(ANVIL_ACCOUNT, 'sUSDS', 'atomic-batch');
      expect(prepared.plan.requirements.execution).toBe('atomic-batch');
      expect(prepared.plan.steps.map((step) => step.operation)).toEqual([
        'APPROVE_ERC20',
        'MINT_USDS',
        'APPROVE_ERC20',
        'DEPOSIT_USDS_FOR_SUSDS',
      ]);

      const nonceBefore = await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT });
      const sent = await sendWith(wallet, prepared.plan, { fallbackToSequential: false });
      if (sent.isErr()) throw sent.error;

      expect(sent.value.transactions).toHaveLength(4);
      expect(new Set(sent.value.transactions.map((tx) => tx.hash)).size).toBe(1);
      expect(sent.value.transactions[0]?.hash).toBe(sent.value.txHash);
      expect(await publicClient.getTransactionCount({ address: ANVIL_ACCOUNT })).toBe(
        nonceBefore + 1,
      );
      expect(
        await publicClient.readContract({
          address: capability.tokens.USDC.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBe(0n);
      expect(
        await publicClient.readContract({
          address: capability.tokens.USDS.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBe(0n);
      expect(
        await publicClient.readContract({
          address: capability.tokens.sUSDS.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ANVIL_ACCOUNT],
        }),
      ).toBeGreaterThan(0n);
    } finally {
      await anvil('evm_revert', [snapshot]);
    }
  });
});
