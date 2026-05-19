import {
  type Address,
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage, usdcFromUsdsViaBuyGem } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeMultiStepPlan, makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { resolveReferralCode, validateReferralCode } from '../referrals.js';
import { errAsync, okAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type {
  Erc20ApprovalRequired,
  ExecutionStepRefreshContext,
  MultiStepExecution,
} from '../types.js';

/**
 * Parameters accepted by {@link redeemSUsds}.
 */
export type RedeemSUsdsRequest = {
  /**
   * The chain on which the redemption should happen. Must be one of
   * the supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of sUSDS shares to burn, in sUSDS's 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;

  /**
   * The wallet that owns the sUSDS shares. On Ethereum mainnet,
   * this wallet also holds the intermediate USDS between the
   * ERC-4626 `redeem` call and the Lite PSM `buyGem` call.
   */
  readonly sender: Address;

  /**
   * The address that receives the final USDC. Defaults to
   * {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points).
   *
   * @defaultValue {@link ClientConfig.defaultSlippageBps} (5 bps)
   */
  readonly slippageBps?: number;

  /**
   * Opaque referral code for L2 PSM3 calls. Ignored on mainnet.
   *
   * @defaultValue {@link ClientConfig.defaultReferralCode} ({@link DEFAULT_REFERRAL_CODE} = 3000n by default). Pass `undefined` to opt out for this call.
   */
  readonly referralCode?: bigint;
};

/**
 * Parameters accepted by {@link previewRedeemSUsds}.
 */
export type PreviewRedeemSUsdsRequest = {
  /**
   * The chain on which the preview should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of sUSDS shares to burn, in sUSDS's native 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;
};

export type RedeemSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much USDC an exact-in {@link redeemSUsds} flow would
 * return for the given sUSDS amount.
 */
export function previewRedeemSUsds(
  client: OseroClient,
  request: PreviewRedeemSUsdsRequest,
): ResultAsync<bigint, RedeemSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetRedeemSUsds(client, chain, request.amount);
  }

  return quoteL2RedeemSUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that redeems sUSDS shares back
 * into USDC on the target chain. The inverse of {@link mintSUsds}.
 *
 * ### L2 path
 *
 * Uses a single approval-then-swap through Spark's PSM3:
 *
 * 1. `sUSDS.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(sUSDS, USDC, amount, minOut, receiver, 0)`
 *
 * ### Mainnet path
 *
 * Uses two phases because mainnet has no PSM3. The ERC-4626 redeem
 * needs no approval (the sender is the owner of the shares) but
 * the subsequent `buyGem` call does:
 *
 * 1. `sUSDS.redeem(amount, sender, sender)` — sender gets USDS
 * 2. `USDS.approve(UsdsPsmWrapper, usdsOut)`
 * 3. `UsdsPsmWrapper.buyGem(receiver, gemAmt)`
 *
 * Phase 2 is refreshed by the SDK adapters after phase 1 confirms,
 * using the actual USDS amount from the redeem receipt and the live
 * Lite PSM `tout`. The plan still includes concrete fallback phase-2
 * transactions for inspection and custom executors.
 */
export function redeemSUsds(
  client: OseroClient,
  request: RedeemSUsdsRequest,
): ResultAsync<Erc20ApprovalRequired | MultiStepExecution, RedeemSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  const resolvedReferralCode = resolveReferralCode(request, client.config);
  const referralCodeError = validateReferralCode(resolvedReferralCode);
  if (referralCodeError) {
    return errAsync(referralCodeError);
  }

  const receiver = request.receiver ?? request.sender;

  if (chain.isMainnet) {
    return buildMainnetPlan(client, chain, request, receiver);
  }
  return buildL2Plan(client, chain, request, receiver, resolvedReferralCode ?? 0n);
}

function buildMainnetPlan(
  client: OseroClient,
  chain: ChainMetadata,
  request: RedeemSUsdsRequest,
  receiver: Address,
): ResultAsync<MultiStepExecution, UnexpectedError> {
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddresses = PSM_ADDRESSES[chain.chainId];
  const wrapperAddress = psmAddresses.psm;
  const litePsmAddress = psmAddresses.litePsm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  return readMainnetRedeemSUsdsQuoteInputs(client, chain, request.amount, litePsmAddress).map(
    ({ usdsOut, tout }): MultiStepExecution => {
      // Phase 1 — sUSDS.redeem(shares, sender, sender).
      // Sender is both owner and receiver of the USDS, so no
      // allowance is needed. The vault burns `shares` from `sender`
      // and transfers `assets` (≈ usdsOut) USDS back.
      const redeemData = encodeFunctionData({
        abi: erc4626Abi,
        functionName: 'redeem',
        args: [request.amount, request.sender, request.sender],
      });
      const redeemTx = makeTransactionRequest({
        chainId: chain.chainId,
        from: request.sender,
        to: susds.address,
        data: redeemData,
        operation: 'REDEEM_SUSDS_FOR_USDS',
      });

      const phase2 = {
        ...buildMainnetRedeemSUsdsPhase2({
          chain,
          sender: request.sender,
          receiver,
          usds: usds.address,
          wrapperAddress,
          usdsAmount: usdsOut,
          tout,
          slippageBps,
        }),
        refresh: (context: ExecutionStepRefreshContext) =>
          refreshMainnetRedeemSUsdsPhase2(client, chain, {
            redeemTxHash: context.previousTxHash,
            shares: request.amount,
            sender: request.sender,
            receiver,
            usds: usds.address,
            susds: susds.address,
            wrapperAddress,
            litePsmAddress,
            slippageBps,
          }),
      } satisfies Erc20ApprovalRequired;

      return makeMultiStepPlan([redeemTx, phase2]);
    },
  );
}

function buildMainnetRedeemSUsdsPhase2(args: {
  readonly chain: ChainMetadata;
  readonly sender: Address;
  readonly receiver: Address;
  readonly usds: Address;
  readonly wrapperAddress: Address;
  readonly usdsAmount: bigint;
  readonly tout: bigint;
  readonly slippageBps: number;
}): Erc20ApprovalRequired {
  const baseGemAmt = usdcFromUsdsViaBuyGem(args.usdsAmount, args.tout);
  const gemAmt = applySlippage(baseGemAmt, args.slippageBps);

  const buyGemData = encodeFunctionData({
    abi: usdsPsmWrapperAbi,
    functionName: 'buyGem',
    args: [args.receiver, gemAmt],
  });
  const buyGemTx = makeTransactionRequest({
    chainId: args.chain.chainId,
    from: args.sender,
    to: args.wrapperAddress,
    data: buyGemData,
    operation: 'REDEEM_USDS_FOR_USDC',
  });

  return makeSingleApprovalPlan({
    chainId: args.chain.chainId,
    from: args.sender,
    token: args.usds,
    spender: args.wrapperAddress,
    amount: args.usdsAmount,
    mainTransaction: buyGemTx,
  });
}

function refreshMainnetRedeemSUsdsPhase2(
  client: OseroClient,
  chain: ChainMetadata,
  args: {
    readonly redeemTxHash?: `0x${string}`;
    readonly shares: bigint;
    readonly sender: Address;
    readonly receiver: Address;
    readonly usds: Address;
    readonly susds: Address;
    readonly wrapperAddress: Address;
    readonly litePsmAddress: Address;
    readonly slippageBps: number;
  },
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const redeemTxHash = args.redeemTxHash;
  if (!redeemTxHash) {
    return errAsync(
      UnexpectedError.from(
        new Error('Cannot refresh mainnet redeemSUsds phase 2 without a redeem transaction hash'),
      ),
    );
  }

  return readConfirmedMainnetRedeemSUsdsPhase2Inputs(client, chain, {
    redeemTxHash,
    shares: args.shares,
    sender: args.sender,
    susds: args.susds,
    litePsmAddress: args.litePsmAddress,
  }).map(({ usdsOut, tout }) =>
    buildMainnetRedeemSUsdsPhase2({
      chain,
      sender: args.sender,
      receiver: args.receiver,
      usds: args.usds,
      wrapperAddress: args.wrapperAddress,
      usdsAmount: usdsOut,
      tout,
      slippageBps: args.slippageBps,
    }),
  );
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: RedeemSUsdsRequest,
  receiver: Address,
  referralCode: bigint,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;

  return quoteL2RedeemSUsds(client, chain, request.amount).map((quote): Erc20ApprovalRequired => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [susds.address, usdc.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'REDEEM_SUSDS_FOR_USDC',
    });

    return makeSingleApprovalPlan({
      chainId: chain.chainId,
      from: request.sender,
      token: susds.address,
      spender: psmAddress,
      amount: request.amount,
      mainTransaction,
    });
  });
}

function quoteMainnetRedeemSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  return readMainnetRedeemSUsdsQuoteInputs(client, chain, amount).map(({ usdsOut, tout }) =>
    usdcFromUsdsViaBuyGem(usdsOut, tout),
  );
}

function readMainnetRedeemSUsdsQuoteInputs(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
  litePsmAddress = PSM_ADDRESSES[chain.chainId].litePsm,
): ResultAsync<{ readonly usdsOut: bigint; readonly tout: bigint }, UnexpectedError> {
  const susds = getToken(chain.chainId, 'sUSDS');

  if (!litePsmAddress) {
    return errAsync(
      UnexpectedError.from(
        new Error('Mainnet PSM_ADDRESSES entry is missing `litePsm`. This is a bug in the SDK.'),
      ),
    );
  }

  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.combine([
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: susds.address,
        abi: erc4626Abi,
        functionName: 'previewRedeem',
        args: [amount],
      }),
      (err) => UnexpectedError.from(err),
    ),
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: litePsmAddress,
        abi: litePsmAbi,
        functionName: 'tout',
      }),
      (err) => UnexpectedError.from(err),
    ),
  ]).map(([usdsOut, tout]) => ({ usdsOut, tout }));
}

function readConfirmedMainnetRedeemSUsdsPhase2Inputs(
  client: OseroClient,
  chain: ChainMetadata,
  args: {
    readonly redeemTxHash: `0x${string}`;
    readonly shares: bigint;
    readonly sender: Address;
    readonly susds: Address;
    readonly litePsmAddress: Address;
  },
): ResultAsync<{ readonly usdsOut: bigint; readonly tout: bigint }, UnexpectedError> {
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.combine([
    ResultAsync.fromPromise(
      publicClient.getTransactionReceipt({ hash: args.redeemTxHash }),
      (err) => UnexpectedError.from(err),
    ).andThen((receipt) => readUsdsRedeemedFromReceipt(receipt, args)),
    ResultAsync.fromPromise(
      publicClient.readContract({
        address: args.litePsmAddress,
        abi: litePsmAbi,
        functionName: 'tout',
      }),
      (err) => UnexpectedError.from(err),
    ),
  ]).map(([usdsOut, tout]) => ({ usdsOut, tout }));
}

function readUsdsRedeemedFromReceipt(
  receipt: TransactionReceipt,
  args: {
    readonly shares: bigint;
    readonly sender: Address;
    readonly susds: Address;
  },
): ResultAsync<bigint, UnexpectedError> {
  const logs = receipt.logs.filter((log) => isAddressEqual(log.address, args.susds));
  const withdrawLogs = parseEventLogs({
    abi: erc4626Abi,
    eventName: 'Withdraw',
    logs,
  });
  const matchingLog = withdrawLogs.find(
    (log) =>
      isAddressEqual(log.args.sender, args.sender) &&
      isAddressEqual(log.args.receiver, args.sender) &&
      isAddressEqual(log.args.owner, args.sender) &&
      log.args.shares === args.shares,
  );

  if (!matchingLog) {
    return errAsync(
      UnexpectedError.from(
        new Error(
          'Could not find the sUSDS Withdraw event needed to refresh mainnet redeemSUsds phase 2',
        ),
      ),
    );
  }

  return okAsync(matchingLog.args.assets);
}

function quoteL2RedeemSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const usdc = getToken(chain.chainId, 'USDC');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: psmAddress,
      abi: psm3Abi,
      functionName: 'previewSwapExactIn',
      args: [susds.address, usdc.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
