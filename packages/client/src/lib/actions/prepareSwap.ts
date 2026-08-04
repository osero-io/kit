import { encodeFunctionData, type Address, type Hex } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { prepareAllowance } from '../allowance.js';
import { CHAIN_CAPABILITIES, type OseroChainId, type TokenSymbol } from '../capabilities.js';
import {
  referral as createReferral,
  type ApprovalPolicy,
  type Referral,
  type Slippage,
  type TokenAmount,
} from '../domain.js';
import {
  RpcError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
  type ConfigurationError,
  type InsufficientAllowanceError,
} from '../errors.js';
import type { OseroClient } from '../OseroClient.js';
import { createExecutionPlan, createTransactionRequest } from '../plan.js';
import { referralCodeForRoute, resolveReferral } from '../referrals.js';
import { err, errAsync, ok, ResultAsync, type Result } from '../result.js';
import type {
  ExecutionPlan,
  PreparedExactInSwapQuote,
  PreparedExactOutSwapQuote,
  PreparedSwapQuote,
  TransactionRequest,
} from '../types.js';
import { validateAddress } from '../validation.js';
import {
  evaluateSwapQuote,
  resolveSwapQuoteRequest,
  type ResolvedSwapQuoteRequest,
  type SwapQuoteEvaluation,
} from './quoteSwap.js';

export type PrepareSwapBaseRequest = {
  readonly chainId: OseroChainId;
  readonly account: Address;
  readonly receiver?: Address;
  readonly slippage?: Slippage;
  readonly referral?: Referral;
  readonly approvalPolicy?: ApprovalPolicy;
  /** Required for routes whose deployed contracts cannot enforce a slippage bound. */
  readonly allowUnprotectedSlippage?: boolean;
};

export type ExactInSwapRequest<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = PrepareSwapBaseRequest & {
  readonly mode: 'exact-in';
  readonly amountIn: TokenAmount<AssetIn>;
  readonly assetOut: AssetOut;
};

export type ExactOutSwapRequest<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = PrepareSwapBaseRequest & {
  readonly mode: 'exact-out';
  readonly assetIn: AssetIn;
  readonly amountOut: TokenAmount<AssetOut>;
};

export type PrepareSwapRequest = ExactInSwapRequest | ExactOutSwapRequest;

export type PrepareSwapError =
  | ValidationError
  | UnsupportedChainError
  | ConfigurationError
  | RpcError
  | InsufficientAllowanceError
  | UnexpectedError;

export function prepareSwap<AssetIn extends TokenSymbol, AssetOut extends TokenSymbol>(
  client: OseroClient,
  request: ExactInSwapRequest<AssetIn, AssetOut>,
): ResultAsync<PreparedExactInSwapQuote<AssetIn, AssetOut>, PrepareSwapError>;
export function prepareSwap<AssetIn extends TokenSymbol, AssetOut extends TokenSymbol>(
  client: OseroClient,
  request: ExactOutSwapRequest<AssetIn, AssetOut>,
): ResultAsync<PreparedExactOutSwapQuote<AssetIn, AssetOut>, PrepareSwapError>;
export function prepareSwap(
  client: OseroClient,
  request: PrepareSwapRequest,
): ResultAsync<PreparedSwapQuote, PrepareSwapError>;
export function prepareSwap(
  client: OseroClient,
  request: PrepareSwapRequest,
): ResultAsync<PreparedSwapQuote, PrepareSwapError> {
  const resolved = validateRequest(client, request);
  if (resolved.isErr()) return errAsync(resolved.error);
  const publicClient = client.getPublicClient(resolved.value.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);

  const preparation = async (): Promise<Result<PreparedSwapQuote, PrepareSwapError>> => {
    const block = await ResultAsync.fromPromise(publicClient.value.getBlockNumber(), (cause) =>
      RpcError.from({
        cause,
        operation: 'getBlockNumber',
        chainId: resolved.value.chainId,
      }),
    );
    if (block.isErr()) return err(block.error);

    const evaluation = await evaluateSwapQuote(publicClient.value, resolved.value, block.value);
    if (evaluation.isErr()) return err(evaluation.error);

    if (resolved.value.protocol === 'psm3') {
      return preparePsm3Swap(client, resolved.value, block.value, evaluation.value);
    }
    return prepareEthereumSwap(client, resolved.value, block.value, evaluation.value);
  };

  return new ResultAsync(preparation());
}

type ResolvedRequest = ResolvedSwapQuoteRequest & {
  readonly account: Address;
  readonly receiver: Address;
  readonly referral: Referral;
  readonly referralCode: bigint;
  readonly approvalPolicy: ApprovalPolicy;
};

function validateRequest(
  client: OseroClient,
  request: PrepareSwapRequest,
): Result<ResolvedRequest, ValidationError | UnsupportedChainError> {
  const quoted = resolveSwapQuoteRequest(client, request);
  if (quoted.isErr()) return err(quoted.error);

  const account = validateAddress(request.account, 'account');
  if (account.isErr()) return err(account.error);
  const receiver = validateAddress(request.receiver ?? request.account, 'receiver');
  if (receiver.isErr()) return err(receiver.error);

  const configuredReferral = resolveReferral(request, client.defaults.referral);
  if (configuredReferral !== false) {
    const validatedReferral = createReferral(configuredReferral.code);
    if (validatedReferral.isErr()) return err(validatedReferral.error);
  }
  const referralCapability =
    request.mode === 'exact-in'
      ? quoted.value.route.exactInReferral
      : quoted.value.route.exactOutReferral;
  const referralCode = referralCodeForRoute(configuredReferral, referralCapability);
  if (referralCode.isErr()) return err(referralCode.error);

  const approvalPolicy = request.approvalPolicy ?? 'exact';
  if (approvalPolicy !== 'exact' && approvalPolicy !== 'max' && approvalPolicy !== 'none') {
    return err(
      ValidationError.forField('approvalPolicy', 'approvalPolicy must be exact, max, or none'),
    );
  }

  if (quoted.value.slippageEnforcedBy === 'none' && request.allowUnprotectedSlippage !== true) {
    return err(
      ValidationError.forField(
        'allowUnprotectedSlippage',
        'this deployed route cannot enforce its quoted slippage bound; explicitly opt in to prepare it',
      ),
    );
  }

  return ok({
    ...quoted.value,
    account: account.value,
    receiver: receiver.value,
    referral: configuredReferral,
    referralCode: referralCode.value,
    approvalPolicy,
  });
}

function encoded(factory: () => Hex): Result<Hex, UnexpectedError> {
  try {
    return ok(factory());
  } catch (cause) {
    return err(UnexpectedError.from(cause));
  }
}

function localPlan(
  steps: readonly TransactionRequest[],
  snapshots: readonly NonNullable<ExecutionPlan['metadata']['allowanceSnapshots']>[number][],
): Result<ExecutionPlan, ValidationError> {
  return createExecutionPlan({
    steps,
    metadata: {
      source: 'local',
      allowanceSnapshots: snapshots,
    },
  });
}

async function preparePsm3Swap(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[request.chainId];
  const tokenIn = capability.tokens[request.assetIn];
  const tokenOut = capability.tokens[request.assetOut];
  const psm = capability.contracts.psm;
  const quote = evaluation.quote;
  const requiredInput = quote.mode === 'exact-in' ? quote.amountIn.raw : quote.maximumAmountIn.raw;
  const boundedOutput =
    quote.mode === 'exact-in' ? quote.minimumAmountOut.raw : quote.amountOut.raw;
  const call = encoded(() =>
    quote.mode === 'exact-in'
      ? encodeFunctionData({
          abi: psm3Abi,
          functionName: 'swapExactIn',
          args: [
            tokenIn.address,
            tokenOut.address,
            request.amount,
            boundedOutput,
            request.receiver,
            request.referralCode,
          ],
        })
      : encodeFunctionData({
          abi: psm3Abi,
          functionName: 'swapExactOut',
          args: [
            tokenIn.address,
            tokenOut.address,
            request.amount,
            requiredInput,
            request.receiver,
            request.referralCode,
          ],
        }),
  );
  if (call.isErr()) return err(call.error);

  const main = createTransactionRequest({
    id: 'swap',
    chainId: request.chainId,
    from: request.account,
    to: psm,
    data: call.value,
    operation: quote.mode === 'exact-in' ? 'SWAP_EXACT_IN' : 'SWAP_EXACT_OUT',
  });
  if (main.isErr()) return err(main.error);

  const allowance = await prepareAllowance(client, {
    stepId: `approve-${request.assetIn.toLowerCase()}`,
    chainId: request.chainId,
    token: tokenIn.address,
    owner: request.account,
    spender: psm,
    requiredAmount: requiredInput,
    policy: request.approvalPolicy,
    blockNumber,
  });
  if (allowance.isErr()) return err(allowance.error);
  const steps = allowance.value.approval ? [allowance.value.approval, main.value] : [main.value];
  const plan = localPlan(steps, [allowance.value.snapshot]);
  if (plan.isErr()) return err(plan.error);

  return ok(withExecutionPlan(quote, plan.value));
}

async function prepareEthereumSwap(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const key = `${request.mode}:${request.assetIn}:${request.assetOut}`;
  switch (key) {
    case 'exact-in:USDC:USDS':
      return prepareMainnetUsdcToUsds(client, request, blockNumber, evaluation);
    case 'exact-in:USDC:sUSDS':
      return prepareMainnetUsdcToSUsds(client, request, blockNumber, evaluation);
    case 'exact-in:USDS:sUSDS':
      return prepareMainnetUsdsToSUsds(client, request, blockNumber, evaluation);
    case 'exact-out:USDS:sUSDS':
      return prepareMainnetUsdsToSUsdsExactOut(client, request, blockNumber, evaluation);
    case 'exact-in:sUSDS:USDS':
      return prepareMainnetSUsdsToUsds(request, evaluation);
    case 'exact-out:sUSDS:USDS':
      return prepareMainnetSUsdsToUsdsExactOut(request, evaluation);
    case 'exact-out:USDS:USDC':
      return prepareMainnetUsdsToUsdcExactOut(client, request, blockNumber, evaluation);
    case 'exact-in:sUSDS:USDC':
      return prepareMainnetSUsdsToUsdc(client, request, blockNumber, evaluation);
    default:
      return err(UnexpectedError.from(new Error(`Unhandled verified mainnet route ${key}`)));
  }
}

async function prepareMainnetUsdcToUsds(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDC } = capability.tokens;
  const { psm } = capability.contracts;
  const data = encoded(() =>
    encodeFunctionData({
      abi: usdsPsmWrapperAbi,
      functionName: 'sellGem',
      args: [request.receiver, request.amount],
    }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'mint-usds',
    chainId: 1,
    from: request.account,
    to: psm,
    data: data.value,
    operation: 'MINT_USDS',
  });
  if (main.isErr()) return err(main.error);
  const allowance = await prepareAllowance(client, {
    stepId: 'approve-usdc',
    chainId: 1,
    token: USDC.address,
    owner: request.account,
    spender: psm,
    requiredAmount: request.amount,
    policy: request.approvalPolicy,
    blockNumber,
  });
  if (allowance.isErr()) return err(allowance.error);
  const plan = localPlan(
    allowance.value.approval ? [allowance.value.approval, main.value] : [main.value],
    [allowance.value.snapshot],
  );
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(evaluation.quote, plan.value));
}

async function prepareMainnetUsdcToSUsds(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDC, USDS, sUSDS } = capability.tokens;
  const { psm } = capability.contracts;
  const usdsOut = evaluation.intermediateUsdsAmount;
  if (usdsOut === undefined) {
    return err(UnexpectedError.from(new Error('Missing quoted intermediate USDS amount')));
  }
  const sellData = encoded(() =>
    encodeFunctionData({
      abi: usdsPsmWrapperAbi,
      functionName: 'sellGem',
      args: [request.account, request.amount],
    }),
  );
  if (sellData.isErr()) return err(sellData.error);
  const depositData = encoded(() =>
    request.referral === false
      ? encodeFunctionData({
          abi: erc4626Abi,
          functionName: 'deposit',
          args: [usdsOut, request.receiver],
        })
      : encodeFunctionData({
          abi: erc4626Abi,
          functionName: 'deposit',
          args: [usdsOut, request.receiver, Number(request.referralCode)],
        }),
  );
  if (depositData.isErr()) return err(depositData.error);
  const mint = createTransactionRequest({
    id: 'mint-usds',
    chainId: 1,
    from: request.account,
    to: psm,
    data: sellData.value,
    operation: 'MINT_USDS',
  });
  if (mint.isErr()) return err(mint.error);
  const deposit = createTransactionRequest({
    id: 'deposit-susds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: depositData.value,
    operation: 'DEPOSIT_USDS_FOR_SUSDS',
  });
  if (deposit.isErr()) return err(deposit.error);

  const [usdcAllowance, usdsAllowance] = await Promise.all([
    prepareAllowance(client, {
      stepId: 'approve-usdc',
      chainId: 1,
      token: USDC.address,
      owner: request.account,
      spender: psm,
      requiredAmount: request.amount,
      policy: request.approvalPolicy,
      blockNumber,
    }),
    prepareAllowance(client, {
      stepId: 'approve-usds',
      chainId: 1,
      token: USDS.address,
      owner: request.account,
      spender: sUSDS.address,
      requiredAmount: usdsOut,
      policy: request.approvalPolicy,
      blockNumber,
    }),
  ]);
  if (usdcAllowance.isErr()) return err(usdcAllowance.error);
  if (usdsAllowance.isErr()) return err(usdsAllowance.error);
  const steps = [
    ...(usdcAllowance.value.approval ? [usdcAllowance.value.approval] : []),
    mint.value,
    ...(usdsAllowance.value.approval ? [usdsAllowance.value.approval] : []),
    deposit.value,
  ];
  const plan = localPlan(steps, [usdcAllowance.value.snapshot, usdsAllowance.value.snapshot]);
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(evaluation.quote, plan.value));
}

async function prepareMainnetUsdsToSUsds(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const data = encoded(() =>
    request.referral === false
      ? encodeFunctionData({
          abi: erc4626Abi,
          functionName: 'deposit',
          args: [request.amount, request.receiver],
        })
      : encodeFunctionData({
          abi: erc4626Abi,
          functionName: 'deposit',
          args: [request.amount, request.receiver, Number(request.referralCode)],
        }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'deposit-susds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: data.value,
    operation: 'DEPOSIT_USDS_FOR_SUSDS',
  });
  if (main.isErr()) return err(main.error);
  const allowance = await prepareAllowance(client, {
    stepId: 'approve-usds',
    chainId: 1,
    token: USDS.address,
    owner: request.account,
    spender: sUSDS.address,
    requiredAmount: request.amount,
    policy: request.approvalPolicy,
    blockNumber,
  });
  if (allowance.isErr()) return err(allowance.error);
  const plan = localPlan(
    allowance.value.approval ? [allowance.value.approval, main.value] : [main.value],
    [allowance.value.snapshot],
  );
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(evaluation.quote, plan.value));
}

async function prepareMainnetUsdsToSUsdsExactOut(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const quote = evaluation.quote;
  if (quote.mode !== 'exact-out') {
    return err(UnexpectedError.from(new Error('Expected an exact-output quote')));
  }
  const data = encoded(() =>
    encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'mint',
      args: [request.amount, request.receiver],
    }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'mint-susds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: data.value,
    operation: 'MINT_SUSDS_WITH_USDS',
  });
  if (main.isErr()) return err(main.error);
  const allowance = await prepareAllowance(client, {
    stepId: 'approve-usds',
    chainId: 1,
    token: USDS.address,
    owner: request.account,
    spender: sUSDS.address,
    requiredAmount: quote.maximumAmountIn.raw,
    policy: request.approvalPolicy,
    blockNumber,
    enforceSpendingCap: true,
  });
  if (allowance.isErr()) return err(allowance.error);
  const plan = localPlan(
    allowance.value.approval ? [allowance.value.approval, main.value] : [main.value],
    [allowance.value.snapshot],
  );
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(quote, plan.value));
}

async function prepareMainnetSUsdsToUsds(
  request: ResolvedRequest,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const data = encoded(() =>
    encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'redeem',
      args: [request.amount, request.receiver, request.account],
    }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'redeem-susds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: data.value,
    operation: 'REDEEM_SUSDS_FOR_USDS',
  });
  if (main.isErr()) return err(main.error);
  const plan = localPlan([main.value], []);
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(evaluation.quote, plan.value));
}

async function prepareMainnetSUsdsToUsdsExactOut(
  request: ResolvedRequest,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const data = encoded(() =>
    encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'withdraw',
      args: [request.amount, request.receiver, request.account],
    }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'withdraw-usds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: data.value,
    operation: 'WITHDRAW_USDS_FROM_SUSDS',
  });
  if (main.isErr()) return err(main.error);
  const plan = localPlan([main.value], []);
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(evaluation.quote, plan.value));
}

async function prepareMainnetUsdsToUsdcExactOut(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS } = capability.tokens;
  const { psm } = capability.contracts;
  const quote = evaluation.quote;
  if (quote.mode !== 'exact-out') {
    return err(UnexpectedError.from(new Error('Expected an exact-output quote')));
  }
  const data = encoded(() =>
    encodeFunctionData({
      abi: usdsPsmWrapperAbi,
      functionName: 'buyGem',
      args: [request.receiver, request.amount],
    }),
  );
  if (data.isErr()) return err(data.error);
  const main = createTransactionRequest({
    id: 'redeem-usds',
    chainId: 1,
    from: request.account,
    to: psm,
    data: data.value,
    operation: 'REDEEM_USDS_FOR_USDC',
  });
  if (main.isErr()) return err(main.error);
  const allowance = await prepareAllowance(client, {
    stepId: 'approve-usds',
    chainId: 1,
    token: USDS.address,
    owner: request.account,
    spender: psm,
    requiredAmount: quote.maximumAmountIn.raw,
    policy: request.approvalPolicy,
    blockNumber,
    enforceSpendingCap: true,
  });
  if (allowance.isErr()) return err(allowance.error);
  const plan = localPlan(
    allowance.value.approval ? [allowance.value.approval, main.value] : [main.value],
    [allowance.value.snapshot],
  );
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(quote, plan.value));
}

async function prepareMainnetSUsdsToUsdc(
  client: OseroClient,
  request: ResolvedRequest,
  blockNumber: bigint,
  evaluation: SwapQuoteEvaluation,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const { psm } = capability.contracts;
  const quote = evaluation.quote;
  if (quote.mode !== 'exact-in') {
    return err(UnexpectedError.from(new Error('Expected an exact-input quote')));
  }
  const usdsOut = evaluation.intermediateUsdsAmount;
  if (usdsOut === undefined) {
    return err(UnexpectedError.from(new Error('Missing quoted intermediate USDS amount')));
  }
  const redeemData = encoded(() =>
    encodeFunctionData({
      abi: erc4626Abi,
      functionName: 'redeem',
      args: [request.amount, request.account, request.account],
    }),
  );
  if (redeemData.isErr()) return err(redeemData.error);
  const buyData = encoded(() =>
    encodeFunctionData({
      abi: usdsPsmWrapperAbi,
      functionName: 'buyGem',
      args: [request.receiver, quote.minimumAmountOut.raw],
    }),
  );
  if (buyData.isErr()) return err(buyData.error);
  const redeem = createTransactionRequest({
    id: 'redeem-susds',
    chainId: 1,
    from: request.account,
    to: sUSDS.address,
    data: redeemData.value,
    operation: 'REDEEM_SUSDS_FOR_USDS',
  });
  if (redeem.isErr()) return err(redeem.error);
  const buy = createTransactionRequest({
    id: 'redeem-usds',
    chainId: 1,
    from: request.account,
    to: psm,
    data: buyData.value,
    operation: 'REDEEM_USDS_FOR_USDC',
  });
  if (buy.isErr()) return err(buy.error);
  const allowance = await prepareAllowance(client, {
    stepId: 'approve-usds',
    chainId: 1,
    token: USDS.address,
    owner: request.account,
    spender: psm,
    requiredAmount: usdsOut,
    policy: request.approvalPolicy,
    blockNumber,
    enforceSpendingCap: true,
  });
  if (allowance.isErr()) return err(allowance.error);
  const plan = localPlan(
    [redeem.value, ...(allowance.value.approval ? [allowance.value.approval] : []), buy.value],
    [allowance.value.snapshot],
  );
  if (plan.isErr()) return err(plan.error);
  return ok(withExecutionPlan(quote, plan.value));
}

function withExecutionPlan(
  quote: SwapQuoteEvaluation['quote'],
  plan: ExecutionPlan,
): PreparedSwapQuote {
  const route = {
    ...quote.route,
    steps: plan.steps.map((step) => step.operation),
  };
  if (quote.mode === 'exact-in') {
    return { ...quote, route, plan };
  }
  return { ...quote, route, plan };
}
