import { type Address, encodeFunctionData } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { type ChainMetadata, getChain } from '../chains.js';
import { UnexpectedError, UnsupportedChainError, ValidationError } from '../errors.js';
import { applySlippage } from '../math.js';
import type { OseroClient } from '../OseroClient.js';
import { makeSingleApprovalPlan, makeTransactionRequest } from '../plan.js';
import { resolveReferralCode, validateReferralCode } from '../referrals.js';
import { errAsync, okAsync, ResultAsync } from '../result.js';
import { getToken } from '../tokens.js';
import type { Erc20ApprovalRequired } from '../types.js';

/**
 * Parameters accepted by {@link depositSUsds}.
 */
export type DepositSUsdsRequest = {
  /**
   * The chain on which the deposit should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDS to deposit, in USDS's native 18 decimals (use
   * `parseUnits(amount, 18)` from viem).
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;

  /**
   * The wallet that owns the USDS. Used as the `from` address on
   * every transaction in the returned plan.
   */
  readonly sender: Address;

  /**
   * The address that receives the resulting sUSDS shares. Defaults
   * to {@link sender}.
   */
  readonly receiver?: Address;

  /**
   * Slippage tolerance (basis points) applied to the PSM3
   * `previewSwapExactIn` quote on L2s. Ignored on Ethereum mainnet
   * because ERC-4626 `deposit` is deterministic at execution time.
   *
   * @defaultValue {@link ClientConfig.defaultSlippageBps} (5 bps)
   */
  readonly slippageBps?: number;

  /**
   * Opaque referral code used for off-chain attribution.
   *
   * On L2s it is forwarded to the PSM3 `Swap` event. On Ethereum
   * mainnet it is forwarded to the sUSDS `deposit` referral overload.
   *
   * @defaultValue {@link ClientConfig.defaultReferralCode} ({@link DEFAULT_REFERRAL_CODE} = 3000n by default). Pass `undefined` to opt out for this call.
   */
  readonly referralCode?: bigint;
};

/**
 * Parameters accepted by {@link previewDepositSUsds}.
 */
export type PreviewDepositSUsdsRequest = {
  /**
   * The chain on which the preview should happen. Must be one of the
   * supported chains ({@link SUPPORTED_CHAIN_IDS}).
   */
  readonly chainId: number;

  /**
   * Amount of USDS to deposit, in USDS's native 18 decimals.
   *
   * Must be strictly greater than zero.
   */
  readonly amount: bigint;
};

export type DepositSUsdsError = ValidationError | UnsupportedChainError | UnexpectedError;

/**
 * Preview how much sUSDS an exact-in {@link depositSUsds} flow would
 * return for the given USDS amount.
 */
export function previewDepositSUsds(
  client: OseroClient,
  request: PreviewDepositSUsdsRequest,
): ResultAsync<bigint, DepositSUsdsError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }
  if (request.amount <= 0n) {
    return errAsync(ValidationError.forField('amount', 'amount must be greater than 0'));
  }

  if (chain.isMainnet) {
    return quoteMainnetDepositSUsds(client, chain, request.amount);
  }

  return quoteL2DepositSUsds(client, chain, request.amount);
}

/**
 * Build an {@link ExecutionPlan} that deposits existing USDS into
 * sUSDS. This is useful when a prior mainnet {@link mintSUsds}
 * execution completed the USDC -> USDS step but stopped before the
 * final sUSDS deposit. If a prior {@link redeemSUsds} execution left
 * the wallet holding USDS, use {@link redeemUsds} to continue from
 * USDS to USDC.
 *
 * ### Mainnet path
 *
 * Uses the canonical ERC-4626 sUSDS vault:
 *
 * 1. `USDS.approve(sUSDS, amount)`
 * 2. `sUSDS.deposit(amount, receiver, referralCode)`
 *
 * ### L2 path
 *
 * Uses a single approval-then-swap through Spark's PSM3:
 *
 * 1. `USDS.approve(PSM3, amount)`
 * 2. `PSM3.swapExactIn(USDS, sUSDS, amount, minShares, receiver, 0)`
 *
 * ```ts
 * import { depositSUsds } from '@osero/client/actions';
 * import { sendWith } from '@osero/client/viem';
 * import { parseUnits } from 'viem';
 *
 * const result = await depositSUsds(client, {
 *   chainId: 1,
 *   amount: parseUnits('1000', 18),
 *   sender: wallet.account.address,
 * }).andThen(sendWith(wallet));
 * ```
 */
export function depositSUsds(
  client: OseroClient,
  request: DepositSUsdsRequest,
): ResultAsync<Erc20ApprovalRequired, DepositSUsdsError> {
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

  if (chain.isMainnet && resolvedReferralCode !== undefined && resolvedReferralCode > 65_535n) {
    return errAsync(
      ValidationError.forField('referralCode', 'referralCode is out of range for Ethereum mainnet'),
    );
  }

  const receiver = request.receiver ?? request.sender;

  if (chain.isMainnet) {
    return okAsync(buildMainnetPlan(chain, request, receiver, resolvedReferralCode));
  }

  return buildL2Plan(client, chain, request, receiver, resolvedReferralCode ?? 0n);
}

function buildMainnetPlan(
  chain: ChainMetadata,
  request: DepositSUsdsRequest,
  receiver: Address,
  resolvedReferralCode: bigint | undefined,
): Erc20ApprovalRequired {
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
  const referralCode =
    resolvedReferralCode === undefined ? undefined : Number(resolvedReferralCode);

  const depositData = encodeFunctionData({
    abi: erc4626Abi,
    functionName: 'deposit',
    args:
      referralCode === undefined
        ? [request.amount, receiver]
        : [request.amount, receiver, referralCode],
  });

  const mainTransaction = makeTransactionRequest({
    chainId: chain.chainId,
    from: request.sender,
    to: susds.address,
    data: depositData,
    operation: 'DEPOSIT_USDS_FOR_SUSDS',
  });

  return makeSingleApprovalPlan({
    chainId: chain.chainId,
    from: request.sender,
    token: usds.address,
    spender: susds.address,
    amount: request.amount,
    mainTransaction,
  });
}

function buildL2Plan(
  client: OseroClient,
  chain: ChainMetadata,
  request: DepositSUsdsRequest,
  receiver: Address,
  referralCode: bigint,
): ResultAsync<Erc20ApprovalRequired, UnexpectedError> {
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const slippageBps = request.slippageBps ?? client.config.defaultSlippageBps;

  return quoteL2DepositSUsds(client, chain, request.amount).map((quote): Erc20ApprovalRequired => {
    const minAmountOut = applySlippage(quote, slippageBps);

    const swapData = encodeFunctionData({
      abi: psm3Abi,
      functionName: 'swapExactIn',
      args: [usds.address, susds.address, request.amount, minAmountOut, receiver, referralCode],
    });

    const mainTransaction = makeTransactionRequest({
      chainId: chain.chainId,
      from: request.sender,
      to: psmAddress,
      data: swapData,
      operation: 'DEPOSIT_USDS_FOR_SUSDS',
    });

    return makeSingleApprovalPlan({
      chainId: chain.chainId,
      from: request.sender,
      token: usds.address,
      spender: psmAddress,
      amount: request.amount,
      mainTransaction,
    });
  });
}

function quoteMainnetDepositSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const susds = getToken(chain.chainId, 'sUSDS');
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: susds.address,
      abi: erc4626Abi,
      functionName: 'previewDeposit',
      args: [amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}

function quoteL2DepositSUsds(
  client: OseroClient,
  chain: ChainMetadata,
  amount: bigint,
): ResultAsync<bigint, UnexpectedError> {
  const usds = getToken(chain.chainId, 'USDS');
  const susds = getToken(chain.chainId, 'sUSDS');
  const psmAddress = PSM_ADDRESSES[chain.chainId].psm;
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: psmAddress,
      abi: psm3Abi,
      functionName: 'previewSwapExactIn',
      args: [usds.address, susds.address, amount],
    }),
    (err) => UnexpectedError.from(err),
  );
}
