/**
 * Request an Osero API quote and broadcast its executionPlan with viem.
 *
 * This submits real transactions on Base:
 *   1. USDC.approve(...)
 *   2. Osero API execution transaction
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples api:execute-quote-viem
 */
import { flattenExecutionPlan, getChain } from '@osero/client';
import { OseroApiClient } from '@osero/client/api';
import { sendWith } from '@osero/client/viem';
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadPrivateKey, optionalEnv, optionalRpcUrl, requireEnv } from '../shared/env.js';
import { banner, describePlan, describeResult } from '../shared/format.js';

const SOURCE_CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('1', 6);

function optionalReferralCode(): number | undefined {
  const raw = optionalEnv('OSERO_API_REFERRAL_CODE');
  if (raw === undefined) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error('OSERO_API_REFERRAL_CODE must be an integer from 3000 to 3999.');
  }
  return parsed;
}

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chainMeta = getChain(SOURCE_CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${SOURCE_CHAIN_ID}`);

  const api = OseroApiClient.create({
    apiKey: requireEnv('OSERO_API_KEY'),
    baseUrl: optionalEnv('OSERO_API_BASE_URL'),
  });

  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(optionalRpcUrl(SOURCE_CHAIN_ID)),
  });

  banner(`API quote execution - ${chainMeta.name} (${SOURCE_CHAIN_ID})`);
  console.log(`  sender: ${account.address}`);
  console.log(`  spend:  ${AMOUNT_USDC} USDC (raw 6-dec)`);

  const quote = await api.getSwapQuote({
    fromAddress: account.address,
    fromAssetId: 'base:usdc',
    toAssetId: 'ethereum:susds',
    amount: AMOUNT_USDC,
    slippage: '0.5',
    referralCode: optionalReferralCode(),
  });
  if (quote.isErr()) throw quote.error;

  console.log(`  amount out: ${quote.value.quote.amountOut?.formatted ?? 'preview unavailable'}`);
  console.log(
    `  bridge:     ${quote.value.bridge.required ? quote.value.bridge.protocol : 'none'}`,
  );
  console.log(`  tx count:   ${flattenExecutionPlan(quote.value.executionPlan).length}`);
  console.log(describePlan(quote.value.executionPlan));

  const result = await sendWith(wallet, quote.value.executionPlan);
  if (result.isErr()) throw result.error;

  banner('Submitted');
  console.log(describeResult(result.value, chainMeta.explorerUrl));

  if (quote.value.bridge.required) {
    console.log('\n  Track bridge status with:');
    console.log(`  api.getSwapStatusForQuote(quote, '${result.value.txHash}')`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
