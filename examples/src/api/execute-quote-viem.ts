import { getChain, parseSlippage, referral, type Referral } from '@osero/client';
import {
  isOseroApiActionableRecovery,
  oseroApiAmount,
  OseroApiClient,
  prepareRecoveryExecutionPlan,
} from '@osero/client/api';
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
  const slippage = parseSlippage({ bps: '50' });
  if (amount.isErr() || slippage.isErr()) throw new Error('quote input failed validation');
  const attribution = optionalReferral();

  banner(`API quote execution — ${chain.name}`);
  const execution = await api.executeSwap(
    {
      fromAddress: account.address,
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: amount.value,
      slippage: slippage.value,
      ...(attribution === undefined ? {} : { referral: attribution }),
    },
    sendWith(wallet),
    {
      onProgress: (event) => console.log(`  ${event.type}`),
    },
  );
  if (execution.isErr()) throw execution.error;
  const { approvalResults, executionResult, finalQuote } = execution.value;

  console.log(`  amount out: ${finalQuote.quote.expectedOutput.formatted}`);
  console.log(`  bridge: ${finalQuote.routeSummary.bridge ?? 'none'}`);
  console.log(`  approvals: ${approvalResults.length}`);

  banner('Source-chain execution confirmed');
  console.log(describeResult(executionResult, chain.explorerUrl));
  if (finalQuote.statusContext !== null) {
    banner('Separate Transfer Status lifecycle');
    const transfer = await api.waitForSwapCompletion(finalQuote, executionResult.txHash, {
      pollingIntervalMs: 5_000,
      timeoutMs: 30 * 60_000,
      // Let automatic recovery settle instead of returning the first failure.
      waitForRecovery: true,
      onStatus: (status) => console.log(`  ${status.state}`),
    });
    if (transfer.isErr()) throw transfer.error;
    console.log(`  final state: ${transfer.value.state}`);
    if (transfer.value.state === 'failed') console.log(`  error: ${transfer.value.error}`);
    console.log(`  destination: ${transfer.value.destinationTransactionHash ?? 'not reported'}`);

    const recovery = transfer.value.recoveryContext;
    if (recovery !== null) {
      banner('Recovery Context');
      console.log(`  state:  ${recovery.state} (${recovery.reason})`);
      console.log(`  amount: ${recovery.settledAmount ?? recovery.amount ?? 'not reported'}`);
      console.log(`  chain:  ${recovery.chainId ?? 'not reported'}`);
      if (isOseroApiActionableRecovery(recovery)) {
        console.log(`  deadline: ${recovery.deadline ?? 'none'}`);

        // Sender-free by contract: name the submitter rather than assuming one.
        const plan = prepareRecoveryExecutionPlan(transfer.value, account.address);
        if (plan.isErr()) throw plan.error;
        console.log(describePlan(plan.value));

        banner('Submitting the Recovery Action');
        const recovered = await sendWith(wallet)(plan.value);
        if (recovered.isErr()) throw recovered.error;
        console.log(describeResult(recovered.value, chain.explorerUrl));

        // Submission does not settle recovery. Keep polling the original
        // transfer — recovery status is tracked against its source transaction,
        // not the recovery transaction. The first poll may still observe the
        // pre-submission state before the provider advances it to `pending`.
        banner('Recovery settlement');
        const settled = await api.waitForSwapCompletion(finalQuote, executionResult.txHash, {
          pollingIntervalMs: 5_000,
          timeoutMs: 30 * 60_000,
          waitForRecovery: true,
          onStatus: (status) =>
            console.log(`  ${status.recoveryContext?.state ?? 'no recovery context'}`),
        });
        if (settled.isErr()) throw settled.error;
        const settledRecovery = settled.value.recoveryContext;
        console.log(`  state:  ${settledRecovery?.state ?? 'not reported'}`);
        console.log(`  settled: ${settledRecovery?.settledAmount ?? 'not reported'}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
