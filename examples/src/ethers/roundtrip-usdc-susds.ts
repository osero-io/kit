import { getChain, getSUsdsBalance, getTokenBalances, OseroClient } from '@osero/client';
import { prepareSwap } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { JsonRpcProvider, Wallet } from 'ethers';
import { http, parseUnits } from 'viem';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken, requireTokenAmount } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const INPUT_USDC = parseUnits('10', 6);

async function main() {
  const chain = getChain(CHAIN_ID);
  if (chain === null) throw new Error(`unsupported chain ${CHAIN_ID}`);
  const rpcUrl = optionalRpcUrl(CHAIN_ID) ?? 'https://mainnet.base.org';
  const signer = new Wallet(loadPrivateKey(), new JsonRpcProvider(rpcUrl, CHAIN_ID));
  const sender = (await signer.getAddress()) as `0x${string}`;
  const client = OseroClient.create({ transports: { [CHAIN_ID]: http(rpcUrl) } });
  const before = await getTokenBalances(client, { chainId: CHAIN_ID, account: sender });
  if (before.isErr()) throw before.error;
  if (before.value.USDC < INPUT_USDC) {
    throw new Error(`insufficient USDC: have ${before.value.USDC}, need ${INPUT_USDC}`);
  }

  banner('Leg 1 — USDC → sUSDS');
  const deposit = await prepareSwap(client, {
    chainId: CHAIN_ID,
    account: sender,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDC', INPUT_USDC),
    assetOut: 'sUSDS',
  });
  if (deposit.isErr()) throw deposit.error;
  console.log(`  expected: ${formatToken(deposit.value.expectedAmountOut.raw, 18, 'sUSDS')}`);
  const deposited = await sendWith(signer, deposit.value.plan);
  if (deposited.isErr()) throw deposited.error;
  console.log(describeResult(deposited.value, chain.explorerUrl));

  const middle = await getSUsdsBalance(client, { chainId: CHAIN_ID, account: sender });
  if (middle.isErr()) throw middle.error;
  const sharesReceived = middle.value - before.value.sUSDS;

  banner('Leg 2 — sUSDS → USDC');
  const redeem = await prepareSwap(client, {
    chainId: CHAIN_ID,
    account: sender,
    mode: 'exact-in',
    amountIn: requireTokenAmount('sUSDS', sharesReceived),
    assetOut: 'USDC',
  });
  if (redeem.isErr()) throw redeem.error;
  console.log(`  expected: ${formatToken(redeem.value.expectedAmountOut.raw, 6, 'USDC')}`);
  const redeemed = await sendWith(signer, redeem.value.plan);
  if (redeemed.isErr()) throw redeemed.error;
  console.log(describeResult(redeemed.value, chain.explorerUrl));

  const after = await getTokenBalances(client, { chainId: CHAIN_ID, account: sender });
  if (after.isErr()) throw after.error;
  banner('Round-trip complete');
  console.log(`  USDC delta: ${after.value.USDC - before.value.USDC} raw units`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
