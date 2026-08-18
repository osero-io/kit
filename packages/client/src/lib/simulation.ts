import type { Address } from 'viem';

import { erc20Abi } from './abis/erc20.js';
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
import type { ExecutionPlan, OperationType } from './types.js';
import { validateExecutorBinding } from './validation.js';

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
      };
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
    readonly gasPrice: bigint;
    readonly source: 'rpc';
  };
  readonly steps: readonly SimulatedExecutionStep[];
  readonly provenance: {
    readonly transportType: string;
    readonly chainName: string;
  };
};

export function simulateExecutionPlan(
  client: OseroClient,
  plan: ExecutionPlan,
  account: Address,
): ResultAsync<PlanSimulation, SimulationErrorType> {
  const firstChainId = plan.steps[0]?.chainId;
  if (firstChainId === undefined) {
    return errAsync(ValidationError.forField('plan.steps', 'plan must contain at least one step'));
  }
  const binding = validateExecutorBinding(plan, account, firstChainId);
  if (binding.isErr()) return errAsync(binding.error);
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
    const gasPrice = fees.value.maxFeePerGas ?? fees.value.gasPrice;

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
        const estimate = await ResultAsync.fromPromise(
          publicClient.value.estimateGas({
            account,
            to: step.to,
            data: step.data,
            value: step.value,
            blockNumber: block.value,
          }),
          (cause) =>
            SimulationError.from(cause, {
              planId: binding.value.id,
              stepId: step.id,
              stepIndex,
              operation: step.operation,
              stage: 'simulation',
              completed: [],
            }),
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
            : { status: 'failed', error: estimate.error },
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
      feeData: { gasPrice, source: 'rpc' },
      steps,
      provenance: {
        transportType: publicClient.value.transport.type,
        chainName: publicClient.value.chain.name,
      },
    });
  };

  return new ResultAsync(simulation());
}
