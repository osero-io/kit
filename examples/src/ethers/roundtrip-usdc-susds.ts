import { OseroClient, erc20Abi, getChain, getToken } from '@osero/client';
/**
 * Full round-trip on Base using an ethers v6 signer:
 *
 *   USDC → sUSDS (mintSUsds)  → sUSDS → USDC (redeemSUsds)
 *
 * Deliberately mirrors `viem/roundtrip-usdc-susds.ts` almost
 * line-for-line so the diff between the two adapters is easy to
 * spot: different wallet, different balance read, same action
 * calls, same plan handling.
 *
 * Run with:
 *
 *   pnpm --filter @osero/examples ethers:roundtrip
 */
import { mintSUsds, redeemSUsds } from '@osero/client/actions';
import { sendWith } from '@osero/client/ethers';
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi } from 'ethers';
import { http, parseUnits } from 'viem';

import { loadPrivateKey, optionalRpcUrl } from '../shared/env.js';
import { banner, describeResult, formatToken } from '../shared/format.js';

const CHAIN_ID = 8453 as const;
const MINT_AMOUNT_USDC = parseUnits('10', 6);

// Read-only view of an ERC-20 for balance queries. The Osero `erc20Abi`
// export is a viem ABI tuple — ethers accepts it directly as an
// `InterfaceAbi`, no conversion required.
function readonlyErc20(address: string, provider: JsonRpcProvider): Contract {
  return new Contract(address, erc20Abi as InterfaceAbi, provider);
}

async function main() {
  const chainMeta = getChain(CHAIN_ID);
  if (!chainMeta) throw new Error(`unsupported chain ${CHAIN_ID}`);

  const provider = new JsonRpcProvider(
    optionalRpcUrl(CHAIN_ID) ?? 'https://mainnet.base.org',
    CHAIN_ID,
  );
  const signer = new Wallet(loadPrivateKey(), provider);
  const senderAddress = (await signer.getAddress()) as `0x${string}`;

  const client = OseroClient.create({
    transports: {
      [CHAIN_ID]: http(optionalRpcUrl(CHAIN_ID)),
    },
  });

  const usdc = getToken(CHAIN_ID, 'USDC');
  const susds = getToken(CHAIN_ID, 'sUSDS');
  const usdcContract = readonlyErc20(usdc.address, provider);
  const susdsContract = readonlyErc20(susds.address, provider);

  const [usdcBefore, susdsBefore] = await Promise.all([
    usdcContract.balanceOf(senderAddress) as Promise<bigint>,
    susdsContract.balanceOf(senderAddress) as Promise<bigint>,
  ]);

  banner(`Round-trip — ${chainMeta.name} (ethers)`);
  console.log(`  sender: ${senderAddress}`);
  console.log(
    `  start:  ${formatToken(usdcBefore, 6, 'USDC')}, ${formatToken(susdsBefore, 18, 'sUSDS')}`,
  );

  if (usdcBefore < MINT_AMOUNT_USDC) {
    console.error(`  insufficient USDC: have ${usdcBefore}, need ${MINT_AMOUNT_USDC}`);
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------
  // Leg 1 — USDC → sUSDS
  // -------------------------------------------------------------
  banner('Leg 1 — mintSUsds');
  const mintResult = await mintSUsds(client, {
    chainId: CHAIN_ID,
    amount: MINT_AMOUNT_USDC,
    sender: senderAddress,
  }).andThen(sendWith(signer));

  if (mintResult.isErr()) {
    console.error('mintSUsds failed:', mintResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(describeResult(mintResult.value, chainMeta.explorerUrl));

  const susdsMid = (await susdsContract.balanceOf(senderAddress)) as bigint;
  const sharesReceived = susdsMid - susdsBefore;
  console.log(`  received: ${formatToken(sharesReceived, 18, 'sUSDS')}`);

  // -------------------------------------------------------------
  // Leg 2 — sUSDS → USDC
  // -------------------------------------------------------------
  banner('Leg 2 — redeemSUsds');
  const redeemResult = await redeemSUsds(client, {
    chainId: CHAIN_ID,
    amount: sharesReceived,
    sender: senderAddress,
  }).andThen(sendWith(signer));

  if (redeemResult.isErr()) {
    console.error('redeemSUsds failed:', redeemResult.error);
    process.exitCode = 1;
    return;
  }
  console.log(describeResult(redeemResult.value, chainMeta.explorerUrl));

  // -------------------------------------------------------------
  // Final delta
  // -------------------------------------------------------------
  const [usdcAfter, susdsAfter] = await Promise.all([
    usdcContract.balanceOf(senderAddress) as Promise<bigint>,
    susdsContract.balanceOf(senderAddress) as Promise<bigint>,
  ]);

  banner('Round-trip complete');
  console.log(
    `  end:   ${formatToken(usdcAfter, 6, 'USDC')}, ${formatToken(susdsAfter, 18, 'sUSDS')}`,
  );
  console.log(`  Δusdc: ${usdcAfter - usdcBefore} (raw 6-dec)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
