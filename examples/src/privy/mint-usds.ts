import { OseroClient, getChain } from '@osero/client';
/**
 * Mint USDS from USDC on Base using a Privy server wallet.
 *
 * Identical semantics to `viem/mint-usds.ts` — the only thing that
 * changes is the wallet adapter subpath. Privy signs and broadcasts
 * the transactions server-side; the adapter supplies each fully-built
 * tx with a CAIP-2 chain ID and waits for the receipt with a viem
 * public client before moving to the next one.
 *
 * Requires PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID, and
 * PRIVY_WALLET_ADDRESS in `examples/.env`. Set
 * PRIVY_AUTHORIZATION_PRIVATE_KEY as well if your Privy app requires
 * request authorization.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples privy:mint-usds
 */
import { mintUsds, previewMintUsds } from '@osero/client/actions';
import { sendWith, type PrivyWallet } from '@osero/client/privy';
import { PrivyClient } from '@privy-io/node';
import { http, isAddress, parseUnits } from 'viem';

import { optionalEnv, optionalRpcUrl, requireEnv } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const AMOUNT_USDC = parseUnits('10', 6); // 10 USDC

async function main() {
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  const privy = new PrivyClient({
    appId: requireEnv('PRIVY_APP_ID'),
    appSecret: requireEnv('PRIVY_APP_SECRET'),
  });

  const walletAddress = requireEnv('PRIVY_WALLET_ADDRESS');
  if (!isAddress(walletAddress)) {
    throw new Error(`PRIVY_WALLET_ADDRESS is not a valid EVM address: ${walletAddress}`);
  }

  const authorizationKey = optionalEnv('PRIVY_AUTHORIZATION_PRIVATE_KEY');
  const wallet = {
    id: requireEnv('PRIVY_WALLET_ID'),
    address: walletAddress,
    ...(authorizationKey !== undefined
      ? { authorizationContext: { authorization_private_keys: [authorizationKey] } }
      : {}),
  } satisfies PrivyWallet;

  // `OseroClient` still needs a viem transport for its own read
  // calls; the adapter reuses the same RPC URL for receipt polling.
  const client = OseroClient.create({
    transports: {
      [CHAIN_ID]: http(optionalRpcUrl(CHAIN_ID)),
    },
  });

  banner(`mintUsds — ${chainMeta.name} (Privy)`);
  console.log(`  sender: ${wallet.address}`);
  console.log(`  spend:  ${AMOUNT_USDC} USDC (raw 6-dec)`);

  const previewResult = await previewMintUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
  });
  if (previewResult.isErr()) {
    console.error('previewMintUsds failed:', previewResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(`  quote:  ${formatToken(previewResult.value, 18, 'USDS')}`);

  const result = await mintUsds(client, {
    chainId: CHAIN_ID,
    amount: AMOUNT_USDC,
    sender: wallet.address,
  }).andThen(
    sendWith(privy, wallet, {
      transports: {
        [CHAIN_ID]: http(optionalRpcUrl(CHAIN_ID)),
      },
    }),
  );

  if (result.isErr()) {
    console.error('mintUsds failed:', result.error);
    process.exitCode = 1;
    return;
  }

  banner('Success');
  console.log(describeResult(result.value, chainMeta.explorerUrl));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
