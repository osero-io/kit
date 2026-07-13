import { parseSlippage, referral, type Referral } from '@osero/client';
import { oseroApiAmount, OseroApiClient } from '@osero/client/api';
import { createPublicClient, http, isAddress, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';

import { optionalEnv, optionalRpcUrl, requireEnv } from '../shared/env.js';
import { banner, describePlan } from '../shared/format.js';

const DEFAULT_FROM_ADDRESS = '0x1111111111111111111111111111111111111111' as const;

function optionalReferral(): Referral | undefined {
  const raw = optionalEnv('OSERO_API_REFERRAL_CODE');
  if (raw === undefined) return undefined;
  const result = referral(BigInt(raw));
  if (result.isErr()) throw result.error;
  return result.value;
}

async function main() {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(optionalRpcUrl(1)),
  });
  const baseUrl = optionalEnv('OSERO_API_BASE_URL');
  const api = OseroApiClient.create({
    apiKey: requireEnv('OSERO_API_KEY'),
    publicClientProvider: (chainId) => {
      if (chainId !== 1) throw new Error(`no public client configured for chain ${chainId}`);
      return publicClient;
    },
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  const fromAddress = optionalEnv('OSERO_API_FROM_ADDRESS') ?? DEFAULT_FROM_ADDRESS;
  if (!isAddress(fromAddress)) throw new Error('OSERO_API_FROM_ADDRESS must be an EVM address');
  const amount = oseroApiAmount(parseUnits('1', 6));
  const slippage = parseSlippage('50');
  if (amount.isErr() || slippage.isErr()) throw new Error('quote input failed validation');
  const attribution = optionalReferral();

  banner('Supported API assets');
  const assets = await api.getSupportedAssets();
  if (assets.isErr()) throw assets.error;
  for (const asset of assets.value.assets) {
    console.log(`${asset.assetId.padEnd(20)} ${asset.label.padEnd(24)} ${asset.address}`);
  }

  banner('Quote Ethereum USDT → Ethereum USDS');
  const quote = await api.getSwapQuote({
    fromAddress,
    fromAssetId: 'ethereum:usdt',
    toAssetId: 'ethereum:usds',
    amount: amount.value,
    slippage: slippage.value,
    ...(attribution === undefined ? {} : { referral: attribution }),
  });
  if (quote.isErr()) throw quote.error;

  console.log(`amount in:  ${quote.value.quote.amountIn.formatted} USDT`);
  console.log(
    `amount out: ${quote.value.quote.amountOut?.formatted ?? 'preview unavailable'} USDS`,
  );
  console.log(`bridge:     ${quote.value.bridge.required ? quote.value.bridge.protocol : 'none'}`);
  console.log(`tx count:   ${quote.value.executionPlan.steps.length}`);
  console.log(describePlan(quote.value.executionPlan));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
