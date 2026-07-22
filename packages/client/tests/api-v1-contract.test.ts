import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PublicClient } from 'viem';
import { base } from 'viem/chains';

import {
  isOseroApiEnsoProviderDetails,
  oseroApiAmount,
  OseroApiClient,
  type OseroApiExecutionPlan,
  type OseroApiFetch,
} from '../src/api.js';
import type { ExecutionPlan } from '../src/index.js';
import { parseSlippage, referral } from '../src/index.js';

const contractRoot = process.env.OSERO_API_CONTRACT_ROOT;

describe.skipIf(contractRoot === undefined)('deterministic SDK HTTP contract', () => {
  it('prepares the authoritative Enso same-chain response through the public client', async () => {
    if (contractRoot === undefined) throw new Error('OSERO_API_CONTRACT_ROOT is required');
    const fixture = JSON.parse(
      readFileSync(
        join(contractRoot, 'docs/client-migration/examples/enso-same-chain-quote.json'),
        'utf8',
      ),
    ) as unknown;
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const fetch: OseroApiFetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const amount = oseroApiAmount(1_000_000_000_000_000_000n);
    const slippage = parseSlippage('5');
    const attribution = referral(3001n);
    if (amount.isErr() || slippage.isErr() || attribution.isErr()) {
      throw new Error('contract request fixture is invalid');
    }
    const client = OseroApiClient.create({
      apiKey: 'osero_contract-key',
      baseUrl: 'https://contract.test/v1/',
      fetch,
    });

    const result = await client.getSwapQuote({
      fromAddress: '0x0000000000000000000000000000000000000001',
      fromAssetId: 'ethereum:usds',
      toAssetId: 'ethereum:susds',
      amount: amount.value,
      slippage: slippage.value,
      referral: attribution.value,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(requests).toEqual([
      {
        url: 'https://contract.test/v1/swap/quote',
        init: {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': 'osero_contract-key',
          },
          body: JSON.stringify({
            fromAddress: '0x0000000000000000000000000000000000000001',
            fromAssetId: 'ethereum:usds',
            toAssetId: 'ethereum:susds',
            amount: '1000000000000000000',
            slippage: '5',
            referralCode: 3001,
          }),
        },
      },
    ]);
    expect(result.value.state).toBe('ready-to-execute');
    expect(result.value.quote).toEqual(fixture);
    expect(result.value.quote.statusContext).toBeNull();
    expect(isOseroApiEnsoProviderDetails(result.value.quote.providerDetails)).toBe(true);
    expect(result.value.walletExecutionPlan).toMatchObject({
      __typename: 'ExecutionPlan',
      version: 2,
      quoteExpiresAt: '2030-01-01T00:01:00.000Z',
      metadata: { source: 'hosted-api' },
    });
    expect(result.value.walletExecutionPlan.steps).toEqual([
      expect.objectContaining({
        chainId: 1,
        from: '0x0000000000000000000000000000000000000001',
        to: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
        data: '0x1234',
        value: 0n,
        operation: 'SWAP_EXACT_IN',
        estimatedGas: { gas: 250_000n, source: 'hosted-api' },
      }),
    ]);
  });

  it('keeps the API Execution Plan distinct from a Wallet Execution Plan', () => {
    expectTypeOf<OseroApiExecutionPlan>().not.toMatchTypeOf<ExecutionPlan>();
  });

  it('drives the authoritative LI.FI approval through provider-locked Quote Refresh', async () => {
    if (contractRoot === undefined) throw new Error('OSERO_API_CONTRACT_ROOT is required');
    const fixture = JSON.parse(
      readFileSync(
        join(contractRoot, 'docs/client-migration/examples/lifi-cross-chain-quote.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const replacement = structuredClone(fixture);
    const executionPlan = replacement.executionPlan as Record<string, unknown>;
    executionPlan.approvalSteps = [];
    const replacementExecution = executionPlan.executionStep as {
      transaction: { calldata: string };
    };
    replacementExecution.transaction.calldata = '0x5678';
    const sourceTransactionHash =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const destinationTransactionHash =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
    const terminalStatus = {
      provider: 'lifi',
      state: 'completed',
      sourceChainId: 8453,
      destinationChainId: 1,
      bridge: 'stargate',
      sourceTransactionHash,
      destinationTransactionHash,
      error: null,
      providerDetails: {
        provider: 'lifi',
        status: 'DONE',
        substatus: 'COMPLETED',
      },
    };
    const responses = [fixture, replacement, terminalStatus];
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    let responseIndex = 0;
    const fetch: OseroApiFetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      const response = responses[responseIndex];
      responseIndex += 1;
      if (response === undefined) throw new Error('Unexpected contract request');
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const publicClient = {
      chain: base,
      getBlockNumber: async () => 123n,
      readContract: async () => 0n,
    } as unknown as PublicClient;
    const inputAmount = oseroApiAmount(1_000_000n);
    const slippage = parseSlippage('50');
    const attribution = referral(3001n);
    if (inputAmount.isErr() || slippage.isErr() || attribution.isErr()) {
      throw new Error('contract request fixture is invalid');
    }
    const client = OseroApiClient.create({
      apiKey: 'osero_contract-key',
      baseUrl: 'https://contract.test/v1/',
      fetch,
      publicClientProvider: () => publicClient,
    });

    const initial = await client.getSwapQuote({
      fromAddress: '0x0000000000000000000000000000000000000001',
      fromAssetId: 'base:usdc',
      toAssetId: 'ethereum:susds',
      amount: inputAmount.value,
      slippage: slippage.value,
      referral: attribution.value,
    });

    if (initial.isErr()) throw initial.error;
    expect(initial.isOk()).toBe(true);
    expect(initial.value.state).toBe('approval-required');
    expect(initial.value.walletExecutionPlan.steps).toEqual([
      expect.objectContaining({
        chainId: 8453,
        from: '0x0000000000000000000000000000000000000001',
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        data: (
          fixture.executionPlan as Record<string, unknown> & {
            approvalSteps: { transaction: { calldata: string } }[];
          }
        ).approvalSteps[0]?.transaction.calldata,
        value: 0n,
        operation: 'APPROVE_ERC20',
        authorization: {
          kind: 'erc20-approval',
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          owner: '0x0000000000000000000000000000000000000001',
          spender: '0x0000000000000000000000000000000000000002',
          amount: 1_000_000n,
        },
        estimatedGas: { gas: 50_000n, source: 'hosted-api' },
      }),
    ]);

    const refreshed = await client.refreshSwapQuote(initial.value.quote.refreshContext);

    expect(refreshed.isOk()).toBe(true);
    if (refreshed.isErr()) throw refreshed.error;
    expect(refreshed.value.state).toBe('ready-to-execute');
    expect(refreshed.value.walletExecutionPlan.steps.map((step) => step.operation)).toEqual([
      'SWAP_EXACT_IN',
    ]);
    expect(refreshed.value.walletExecutionPlan.steps[0]?.data).toBe('0x5678');
    expect(refreshed.value.walletExecutionPlan.steps[0]?.data).not.toBe(
      initial.value.quote.executionPlan.executionStep.transaction.calldata,
    );
    expect(requests[1]).toEqual({
      url: 'https://contract.test/v1/swap/quote/refresh',
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': 'osero_contract-key',
        },
        body: JSON.stringify(initial.value.quote.refreshContext),
      },
    });

    const status = await client.getSwapStatusForQuote(refreshed.value.quote, sourceTransactionHash);

    expect(status.isOk()).toBe(true);
    if (status.isErr()) throw status.error;
    expect(status.value).toEqual(terminalStatus);
    expect(requests[2]).toEqual({
      url:
        `https://contract.test/v1/swap/status/${sourceTransactionHash}` +
        '?provider=lifi&sourceChainId=8453&destinationChainId=1&bridge=stargate',
      init: {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': 'osero_contract-key',
        },
      },
    });
  });
});
