import { getChain, parseSlippage, referral, type Referral } from '@osero/client';
import { oseroApiAmount, OseroApiClient } from '@osero/client/api';
import { sendWith } from '@osero/client/viem';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadPrivateKey, optionalEnv, optionalRpcUrl, requireEnv } from '../shared/env.js';
import { banner, describePlan, describeResult } from '../shared/format.js';

const SOURCE_CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('1', 6);

function optionalReferral(): Referral | undefined {
  const raw = optionalEnv('OSERO_API_REFERRAL_CODE');
  if (raw === undefined) return undefined;
  const result = referral(BigInt(raw));
  if (result.isErr()) throw result.error;
  return result.value;
}

async function main() {
  const account = privateKeyToAccount(loadPrivateKey());
  const chain = getChain(SOURCE_CHAIN_ID);
  if (chain === null) throw new Error(`unsupported chain ${SOURCE_CHAIN_ID}`);
  const transport = http(optionalRpcUrl(SOURCE_CHAIN_ID));
  const publicClient = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account, chain: base, transport });
  const baseUrl = optionalEnv('OSERO_API_BASE_URL');
  const api = OseroApiClient.create({
    apiKey: requireEnv('OSERO_API_KEY'),
    publicClientProvider: (chainId) => {
      if (chainId !== SOURCE_CHAIN_ID) {
        throw new Error(`no public client configured for chain ${chainId}`);
      }
      return publicClient;
    },
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const amount = oseroApiAmount(AMOUNT_USDC);
  const slippage = parseSlippage('50');
  if (amount.isErr() || slippage.isErr()) throw new Error('quote input failed validation');
  const attribution = optionalReferral();

  banner(`API quote execution — ${chain.name}`);
  const quote = await api.getSwapQuote({
    fromAddress: account.address,
    fromAssetId: 'base:usdc',
    toAssetId: 'ethereum:susds',
    amount: amount.value,
    slippage: slippage.value,
    ...(attribution === undefined ? {} : { referral: attribution }),
  });
  if (quote.isErr()) throw quote.error;

  console.log(`  amount out: ${quote.value.quote.amountOut?.formatted ?? 'preview unavailable'}`);
  console.log(`  bridge: ${quote.value.bridge.required ? quote.value.bridge.protocol : 'none'}`);
  console.log(`  tx count: ${quote.value.executionPlan.steps.length}`);
  console.log(describePlan(quote.value.executionPlan));

  const result = await sendWith(wallet, quote.value.executionPlan);
  if (result.isErr()) throw result.error;

  banner('Submitted');
  console.log(describeResult(result.value, chain.explorerUrl));
  if (quote.value.bridge.required) {
    console.log(
      'Track completion with api.waitForSwapCompletion(quote.value, result.value.txHash).',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
