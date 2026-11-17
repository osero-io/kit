import {
  ContractFunctionRevertedError,
  decodeErrorResult,
  isHex,
  type Address,
  type Hex,
} from 'viem';

import { erc20Abi } from './abis/erc20.js';
import type { TokenAmount } from './domain.js';
import {
  RpcError,
  SimulationError,
  UnsupportedCapabilityError,
  type AccountMismatchError,
  type ChainMismatchError,
  type ConfigurationError,
  type UnexpectedError,
  type UnsupportedChainError,
  ValidationError,
} from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import { observeResult } from './telemetry.js';
import type {
  ExecutionPlan,
  OperationType,
  PreparedSwapQuote,
  SwapSlippageProtection,
} from './types.js';
import { computeExecutionPlanId, validateExecutorBinding } from './validation.js';

export type SimulationErrorType =
  | ValidationError
  | UnsupportedChainError
  | ConfigurationError
  | UnexpectedError
  | AccountMismatchError
  | ChainMismatchError
  | RpcError
  | UnsupportedCapabilityError;

export type AllowanceObservation = {
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly allowance: bigint;
};

export type TokenBalanceObservation = {
  readonly token: Address;
  readonly account: Address;
  readonly balance: bigint;
};

/**
 * What could be recovered about why a simulated step reverted. Both fields are
 * best effort: a node may return no revert data, and data that is not a
 * standard `Error(string)` or `Panic(uint256)` has no decoded reason.
 */
export type SimulatedStepRevert = {
  readonly reason?: string;
  readonly data?: Hex;
};

export type SimulatedExecutionStep = {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly operation: OperationType;
  readonly independentlySimulated: true;
  readonly conditionalOnPriorSteps: boolean;
  readonly result:
    | {
        readonly status: 'success';
        readonly estimatedGas: bigint;
        readonly estimatedNativeFee: bigint;
      }
    | {
        readonly status: 'failed';
        readonly error: SimulationError;
        /** Present when the failure carried a revert reason or raw revert data. */
        readonly revert?: SimulatedStepRevert;
      };
};

/**
 * The quoted bounds of the prepared quote a plan came from, echoed next to its
 * simulation. They are the quote's values, not something the simulation
 * measured: independent step simulation does not observe the swap output.
 */
export type SimulatedQuoteBounds = {
  readonly assetIn: TokenAmount['symbol'];
  readonly assetOut: TokenAmount['symbol'];
  readonly slippageProtection: SwapSlippageProtection;
  readonly quotedAtBlock: bigint;
} & (
  | {
      readonly mode: 'exact-in';
      readonly amountIn: TokenAmount;
      readonly expectedAmountOut: TokenAmount;
      readonly minimumAmountOut: TokenAmount;
    }
  | {
      readonly mode: 'exact-out';
      readonly amountOut: TokenAmount;
      readonly expectedAmountIn: TokenAmount;
      readonly maximumAmountIn: TokenAmount;
    }
);

export type SimulateExecutionPlanOptions = {
  /**
   * The prepared quote the plan belongs to. When supplied, the quote's plan
   * must be the plan being simulated, and its bounds are echoed on the result.
   */
  readonly quote?: PreparedSwapQuote;
};

export type PlanSimulation = {
  readonly planId: string;
  readonly account: Address;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly scope: 'single-step' | 'independent-steps';
  readonly nativeBalance: bigint;
  readonly tokenBalances: readonly TokenBalanceObservation[];
  readonly allowances: readonly AllowanceObservation[];
  readonly feeData: {
    /**
     * Price used for `estimatedNativeFee`: the EIP-1559 `maxFeePerGas` when the
     * chain reports one, otherwise the legacy gas price. `basis` says which.
     */
    readonly gasPrice: bigint;
    readonly source: 'rpc';
    /**
     * `max-fee-per-gas` means `gasPrice` is a fee cap, so `estimatedNativeFee` is
     * an upper bound rather than the expected cost.
     */
    readonly basis?: 'max-fee-per-gas' | 'gas-price';
    /** The EIP-1559 fee cap, when the chain reports one. Equal to `gasPrice` then. */
    readonly maxFeePerGas?: bigint;
  };
  /** Present when `options.quote` was supplied and matched the simulated plan. */
  readonly quote?: SimulatedQuoteBounds;
  readonly steps: readonly SimulatedExecutionStep[];
  readonly provenance: {
    readonly transportType: string;
    readonly chainName: string;
  };
};

const REVERT_REASON_PATTERN = /^Execution reverted with reason: (.+)\.$/;

/**
 * Walks a failed estimate's cause chain for a revert reason and raw revert
 * data. Nothing is invented: a field is set only when the chain carried it.
 */
function decodeRevert(cause: unknown): SimulatedStepRevert | undefined {
  let reason: string | undefined;
  let data: Hex | undefined;
  let nodeReason: string | undefined;
  const seen = new Set<unknown>();
  let current = cause;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ContractFunctionRevertedError) {
      reason ??= current.reason ?? current.data?.errorName;
      if (data === undefined && isHex(current.raw)) data = current.raw;
    }
    if (data === undefined && 'data' in current) {
      const candidate = current.data;
      if (isHex(candidate)) {
        data = candidate;
      } else if (
        typeof candidate === 'object' &&
        candidate !== null &&
        'data' in candidate &&
        isHex(candidate.data)
      ) {
        data = candidate.data;
      }
    }
    if (nodeReason === undefined && 'shortMessage' in current) {
      const match =
        typeof current.shortMessage === 'string'
          ? REVERT_REASON_PATTERN.exec(current.shortMessage)
          : null;
      if (match?.[1] !== undefined) nodeReason = match[1];
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  if (reason === undefined && data !== undefined && data !== '0x') {
    try {
      // Without an ABI viem decodes the standard Error(string) and Panic(uint256).
      const decoded = decodeErrorResult({ data });
      const [argument] = decoded.args ?? [];
      reason =
        decoded.errorName === 'Error' && typeof argument === 'string'
          ? argument
          : decoded.errorName === 'Panic' && typeof argument === 'bigint'
            ? `Panic(${argument})`
            : undefined;
    } catch {
      // Custom error data stays available as raw `data`; there is no reason to report.
    }
  }
  reason ??= nodeReason;
  if (reason === undefined && data === undefined) return undefined;
  return {
    ...(reason === undefined ? {} : { reason }),
    ...(data === undefined ? {} : { data }),
  };
}

function quoteBounds(quote: PreparedSwapQuote): SimulatedQuoteBounds {
  const common = {
    assetIn: quote.assetIn,
    assetOut: quote.assetOut,
    slippageProtection: quote.slippageProtection,
    quotedAtBlock: quote.quotedAt.blockNumber,
  };
  return quote.mode === 'exact-in'
    ? {
        ...common,
        mode: 'exact-in',
        amountIn: quote.amountIn,
        expectedAmountOut: quote.expectedAmountOut,
        minimumAmountOut: quote.minimumAmountOut,
      }
    : {
        ...common,
        mode: 'exact-out',
        amountOut: quote.amountOut,
        expectedAmountIn: quote.expectedAmountIn,
        maximumAmountIn: quote.maximumAmountIn,
      };
}

export function simulateExecutionPlan(
  client: OseroClient,
  plan: ExecutionPlan,
  account: Address,
  options?: SimulateExecutionPlanOptions,
): ResultAsync<PlanSimulation, SimulationErrorType> {
  const firstChainId = plan.steps[0]?.chainId;
  if (firstChainId === undefined) {
    return errAsync(ValidationError.forField('plan.steps', 'plan must contain at least one step'));
  }
  const binding = validateExecutorBinding(plan, account, firstChainId);
  if (binding.isErr()) return errAsync(binding.error);
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    return errAsync(ValidationError.forField('options', 'options must be an object'));
  }
  const quote = options?.quote;
  if (quote !== undefined) {
    // The echoed bounds must describe exactly the transactions being simulated:
    // the quote's plan id, the plan's id, and the plan's contents all agree.
    const contentId = computeExecutionPlanId(
      binding.value.steps,
      binding.value.requirements,
      binding.value.quoteExpiresAt,
    );
    if (
      typeof quote !== 'object' ||
      quote === null ||
      typeof quote.plan !== 'object' ||
      quote.plan === null ||
      quote.plan.id !== binding.value.id ||
      contentId !== binding.value.id
    ) {
      return errAsync(
        ValidationError.forField(
          'options.quote',
          'quote does not belong to the execution plan being simulated',
        ),
      );
    }
  }
  const publicClient = client.getPublicClient(firstChainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);
  if (typeof publicClient.value.estimateGas !== 'function') {
    return errAsync(new UnsupportedCapabilityError('independent-step-simulation', 'public-client'));
  }

  const simulation = async (): Promise<Result<PlanSimulation, SimulationErrorType>> => {
    const block = await ResultAsync.fromPromise(publicClient.value.getBlockNumber(), (cause) =>
      RpcError.from({ cause, operation: 'getBlockNumber', chainId: firstChainId }),
    );
    if (block.isErr()) return err(block.error);

    const [nativeBalance, fees] = await Promise.all([
      ResultAsync.fromPromise(
        publicClient.value.getBalance({ address: account, blockNumber: block.value }),
        (cause) => RpcError.from({ cause, operation: 'getBalance', chainId: firstChainId }),
      ),
      ResultAsync.fromPromise(publicClient.value.estimateFeesPerGas(), (cause) =>
        RpcError.from({ cause, operation: 'estimateFeesPerGas', chainId: firstChainId }),
      ),
    ]);
    if (nativeBalance.isErr()) return err(nativeBalance.error);
    if (fees.isErr()) return err(fees.error);
    const maxFeePerGas = fees.value.maxFeePerGas ?? undefined;
    const gasPrice = maxFeePerGas ?? fees.value.gasPrice;

    const observationKeys = new Map<
      string,
      { readonly token: Address; readonly owner: Address; readonly spender: Address }
    >();
    for (const snapshot of binding.value.metadata.allowanceSnapshots ?? []) {
      observationKeys.set(
        `${snapshot.token.toLowerCase()}:${snapshot.owner.toLowerCase()}:${snapshot.spender.toLowerCase()}`,
        { token: snapshot.token, owner: snapshot.owner, spender: snapshot.spender },
      );
    }
    for (const step of binding.value.steps) {
      if (step.authorization !== undefined) {
        const authorization = step.authorization;
        observationKeys.set(
          `${authorization.token.toLowerCase()}:${authorization.owner.toLowerCase()}:${authorization.spender.toLowerCase()}`,
          {
            token: authorization.token,
            owner: authorization.owner,
            spender: authorization.spender,
          },
        );
      }
    }

    const observationResults = await Promise.all(
      [...observationKeys.values()].map(async (observation) => {
        const [allowance, balance] = await Promise.all([
          ResultAsync.fromPromise(
            publicClient.value.readContract({
              address: observation.token,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [observation.owner, observation.spender],
              blockNumber: block.value,
            }),
            (cause) =>
              RpcError.from({
                cause,
                operation: 'readContract',
                chainId: firstChainId,
                contract: observation.token,
                functionName: 'allowance',
              }),
          ),
          ResultAsync.fromPromise(
            publicClient.value.readContract({
              address: observation.token,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [observation.owner],
              blockNumber: block.value,
            }),
            (cause) =>
              RpcError.from({
                cause,
                operation: 'readContract',
                chainId: firstChainId,
                contract: observation.token,
                functionName: 'balanceOf',
              }),
          ),
        ]);
        if (allowance.isErr()) return err(allowance.error);
        if (balance.isErr()) return err(balance.error);
        return ok({
          allowance: {
            ...observation,
            allowance: allowance.value,
          } satisfies AllowanceObservation,
          balance: {
            token: observation.token,
            account: observation.owner,
            balance: balance.value,
          } satisfies TokenBalanceObservation,
        });
      }),
    );
    for (const observation of observationResults) {
      if (observation.isErr()) return err(observation.error);
    }

    const steps = await Promise.all(
      binding.value.steps.map(async (step, stepIndex): Promise<SimulatedExecutionStep> => {
        let revert: SimulatedStepRevert | undefined;
        const estimate = await ResultAsync.fromPromise(
          publicClient.value.estimateGas({
            account,
            to: step.to,
            data: step.data,
            value: step.value,
            blockNumber: block.value,
          }),
          (cause) => {
            revert = decodeRevert(cause);
            return SimulationError.from(cause, {
              planId: binding.value.id,
              stepId: step.id,
              stepIndex,
              operation: step.operation,
              stage: 'simulation',
              completed: [],
            });
          },
        );
        return {
          stepId: step.id,
          stepIndex,
          operation: step.operation,
          independentlySimulated: true,
          conditionalOnPriorSteps: stepIndex > 0,
          result: estimate.isOk()
            ? {
                status: 'success',
                estimatedGas: estimate.value,
                estimatedNativeFee: estimate.value * gasPrice,
              }
            : {
                status: 'failed',
                error: estimate.error,
                ...(revert === undefined ? {} : { revert }),
              },
        };
      }),
    );

    const successfulObservations = observationResults
      .filter((observation) => observation.isOk())
      .map((observation) => observation.value);
    return ok({
      planId: binding.value.id,
      account,
      chainId: firstChainId,
      blockNumber: block.value,
      scope: binding.value.steps.length === 1 ? 'single-step' : 'independent-steps',
      nativeBalance: nativeBalance.value,
      tokenBalances: successfulObservations.map((observation) => observation.balance),
      allowances: successfulObservations.map((observation) => observation.allowance),
      feeData: {
        gasPrice,
        source: 'rpc',
        basis: maxFeePerGas === undefined ? 'gas-price' : 'max-fee-per-gas',
        ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
      },
      ...(quote === undefined ? {} : { quote: quoteBounds(quote) }),
      steps,
      provenance: {
        transportType: publicClient.value.transport.type,
        chainName: publicClient.value.chain.name,
      },
    });
  };

  return observeResult(new ResultAsync(simulation()), {
    operation: 'actions.simulateExecutionPlan',
    chainId: firstChainId,
  });
}
