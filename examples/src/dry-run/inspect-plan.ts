import { OseroClient, type PreparedSwapQuote, type SwapQuote } from '@osero/client';
import { prepareSwap, quoteSwap } from '@osero/client/actions';
import { http, parseUnits } from 'viem';

import { optionalRpcUrl } from '../shared/env.js';
import { banner, describePlan, formatToken, requireTokenAmount } from '../shared/format.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const BASE = 8453 as const;
const MAINNET = 1 as const;

function printQuote(quote: SwapQuote): void {
  if (quote.mode === 'exact-in') {
    console.log(
      `expected: ${formatToken(quote.expectedAmountOut.raw, quote.assetOut === 'USDC' ? 6 : 18, quote.assetOut)}`,
    );
    console.log(`minimum raw output: ${quote.minimumAmountOut.raw}`);
  } else {
    console.log(`expected raw input: ${quote.expectedAmountIn.raw}`);
    console.log(`maximum raw input:  ${quote.maximumAmountIn.raw}`);
  }
  console.log(`quoted at block ${quote.quotedAt.blockNumber}`);
}

function printPrepared(quote: PreparedSwapQuote): void {
  printQuote(quote);
  console.log(describePlan(quote.plan));
}

async function main() {
  const client = OseroClient.create({
    transports: {
      [BASE]: http(optionalRpcUrl(BASE)),
      [MAINNET]: http(optionalRpcUrl(MAINNET)),
    },
  });

  banner('Base quote before wallet connection: USDC → USDS');
  const quoted = await quoteSwap(client, {
    chainId: BASE,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDC', parseUnits('100', 6)),
    assetOut: 'USDS',
  });
  if (quoted.isErr()) throw quoted.error;
  printQuote(quoted.value);

  banner('Base exact-in: USDC → USDS');
  const usdcToUsds = await prepareSwap(client, {
    chainId: BASE,
    account: ACCOUNT,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDC', parseUnits('100', 6)),
    assetOut: 'USDS',
  });
  if (usdcToUsds.isErr()) throw usdcToUsds.error;
  printPrepared(usdcToUsds.value);

  banner('Base direct vault route: USDS → sUSDS');
  const usdsToSusds = await prepareSwap(client, {
    chainId: BASE,
    account: ACCOUNT,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDS', parseUnits('100', 18)),
    assetOut: 'sUSDS',
  });
  if (usdsToSusds.isErr()) throw usdsToSusds.error;
  printPrepared(usdsToSusds.value);

  banner('Base exact-out: spend up to USDC for exactly 100 USDS');
  const exactOut = await prepareSwap(client, {
    chainId: BASE,
    account: ACCOUNT,
    mode: 'exact-out',
    assetIn: 'USDC',
    amountOut: requireTokenAmount('USDS', parseUnits('100', 18)),
  });
  if (exactOut.isErr()) throw exactOut.error;
  printPrepared(exactOut.value);

  banner('Mainnet multi-step: USDC → sUSDS');
  const mainnet = await prepareSwap(client, {
    chainId: MAINNET,
    account: ACCOUNT,
    mode: 'exact-in',
    amountIn: requireTokenAmount('USDC', parseUnits('25', 6)),
    assetOut: 'sUSDS',
    referral: false,
    allowUnprotectedSlippage: true,
  });
  if (mainnet.isErr()) throw mainnet.error;
  printPrepared(mainnet.value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
