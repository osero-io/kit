import { getChain, OseroClient } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { sendWith, type PrivyWallet } from '@osero/client/privy';
import { PrivyClient } from '@privy-io/node';
import { http, isAddress, parseUnits } from 'viem';

import { optionalEnv, optionalRpcUrl, requireEnv } from '../shared/env.js';
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
  const walletAddress = requireEnv('PRIVY_WALLET_ADDRESS');
  if (!isAddress(walletAddress)) {
    throw new Error(`PRIVY_WALLET_ADDRESS is not an EVM address: ${walletAddress}`);
  }
  const authorizationKey = optionalEnv('PRIVY_AUTHORIZATION_PRIVATE_KEY');
  const wallet = {
    id: requireEnv('PRIVY_WALLET_ID'),
    address: walletAddress,
    ...(authorizationKey === undefined
      ? {}
      : { authorizationContext: { authorization_private_keys: [authorizationKey] } }),
  } satisfies PrivyWallet;
  const privy = new PrivyClient({
    appId: requireEnv('PRIVY_APP_ID'),
    appSecret: requireEnv('PRIVY_APP_SECRET'),
  });
  const transport = http(optionalRpcUrl(CHAIN_ID));
  const client = OseroClient.create({ transports: { [CHAIN_ID]: transport } });

  banner(`Prepare USDC → USDS — ${chain.name} (Privy)`);
  const prepared = await prepareSwap(client, {
    chainId: CHAIN_ID,
    account: wallet.address,
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
  console.log(describePlan(prepared.value.plan));
  const idempotencyKeys = Object.fromEntries(
    prepared.value.plan.steps.map((step) => [step.id, `${prepared.value.plan.id}:${step.id}`]),
  );
  const result = await sendWith(privy, wallet, prepared.value.plan, {
    chainId: CHAIN_ID,
    transport,
    idempotencyKeys,
  });
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
