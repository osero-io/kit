/**
 * Read the live sUSDS APY on every supported chain. No wallet, no
 * broadcast — just one `eth_call` per chain to either Sky's sUSDS
 * vault (mainnet) or Spark's `SSRAuthOracle` (every L2).
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples dry-run:susds-apy
 */
import { getSsr, getSUsdsApy, listChains, OseroClient, ssrToApy } from '@osero/client';
import { http } from 'viem';

import { optionalRpcUrl } from '../shared/env.js';
import { banner } from '../shared/format.js';

async function main() {
  const chains = listChains();

  const client = OseroClient.create({
    transports: Object.fromEntries(chains.map((c) => [c.chainId, http(optionalRpcUrl(c.chainId))])),
  });

  banner('sUSDS APY across supported chains');

  // Fan out the reads — one RPC per chain, all in flight at once.
  const rows = await Promise.all(
    chains.map(async (chain) => {
      const [ssrResult, apyResult] = await Promise.all([
        getSsr(client, { chainId: chain.chainId }),
        getSUsdsApy(client, { chainId: chain.chainId }),
      ]);
      return { chain, ssrResult, apyResult };
    }),
  );

  for (const { chain, ssrResult, apyResult } of rows) {
    if (ssrResult.isErr()) {
      console.log(`${chain.name.padEnd(14)}  error: ${ssrResult.error.message}`);
      continue;
    }
    if (apyResult.isErr()) {
      console.log(`${chain.name.padEnd(14)}  error: ${apyResult.error.message}`);
      continue;
    }

    const ssr = ssrResult.value;
    const apyPct = apyResult.value * 100;
    console.log(`${chain.name.padEnd(14)}  ssr=${ssr}  apy=${apyPct.toFixed(4)}%`);
  }

  banner('Pure converter — ssrToApy() on a hardcoded rate');

  // Useful when you already have an SSR value (e.g. from a Subgraph or
  // a cached read) and just want to format the APY.
  const exampleSsr = 1_000_000_001_136_785_036_595_443_334n;
  console.log(`ssr=${exampleSsr}`);
  const converted = ssrToApy(exampleSsr);
  if (converted.isErr()) throw converted.error;
  console.log(`apy=${(converted.value * 100).toFixed(4)}%`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
