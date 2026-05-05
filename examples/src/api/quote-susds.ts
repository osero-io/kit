/**
 * Request a ready-to-sign Osero API quote without broadcasting anything.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples api:quote-susds
 */
import { flattenExecutionPlan } from '@osero/client';
import { OseroApiClient } from '@osero/client/api';
import { parseUnits } from 'viem';

import { optionalEnv, requireEnv } from '../shared/env.js';
import { banner, describePlan } from '../shared/format.js';

const DEFAULT_FROM_ADDRESS = '0x1111111111111111111111111111111111111111' as const;

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
  const api = OseroApiClient.create({
    apiKey: requireEnv('OSERO_API_KEY'),
    baseUrl: optionalEnv('OSERO_API_BASE_URL'),
  });

  const fromAddress = optionalEnv('OSERO_API_FROM_ADDRESS') ?? DEFAULT_FROM_ADDRESS;

  banner('Supported API assets');
  const assets = await api.getSupportedAssets();
  if (assets.isErr()) throw assets.error;
  for (const asset of assets.value.assets) {
    console.log(`${asset.assetId.padEnd(16)} ${asset.label.padEnd(18)} ${asset.address}`);
  }

  banner('Quote Base USDC → Ethereum sUSDS');
  const quote = await api.getSwapQuote({
    fromAddress: fromAddress as `0x${string}`,
    fromAssetId: 'base:usdc',
    toAssetId: 'ethereum:susds',
    amount: parseUnits('1', 6),
    slippage: '0.5',
    referralCode: optionalReferralCode(),
  });

  if (quote.isErr()) throw quote.error;

  console.log(`amount in:  ${quote.value.quote.amountIn.formatted} USDC`);
  console.log(
    `amount out: ${quote.value.quote.amountOut?.formatted ?? 'preview unavailable'} sUSDS`,
  );
  console.log(`bridge:     ${quote.value.bridge.required ? quote.value.bridge.protocol : 'none'}`);
  console.log(`tx count:   ${flattenExecutionPlan(quote.value.executionPlan).length}`);
  console.log(describePlan(quote.value.executionPlan));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
