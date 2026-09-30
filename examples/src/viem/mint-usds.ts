import { getChain, OseroClient } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

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
  const account = privateKeyToAccount(loadPrivateKey());
  const chain = getChain(CHAIN_ID);
  if (chain === null) throw new Error(`unsupported chain ${CHAIN_ID}`);
  const transport = http(optionalRpcUrl(CHAIN_ID));
  const wallet = createWalletClient({ account, chain: base, transport });
  const client = OseroClient.create({ transports: { [CHAIN_ID]: transport } });

  banner(`Prepare USDC → USDS — ${chain.name} (viem)`);
  const prepared = await prepareSwap(client, {
    chainId: CHAIN_ID,
    account: account.address,
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
  console.log(`  minimum:  ${formatToken(prepared.value.minimumAmountOut.raw, 18, 'USDS')}`);
  console.log(describePlan(prepared.value.plan));

  const result = await sendWith(wallet, prepared.value.plan);
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
