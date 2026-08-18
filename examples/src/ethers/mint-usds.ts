import { getChain, OseroClient } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet } from 'ethers';
import { http, parseUnits } from 'viem';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import {
  banner,
  describePlan,
  describeResult,
  formatToken,
  requireTokenAmount,
} from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('10', 6);

async function main() {
  const chain = getChain(CHAIN_ID);
  if (chain === null) throw new Error(`unsupported chain ${CHAIN_ID}`);
  const rpcUrl = optionalRpcUrl(CHAIN_ID) ?? 'https://mainnet.base.org';
  const signer = new Wallet(loadPrivateKey(), new JsonRpcProvider(rpcUrl, CHAIN_ID));
  const sender = (await signer.getAddress()) as `0x${string}`;
  const client = OseroClient.create({ transports: { [CHAIN_ID]: http(rpcUrl) } });

  banner(`Prepare USDC → USDS — ${chain.name} (ethers)`);
  const prepared = await prepareSwap(client, {
    chainId: CHAIN_ID,
    account: sender,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDC', AMOUNT_USDC),
    assetOut: 'USDS',
  });
  if (prepared.isErr()) {
    console.error('prepareSwap failed:', prepared.error);
    process.exitCode = 1;
    return;
  }

  console.log(`  expected: ${formatToken(prepared.value.expectedAmountOut.raw, 18, 'USDS')}`);
  console.log(`  maximum safety bound: ${prepared.value.slippage.bps} bps`);
  console.log(describePlan(prepared.value.plan));

  const result = await sendWith(signer, prepared.value.plan);
  if (result.isErr()) {
    console.error('sendWith failed:', result.error);
    process.exitCode = 1;
    return;
  }

  banner('Success');
  console.log(describeResult(result.value, chain.explorerUrl));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
