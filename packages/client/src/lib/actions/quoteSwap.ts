import { erc4626Abi } from '../abis/erc4626.js';
import { litePsmAbi } from '../abis/litePsm.js';
import { psm3Abi } from '../abis/psm3.js';
import {
  CHAIN_CAPABILITIES,
  type OseroChainId,
  type RouteCapability,
  type TokenSymbol,
} from '../capabilities.js';
import { parseSlippage, type Slippage, type TokenAmount } from '../domain.js';
import {
  RpcError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
  type ConfigurationError,
} from '../errors.js';
import {
  applySlippageDown,
  applySlippageUp,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  usdsNeededForUsdcViaBuyGem,
} from '../math.js';
import type { OseroClient, OseroPublicClient } from '../OseroClient.js';
import { err, errAsync, ok, ResultAsync, type Result } from '../result.js';
import { isTokenSymbol } from '../tokens.js';
import type {
  ExactInSwapQuote,
  ExactOutSwapQuote,
  SwapQuote,
  SwapSlippageProtection,
} from '../types.js';
import { validatePositiveUint256 } from '../validation.js';

export type QuoteSwapBaseRequest = {
  readonly chainId: OseroChainId;
  readonly slippage?: Slippage;
};

export type ExactInSwapQuoteRequest<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = QuoteSwapBaseRequest & {
  readonly mode: 'exact-in';
  readonly amountIn: TokenAmount<AssetIn>;
  readonly assetOut: AssetOut;
};

export type ExactOutSwapQuoteRequest<
  AssetIn extends TokenSymbol = TokenSymbol,
  AssetOut extends TokenSymbol = TokenSymbol,
> = QuoteSwapBaseRequest & {
  readonly mode: 'exact-out';
  readonly assetIn: AssetIn;
  readonly amountOut: TokenAmount<AssetOut>;
};

export type SwapQuoteRequest = ExactInSwapQuoteRequest | ExactOutSwapQuoteRequest;

export type QuoteSwapError =
  | ValidationError
  | UnsupportedChainError
  | ConfigurationError
  | RpcError
  | UnexpectedError;

export type ResolvedSwapQuoteRequest = {
  readonly chainId: OseroChainId;
  readonly protocol: 'ethereum-lite-psm' | 'psm3';
  readonly assetIn: TokenSymbol;
  readonly assetOut: TokenSymbol;
  readonly mode: 'exact-in' | 'exact-out';
  readonly amount: bigint;
  readonly slippage: Slippage;
  readonly slippageEnforcedBy: SwapSlippageProtection['enforcedBy'];
  readonly route: RouteCapability;
};

export type SwapQuoteEvaluation = {
  readonly quote: SwapQuote;
  readonly intermediateUsdsAmount?: bigint;
};

type ProtocolFee = {
  readonly kind: 'none' | 'lite-psm';
  readonly tin?: bigint;
  readonly tout?: bigint;
};

type QuoteReadError = RpcError | UnexpectedError;

export function quoteSwap<AssetIn extends TokenSymbol, AssetOut extends TokenSymbol>(
  client: OseroClient,
  request: ExactInSwapQuoteRequest<AssetIn, AssetOut>,
): ResultAsync<ExactInSwapQuote<AssetIn, AssetOut>, QuoteSwapError>;
export function quoteSwap<AssetIn extends TokenSymbol, AssetOut extends TokenSymbol>(
  client: OseroClient,
  request: ExactOutSwapQuoteRequest<AssetIn, AssetOut>,
): ResultAsync<ExactOutSwapQuote<AssetIn, AssetOut>, QuoteSwapError>;
export function quoteSwap(
  client: OseroClient,
  request: SwapQuoteRequest,
): ResultAsync<SwapQuote, QuoteSwapError>;
export function quoteSwap(
  client: OseroClient,
  request: SwapQuoteRequest,
): ResultAsync<SwapQuote, QuoteSwapError> {
  const resolved = resolveSwapQuoteRequest(client, request);
  if (resolved.isErr()) return errAsync(resolved.error);
  const publicClient = client.getPublicClient(resolved.value.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);

  const quotation = async (): Promise<Result<SwapQuote, QuoteSwapError>> => {
    const block = await quoteRpc(
      publicClient.value.getBlockNumber(),
      'getBlockNumber',
      resolved.value.chainId,
    );
    if (block.isErr()) return err(block.error);

    const evaluated = await evaluateSwapQuote(publicClient.value, resolved.value, block.value);
    return evaluated.map(({ quote }) => quote);
  };

  return new ResultAsync(quotation());
}

export function resolveSwapQuoteRequest(
  client: OseroClient,
  request: SwapQuoteRequest,
): Result<ResolvedSwapQuoteRequest, ValidationError | UnsupportedChainError> {
  if (typeof request !== 'object' || request === null) {
    return err(ValidationError.forField('request', 'request must be an object'));
  }
  if (!Number.isSafeInteger(request.chainId) || !(request.chainId in CHAIN_CAPABILITIES)) {
    return err(new UnsupportedChainError(request.chainId));
  }
  const chainId = request.chainId as OseroChainId;
  const capability = CHAIN_CAPABILITIES[chainId];

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
  const slippage = parseSlippage({ bps: configuredSlippage.bps });
  if (slippage.isErr()) return err(slippage.error);

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

  const slippageEnforcedBy =
    capability.protocol === 'psm3'
      ? 'calldata'
      : request.mode === 'exact-out' &&
          assetIn === 'USDS' &&
          (assetOut === 'USDC' || assetOut === 'sUSDS')
        ? 'allowance'
        : request.mode === 'exact-in' && assetIn === 'sUSDS' && assetOut === 'USDC'
          ? 'calldata'
          : 'none';

  return ok({
    chainId,
    protocol: capability.protocol,
    assetIn,
    assetOut,
    mode: request.mode,
    amount: amount.value,
    slippage: slippage.value,
    slippageEnforcedBy,
    route,
  });
}

export async function evaluateSwapQuote(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  if (request.protocol === 'psm3') {
    return evaluatePsm3Quote(publicClient, request, blockNumber);
  }

  const key = `${request.mode}:${request.assetIn}:${request.assetOut}`;
  switch (key) {
    case 'exact-in:USDC:USDS':
      return evaluateMainnetUsdcToUsds(publicClient, request, blockNumber);
    case 'exact-in:USDC:sUSDS':
      return evaluateMainnetUsdcToSUsds(publicClient, request, blockNumber);
    case 'exact-in:USDS:sUSDS':
      return evaluateMainnetUsdsToSUsds(publicClient, request, blockNumber);
    case 'exact-out:USDS:sUSDS':
      return evaluateMainnetUsdsToSUsdsExactOut(publicClient, request, blockNumber);
    case 'exact-in:sUSDS:USDS':
      return evaluateMainnetSUsdsToUsds(publicClient, request, blockNumber);
    case 'exact-out:sUSDS:USDS':
      return evaluateMainnetSUsdsToUsdsExactOut(publicClient, request, blockNumber);
    case 'exact-out:USDS:USDC':
      return evaluateMainnetUsdsToUsdcExactOut(publicClient, request, blockNumber);
    case 'exact-in:sUSDS:USDC':
      return evaluateMainnetSUsdsToUsdc(publicClient, request, blockNumber);
    default:
      return err(UnexpectedError.from(new Error(`Unhandled verified mainnet route ${key}`)));
  }
}

function quoteRpc<T>(
  promise: Promise<T>,
  operation: string,
  chainId: number,
  contract?: `0x${string}`,
  functionName?: string,
): ResultAsync<T, RpcError> {
  return ResultAsync.fromPromise(promise, (cause) =>
    RpcError.from({ cause, operation, chainId, contract, functionName }),
  );
}

async function evaluatePsm3Quote(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const capability = CHAIN_CAPABILITIES[request.chainId];
  const tokenIn = capability.tokens[request.assetIn];
  const tokenOut = capability.tokens[request.assetOut];
  const psm = capability.contracts.psm;
  const functionName = request.mode === 'exact-in' ? 'previewSwapExactIn' : 'previewSwapExactOut';
  const rawQuote = await quoteRpc(
    publicClient.readContract({
      address: psm,
      abi: psm3Abi,
      functionName,
      args: [tokenIn.address, tokenOut.address, request.amount],
      blockNumber,
    }),
    'readContract',
    request.chainId,
    psm,
    functionName,
  );
  if (rawQuote.isErr()) return err(rawQuote.error);

  return ok({
    quote:
      request.mode === 'exact-in'
        ? exactInQuote(
            request,
            blockNumber,
            rawQuote.value,
            applySlippageDown(rawQuote.value, request.slippage),
          )
        : exactOutQuote(
            request,
            blockNumber,
            rawQuote.value,
            applySlippageUp(rawQuote.value, request.slippage),
          ),
  });
}

async function evaluateMainnetUsdcToUsds(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const litePsm = CHAIN_CAPABILITIES[1].contracts.litePsm;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tin = await quoteRpc(
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

  return ok({
    quote: exactInQuote(
      request,
      blockNumber,
      expected,
      applySlippageDown(expected, request.slippage),
      {
        kind: 'lite-psm',
        tin: tin.value,
      },
    ),
  });
}

async function evaluateMainnetUsdcToSUsds(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { sUSDS } = capability.tokens;
  const { litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tin = await quoteRpc(
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
  const shares = await quoteRpc(
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

  return ok({
    quote: exactInQuote(
      request,
      blockNumber,
      shares.value,
      applySlippageDown(shares.value, request.slippage),
      { kind: 'lite-psm', tin: tin.value },
    ),
    intermediateUsdsAmount: usdsOut,
  });
}

async function evaluateMainnetUsdsToSUsds(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const shares = await quoteRpc(
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

  return ok({
    quote: exactInQuote(
      request,
      blockNumber,
      shares.value,
      applySlippageDown(shares.value, request.slippage),
    ),
  });
}

async function evaluateMainnetUsdsToSUsdsExactOut(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const assets = await quoteRpc(
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

  return ok({
    quote: exactOutQuote(
      request,
      blockNumber,
      assets.value,
      applySlippageUp(assets.value, request.slippage),
    ),
  });
}

async function evaluateMainnetSUsdsToUsds(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const assets = await quoteRpc(
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

  return ok({
    quote: exactInQuote(
      request,
      blockNumber,
      assets.value,
      applySlippageDown(assets.value, request.slippage),
    ),
  });
}

async function evaluateMainnetSUsdsToUsdsExactOut(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const sUSDS = CHAIN_CAPABILITIES[1].tokens.sUSDS;
  const shares = await quoteRpc(
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

  return ok({
    quote: exactOutQuote(
      request,
      blockNumber,
      shares.value,
      applySlippageUp(shares.value, request.slippage),
    ),
  });
}

async function evaluateMainnetUsdsToUsdcExactOut(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const litePsm = CHAIN_CAPABILITIES[1].contracts.litePsm;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const tout = await quoteRpc(
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

  return ok({
    quote: exactOutQuote(
      request,
      blockNumber,
      expected,
      applySlippageUp(expected, request.slippage),
      { kind: 'lite-psm', tout: tout.value },
    ),
  });
}

async function evaluateMainnetSUsdsToUsdc(
  publicClient: OseroPublicClient,
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
): Promise<Result<SwapQuoteEvaluation, QuoteReadError>> {
  const capability = CHAIN_CAPABILITIES[1];
  const { sUSDS } = capability.tokens;
  const { litePsm } = capability.contracts;
  if (litePsm === undefined) return err(UnexpectedError.from(new Error('Missing Lite PSM')));
  const [assets, tout] = await Promise.all([
    quoteRpc(
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
    quoteRpc(
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

  return ok({
    quote: exactInQuote(
      request,
      blockNumber,
      expected,
      applySlippageDown(expected, request.slippage),
      { kind: 'lite-psm', tout: tout.value },
    ),
    intermediateUsdsAmount: assets.value,
  });
}

function exactInQuote(
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
  expected: bigint,
  minimum: bigint,
  protocolFee: ProtocolFee = { kind: 'none' },
): ExactInSwapQuote {
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
    },
    slippageProtection: {
      bound: 'minimum-output',
      enforcedBy: request.slippageEnforcedBy,
    },
    quotedAt: { blockNumber },
    protocolFee,
  };
}

function exactOutQuote(
  request: ResolvedSwapQuoteRequest,
  blockNumber: bigint,
  expected: bigint,
  maximum: bigint,
  protocolFee: ProtocolFee = { kind: 'none' },
): ExactOutSwapQuote {
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
    },
    slippageProtection: {
      bound: 'maximum-input',
      enforcedBy: request.slippageEnforcedBy,
    },
    quotedAt: { blockNumber },
    protocolFee,
  };
}
