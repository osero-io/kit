import { parseSlippage, referral, type ExecutionPlanHandler, type Referral } from '@osero/client';
import {
  isOseroApiZeroXProviderDetails,
  oseroApiAmount,
  OseroApiClient,
  type OseroApiApprovalRequired,
} from '@osero/client/api';
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

export async function submitApprovalAndRefresh(
  api: OseroApiClient,
  workflow: OseroApiApprovalRequired,
  executePlan: ExecutionPlanHandler,
) {
  const approval = await executePlan(workflow.walletExecutionPlan);
  if (approval.isErr()) throw approval.error;

  const refreshed = await api.refreshSwapQuote(workflow.quote.refreshContext);
  if (refreshed.isErr()) throw refreshed.error;
  return refreshed.value;
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
  const slippage = parseSlippage({ bps: '50' });
  if (amount.isErr() || slippage.isErr()) throw new Error('quote input failed validation');
  const attribution = optionalReferral();

  banner('Supported API assets');
  const assets = await api.getSupportedAssets();
  if (assets.isErr()) throw assets.error;
  for (const asset of assets.value.assets) {
    console.log(`${asset.assetId.padEnd(20)} ${asset.label.padEnd(24)} ${asset.address}`);
  }

  banner('Quote Ethereum USDT → Ethereum USDS');
  const workflow = await api.getSwapQuote({
    fromAddress,
    fromAssetId: 'ethereum:usdt',
    toAssetId: 'ethereum:usds',
    amount: amount.value,
    slippage: slippage.value,
    ...(attribution === undefined ? {} : { referral: attribution }),
  });
  if (workflow.isErr()) throw workflow.error;
  const { quote, walletExecutionPlan } = workflow.value;

  console.log(`amount in:  ${quote.quote.inputAmount.formatted} USDT`);
  console.log(`amount out: ${quote.quote.expectedOutput.formatted} USDS`);
  console.log(`provider:   ${quote.provider}`);
  console.log(`bridge:     ${quote.routeSummary.bridge ?? 'none'}`);
  if (isOseroApiZeroXProviderDetails(quote.providerDetails)) {
    const { fees, zid } = quote.providerDetails;
    // Reporting only: the amount out above is already net of every fee here.
    console.log(`0x zid:     ${zid}`);
    console.log(`0x fees:    integrator=${fees.integratorFee?.amount ?? 'none'}`);
    console.log(`            zeroEx=${fees.zeroExFee?.amount ?? 'none'}`);
    console.log(`            bridgeNative=${fees.bridgeNativeFee?.amount ?? 'none'}`);
  }
  console.log(`state:      ${workflow.value.state}`);
  console.log(`tx count:   ${walletExecutionPlan.steps.length}`);
  console.log(describePlan(walletExecutionPlan));

  banner('Manual Hosted Swap Workflow');
  if (workflow.value.state === 'approval-required') {
    console.log('Submit only the approval Wallet Execution Plan shown above.');
    console.log('After confirmation, discard the quote actions and call:');
    console.log('submitApprovalAndRefresh(api, workflow.value, executePlan)');
  } else {
    console.log('The Wallet Execution Plan contains only the fresh execution action.');
  }
  console.log('Never submit quote.executionPlan directly; it is the API Execution Plan.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
