import { encodeFunctionData, type Address, type Hex } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import { usdsPsmWrapperAbi } from '../abis/usdsPsmWrapper.js';
import { prepareAllowance } from '../allowance.js';
import {
  CHAIN_CAPABILITIES,
  type OseroChainId,
  type RouteCapability,
  type TokenSymbol,
} from '../capabilities.js';
import {
  parseSlippage,
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
import {
  applySlippageDown,
  applySlippageUp,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  usdsNeededForUsdcViaBuyGem,
} from '../math.js';
import type { OseroClient, OseroPublicClient } from '../OseroClient.js';
import { createExecutionPlan, createTransactionRequest } from '../plan.js';
import { referralCodeForRoute, resolveReferral } from '../referrals.js';
import { err, errAsync, ok, ResultAsync, type Result } from '../result.js';
import { isTokenSymbol } from '../tokens.js';
import type {
  ExecutionPlan,
  PreparedExactInSwapQuote,
  PreparedExactOutSwapQuote,
  PreparedSwapQuote,
  TransactionRequest,
} from '../types.js';
import { validateAddress, validatePositiveUint256 } from '../validation.js';

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
    const block = await rpc(
      publicClient.value.getBlockNumber(),
      'getBlockNumber',
      resolved.value.chainId,
    );
    if (block.isErr()) return err(block.error);

    if (resolved.value.protocol === 'psm3') {
      return preparePsm3Swap(client, publicClient.value, resolved.value, block.value);
    }
    return prepareEthereumSwap(client, publicClient.value, resolved.value, block.value);
  };

  return new ResultAsync(preparation());
}

type ResolvedRequest = {
  readonly chainId: OseroChainId;
  readonly protocol: 'ethereum-lite-psm' | 'psm3';
  readonly account: Address;
  readonly receiver: Address;
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  readonly mode: 'exact-in' | 'exact-out';
  readonly amount: bigint;
  readonly slippage: Slippage;
  readonly referral: Referral;
  readonly referralCode: bigint;
  readonly approvalPolicy: ApprovalPolicy;
  readonly route: RouteCapability;
};

function validateRequest(
  client: OseroClient,
  request: PrepareSwapRequest,
): Result<ResolvedRequest, ValidationError | UnsupportedChainError> {
  if (typeof request !== 'object' || request === null) {
    return err(ValidationError.forField('request', 'request must be an object'));
  }
  if (!Number.isSafeInteger(request.chainId) || !(request.chainId in CHAIN_CAPABILITIES)) {
    return err(new UnsupportedChainError(request.chainId));
  }
  const chainId = request.chainId as OseroChainId;
  const capability = CHAIN_CAPABILITIES[chainId];
  const account = validateAddress(request.account, 'account');
  if (account.isErr()) return err(account.error);
  const receiver = validateAddress(request.receiver ?? request.account, 'receiver');
  if (receiver.isErr()) return err(receiver.error);

  let assetIn: unknown;
  let assetOut: unknown;
  let amountValue: unknown;
  if (request.mode === 'exact-in') {
    if (typeof request.amountIn !== 'object' || request.amountIn === null) {
      return err(ValidationError.forField('amountIn', 'amountIn must be a token amount'));
    }
    assetIn = request.amountIn.symbol;
    assetOut = request.assetOut;
    amountValue = request.amountIn.raw;
  } else if (request.mode === 'exact-out') {
    if (typeof request.amountOut !== 'object' || request.amountOut === null) {
      return err(ValidationError.forField('amountOut', 'amountOut must be a token amount'));
    }
    assetIn = request.assetIn;
    assetOut = request.amountOut.symbol;
    amountValue = request.amountOut.raw;
  } else {
    return err(ValidationError.forField('mode', 'mode must be exact-in or exact-out'));
  }

  if (typeof assetIn !== 'string' || !isTokenSymbol(assetIn)) {
    return err(ValidationError.forField('assetIn', 'assetIn must be USDC, USDS, or sUSDS'));
  }
  if (typeof assetOut !== 'string' || !isTokenSymbol(assetOut)) {
    return err(ValidationError.forField('assetOut', 'assetOut must be USDC, USDS, or sUSDS'));
  }
  if (assetIn === assetOut) {
    return err(ValidationError.forField('assetOut', 'assetIn and assetOut must differ'));
  }
  const amount = validatePositiveUint256(
    amountValue,
    request.mode === 'exact-in' ? 'amountIn.raw' : 'amountOut.raw',
  );
  if (amount.isErr()) return err(amount.error);

  const configuredSlippage = request.slippage ?? client.defaults.slippage;
  if (typeof configuredSlippage !== 'object' || configuredSlippage === null) {
    return err(ValidationError.forField('slippage', 'slippage must be created with parseSlippage'));
  }
  const slippage = parseSlippage(configuredSlippage.bps);
  if (slippage.isErr()) return err(slippage.error);

  const configuredReferral = resolveReferral(request, client.defaults.referral);
  if (configuredReferral !== false) {
    const validatedReferral = createReferral(configuredReferral.code);
    if (validatedReferral.isErr()) return err(validatedReferral.error);
  }

  const route = capability.routes.find(
    (candidate) => candidate.assetIn === assetIn && candidate.assetOut === assetOut,
  );
  if (route === undefined || (request.mode === 'exact-in' ? !route.exactIn : !route.exactOut)) {
    return err(
      ValidationError.forField(
        'route',
        `${request.mode} ${assetIn} to ${assetOut} is not supported on chain ${chainId}`,
      ),
    );
  }
  const referralCapability =
    request.mode === 'exact-in' ? route.exactInReferral : route.exactOutReferral;
  const referralCode = referralCodeForRoute(configuredReferral, referralCapability);
  if (referralCode.isErr()) return err(referralCode.error);

  const approvalPolicy = request.approvalPolicy ?? 'exact';
  if (approvalPolicy !== 'exact' && approvalPolicy !== 'max' && approvalPolicy !== 'none') {
    return err(
      ValidationError.forField('approvalPolicy', 'approvalPolicy must be exact, max, or none'),
    );
  }

  const protection = protectionFor(capability.protocol, request.mode, assetIn, assetOut);
  if (protection === 'none' && request.allowUnprotectedSlippage !== true) {
    return err(
      ValidationError.forField(
        'allowUnprotectedSlippage',
        'this deployed route cannot enforce its quoted slippage bound; explicitly opt in to prepare it',
      ),
    );
  }

  return ok({
    chainId,
    protocol: capability.protocol,
    account: account.value,
    receiver: receiver.value,
    assetIn,
    assetOut,
    mode: request.mode,
    amount: amount.value,
    slippage: slippage.value,
    referral: configuredReferral,
    referralCode: referralCode.value,
    approvalPolicy,
    route,
  });
}

function protectionFor(
  protocol: ResolvedRequest['protocol'],
  mode: ResolvedRequest['mode'],
  assetIn: TokenSymbol,
  assetOut: TokenSymbol,
): 'calldata' | 'allowance' | 'none' {
  if (protocol === 'psm3') return 'calldata';
  if (mode === 'exact-out' && assetIn === 'USDS' && (assetOut === 'USDC' || assetOut === 'sUSDS')) {
    return 'allowance';
  }
  if (mode === 'exact-in' && assetIn === 'sUSDS' && assetOut === 'USDC') {
    return 'calldata';
  }
  return 'none';
}

function rpc<T>(
  promise: Promise<T>,
  operation: string,
  chainId: number,
  contract?: Address,
  functionName?: string,
): ResultAsync<T, RpcError> {
  return ResultAsync.fromPromise(promise, (cause) =>
    RpcError.from({ cause, operation, chainId, contract, functionName }),
  );
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
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[request.chainId];
  const tokenIn = capability.tokens[request.assetIn];
  const tokenOut = capability.tokens[request.assetOut];
  const psm = capability.contracts.psm;
  const quote = await rpc(
    publicClient.readContract({
      address: psm,
      abi: psm3Abi,
      functionName: request.mode === 'exact-in' ? 'previewSwapExactIn' : 'previewSwapExactOut',
      args:
        request.mode === 'exact-in'
          ? [tokenIn.address, tokenOut.address, request.amount]
          : [tokenIn.address, tokenOut.address, request.amount],
      blockNumber,
    }),
    'readContract',
    request.chainId,
    psm,
    request.mode === 'exact-in' ? 'previewSwapExactIn' : 'previewSwapExactOut',
  );
  if (quote.isErr()) return err(quote.error);

  const requiredInput =
    request.mode === 'exact-in' ? request.amount : applySlippageUp(quote.value, request.slippage);
  const boundedOutput =
    request.mode === 'exact-in' ? applySlippageDown(quote.value, request.slippage) : request.amount;
  const call = encoded(() =>
    request.mode === 'exact-in'
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
    operation: request.mode === 'exact-in' ? 'SWAP_EXACT_IN' : 'SWAP_EXACT_OUT',
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

  const common = {
    assetIn: request.assetIn,
    assetOut: request.assetOut,
    slippage: request.slippage,
    route: {
      chainId: request.chainId,
      protocol: capability.protocol,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      mode: request.mode,
      steps: plan.value.steps.map((step) => step.operation),
    },
    slippageProtection: {
      bound: request.mode === 'exact-in' ? ('minimum-output' as const) : ('maximum-input' as const),
      enforcedBy: 'calldata' as const,
    },
    quotedAt: { blockNumber },
    protocolFee: { kind: 'none' as const },
    plan: plan.value,
  };

  if (request.mode === 'exact-in') {
    return ok({
      ...common,
      mode: 'exact-in',
      amountIn: { symbol: request.assetIn, raw: request.amount },
      expectedAmountOut: { symbol: request.assetOut, raw: quote.value },
      minimumAmountOut: { symbol: request.assetOut, raw: boundedOutput },
    });
  }
  return ok({
    ...common,
    mode: 'exact-out',
    amountOut: { symbol: request.assetOut, raw: request.amount },
    expectedAmountIn: { symbol: request.assetIn, raw: quote.value },
    maximumAmountIn: { symbol: request.assetIn, raw: requiredInput },
  });
}

async function prepareEthereumSwap(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedSwapQuote, PrepareSwapError>> {
  const key = `${request.mode}:${request.assetIn}:${request.assetOut}`;
  switch (key) {
    case 'exact-in:USDC:USDS':
      return prepareMainnetUsdcToUsds(client, publicClient, request, blockNumber);
    case 'exact-in:USDC:sUSDS':
      return prepareMainnetUsdcToSUsds(client, publicClient, request, blockNumber);
    case 'exact-in:USDS:sUSDS':
      return prepareMainnetUsdsToSUsds(client, publicClient, request, blockNumber);
    case 'exact-out:USDS:sUSDS':
      return prepareMainnetUsdsToSUsdsExactOut(client, publicClient, request, blockNumber);
    case 'exact-in:sUSDS:USDS':
      return prepareMainnetSUsdsToUsds(publicClient, request, blockNumber);
    case 'exact-out:sUSDS:USDS':
      return prepareMainnetSUsdsToUsdsExactOut(publicClient, request, blockNumber);
    case 'exact-out:USDS:USDC':
      return prepareMainnetUsdsToUsdcExactOut(client, publicClient, request, blockNumber);
    case 'exact-in:sUSDS:USDC':
      return prepareMainnetSUsdsToUsdc(client, publicClient, request, blockNumber);
    default:
      return err(UnexpectedError.from(new Error(`Unhandled verified mainnet route ${key}`)));
  }
}

async function prepareMainnetUsdcToUsds(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactInSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDC } = capability.tokens;
  const { psm, litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tin = await rpc(
    publicClient.readContract({
      address: litePsm,
      abi: litePsmAbi,
      functionName: 'tin',
      blockNumber,
    }),
    'readContract',
    1,
    litePsm,
    'tin',
  );
  if (tin.isErr()) return err(tin.error);
  const expected = usdsFromUsdcViaSellGem(request.amount, tin.value);
  const minimum = applySlippageDown(expected, request.slippage);
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
  return ok(
    exactInQuote(request, plan.value, blockNumber, expected, minimum, {
      kind: 'lite-psm',
      tin: tin.value,
    }),
  );
}

async function prepareMainnetUsdcToSUsds(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactInSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDC, USDS, sUSDS } = capability.tokens;
  const { psm, litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tin = await rpc(
    publicClient.readContract({
      address: litePsm,
      abi: litePsmAbi,
      functionName: 'tin',
      blockNumber,
    }),
    'readContract',
    1,
    litePsm,
    'tin',
  );
  if (tin.isErr()) return err(tin.error);
  const usdsOut = usdsFromUsdcViaSellGem(request.amount, tin.value);
  const shares = await rpc(
    publicClient.readContract({
      address: sUSDS.address,
      abi: erc4626Abi,
      functionName: 'previewDeposit',
      args: [usdsOut],
      blockNumber,
    }),
    'readContract',
    1,
    sUSDS.address,
    'previewDeposit',
  );
  if (shares.isErr()) return err(shares.error);
  const minimum = applySlippageDown(shares.value, request.slippage);
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
  return ok(
    exactInQuote(request, plan.value, blockNumber, shares.value, minimum, {
      kind: 'lite-psm',
      tin: tin.value,
    }),
  );
}

async function prepareMainnetUsdsToSUsds(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactInSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const shares = await rpc(
    publicClient.readContract({
      address: sUSDS.address,
      abi: erc4626Abi,
      functionName: 'previewDeposit',
      args: [request.amount],
      blockNumber,
    }),
    'readContract',
    1,
    sUSDS.address,
    'previewDeposit',
  );
  if (shares.isErr()) return err(shares.error);
  const minimum = applySlippageDown(shares.value, request.slippage);
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
  return ok(exactInQuote(request, plan.value, blockNumber, shares.value, minimum));
}

async function prepareMainnetUsdsToSUsdsExactOut(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactOutSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const assets = await rpc(
    publicClient.readContract({
      address: sUSDS.address,
      abi: erc4626Abi,
      functionName: 'previewMint',
      args: [request.amount],
      blockNumber,
    }),
    'readContract',
    1,
    sUSDS.address,
    'previewMint',
  );
  if (assets.isErr()) return err(assets.error);
  const maximum = applySlippageUp(assets.value, request.slippage);
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
    requiredAmount: maximum,
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
  return ok(exactOutQuote(request, plan.value, blockNumber, assets.value, maximum));
}

async function prepareMainnetSUsdsToUsds(
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactInSwapQuote, PrepareSwapError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const assets = await rpc(
    publicClient.readContract({
      address: sUSDS.address,
      abi: erc4626Abi,
      functionName: 'previewRedeem',
      args: [request.amount],
      blockNumber,
    }),
    'readContract',
    1,
    sUSDS.address,
    'previewRedeem',
  );
  if (assets.isErr()) return err(assets.error);
  const minimum = applySlippageDown(assets.value, request.slippage);
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
  return ok(exactInQuote(request, plan.value, blockNumber, assets.value, minimum));
}

async function prepareMainnetSUsdsToUsdsExactOut(
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactOutSwapQuote, PrepareSwapError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const shares = await rpc(
    publicClient.readContract({
      address: sUSDS.address,
      abi: erc4626Abi,
      functionName: 'previewWithdraw',
      args: [request.amount],
      blockNumber,
    }),
    'readContract',
    1,
    sUSDS.address,
    'previewWithdraw',
  );
  if (shares.isErr()) return err(shares.error);
  const maximum = applySlippageUp(shares.value, request.slippage);
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
  return ok(exactOutQuote(request, plan.value, blockNumber, shares.value, maximum));
}

async function prepareMainnetUsdsToUsdcExactOut(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactOutSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS } = capability.tokens;
  const { psm, litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tout = await rpc(
    publicClient.readContract({
      address: litePsm,
      abi: litePsmAbi,
      functionName: 'tout',
      blockNumber,
    }),
    'readContract',
    1,
    litePsm,
    'tout',
  );
  if (tout.isErr()) return err(tout.error);
  const expected = usdsNeededForUsdcViaBuyGem(request.amount, tout.value);
  const maximum = applySlippageUp(expected, request.slippage);
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
    requiredAmount: maximum,
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
  return ok(
    exactOutQuote(request, plan.value, blockNumber, expected, maximum, {
      kind: 'lite-psm',
      tout: tout.value,
    }),
  );
}

async function prepareMainnetSUsdsToUsdc(
  client: OseroClient,
  publicClient: OseroPublicClient,
  request: ResolvedRequest,
  blockNumber: bigint,
): Promise<Result<PreparedExactInSwapQuote, PrepareSwapError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { USDS, sUSDS } = capability.tokens;
  const { psm, litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const [assets, tout] = await Promise.all([
    rpc(
      publicClient.readContract({
        address: sUSDS.address,
        abi: erc4626Abi,
        functionName: 'previewRedeem',
        args: [request.amount],
        blockNumber,
      }),
      'readContract',
      1,
      sUSDS.address,
      'previewRedeem',
    ),
    rpc(
      publicClient.readContract({
        address: litePsm,
        abi: litePsmAbi,
        functionName: 'tout',
        blockNumber,
      }),
      'readContract',
      1,
      litePsm,
      'tout',
    ),
  ]);
  if (assets.isErr()) return err(assets.error);
  if (tout.isErr()) return err(tout.error);
  const expected = usdcFromUsdsViaBuyGem(assets.value, tout.value);
  const minimum = applySlippageDown(expected, request.slippage);
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
      args: [request.receiver, minimum],
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
    requiredAmount: assets.value,
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
  return ok(
    exactInQuote(request, plan.value, blockNumber, expected, minimum, {
      kind: 'lite-psm',
      tout: tout.value,
    }),
  );
}

function exactInQuote(
  request: ResolvedRequest,
  plan: ExecutionPlan,
  blockNumber: bigint,
  expected: bigint,
  minimum: bigint,
  protocolFee: {
    readonly kind: 'none' | 'lite-psm';
    readonly tin?: bigint;
    readonly tout?: bigint;
  } = {
    kind: 'none',
  },
): PreparedExactInSwapQuote {
  return {
    mode: 'exact-in',
    assetIn: request.assetIn,
    assetOut: request.assetOut,
    amountIn: { symbol: request.assetIn, raw: request.amount },
    expectedAmountOut: { symbol: request.assetOut, raw: expected },
    minimumAmountOut: { symbol: request.assetOut, raw: minimum },
    slippage: request.slippage,
    route: {
      chainId: request.chainId,
      protocol: request.protocol,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      mode: 'exact-in',
      steps: plan.steps.map((step) => step.operation),
    },
    slippageProtection: {
      bound: 'minimum-output',
      enforcedBy: protectionFor(request.protocol, request.mode, request.assetIn, request.assetOut),
    },
    quotedAt: { blockNumber },
    protocolFee,
    plan,
  };
}

function exactOutQuote(
  request: ResolvedRequest,
  plan: ExecutionPlan,
  blockNumber: bigint,
  expected: bigint,
  maximum: bigint,
  protocolFee: {
    readonly kind: 'none' | 'lite-psm';
    readonly tin?: bigint;
    readonly tout?: bigint;
  } = {
    kind: 'none',
  },
): PreparedExactOutSwapQuote {
  return {
    mode: 'exact-out',
    assetIn: request.assetIn,
    assetOut: request.assetOut,
    amountOut: { symbol: request.assetOut, raw: request.amount },
    expectedAmountIn: { symbol: request.assetIn, raw: expected },
    maximumAmountIn: { symbol: request.assetIn, raw: maximum },
    slippage: request.slippage,
    route: {
      chainId: request.chainId,
      protocol: request.protocol,
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      mode: 'exact-out',
      steps: plan.steps.map((step) => step.operation),
    },
    slippageProtection: {
      bound: 'maximum-input',
      enforcedBy: protectionFor(request.protocol, request.mode, request.assetIn, request.assetOut),
    },
    quotedAt: { blockNumber },
    protocolFee,
    plan,
  };
}
