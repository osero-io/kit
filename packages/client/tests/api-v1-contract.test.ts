import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
});
