import type { Address, PublicClient } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import {
  type AdvisoryGasEstimate,
  type AllowanceSnapshot,
  type ApprovalPolicy,
  UINT256_MAX,
} from './domain.js';
import {
  InsufficientAllowanceError,
  RpcError,
  ValidationError,
  type ConfigurationError,
  type UnexpectedError,
  type UnsupportedChainError,
} from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { createApprovalTransaction } from './plan.js';
import { err, errAsync, ok, ResultAsync, type Result } from './result.js';
import type { TransactionRequest } from './types.js';
import { validateAddress, validatePositiveUint256 } from './validation.js';

export type PrepareAllowanceError =
  | ValidationError
  | UnsupportedChainError
  | ConfigurationError
  | UnexpectedError
  | RpcError
  | InsufficientAllowanceError;

export type PrepareAllowanceInput = {
  readonly stepId: string;
  readonly chainId: number;
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly requiredAmount: bigint;
  readonly policy: ApprovalPolicy;
  readonly blockNumber?: bigint;
  readonly enforceSpendingCap?: boolean;
  readonly estimatedGas?: AdvisoryGasEstimate;
};

export type PreparedAllowance = {
  readonly approval?: TransactionRequest;
  readonly snapshot: AllowanceSnapshot;
};

export type AllowanceCheck = {
  readonly needsApproval: boolean;
  readonly snapshot: AllowanceSnapshot;
};

type ValidatedAllowanceInput = Omit<
  PrepareAllowanceInput,
  'token' | 'owner' | 'spender' | 'requiredAmount'
> & {
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly requiredAmount: bigint;
};

export function prepareAllowance(
  client: OseroClient,
  input: PrepareAllowanceInput,
): ResultAsync<PreparedAllowance, PrepareAllowanceError> {
  const validated = validateAllowanceInput(input);
  if (validated.isErr()) return errAsync(validated.error);
  const publicClient = client.getPublicClient(validated.value.chainId);
  if (publicClient.isErr()) return errAsync(publicClient.error);
  return readAndPrepareAllowance(publicClient.value, validated.value);
}

export function prepareAllowanceWithPublicClient(
  publicClient: Pick<PublicClient, 'readContract'>,
  input: PrepareAllowanceInput,
): ResultAsync<PreparedAllowance, ValidationError | RpcError | InsufficientAllowanceError> {
  const validated = validateAllowanceInput(input);
  if (validated.isErr()) return errAsync(validated.error);
  return readAndPrepareAllowance(publicClient, validated.value);
}

export function checkAllowanceWithPublicClient(
  publicClient: Pick<PublicClient, 'readContract'>,
  input: PrepareAllowanceInput,
): ResultAsync<AllowanceCheck, ValidationError | RpcError> {
  const validated = validateAllowanceInput(input);
  if (validated.isErr()) return errAsync(validated.error);
  return readAllowanceSnapshot(publicClient, validated.value).map((snapshot) => ({
    needsApproval: requiresApproval(validated.value, snapshot.allowance),
    snapshot,
  }));
}

function validateAllowanceInput(
  input: PrepareAllowanceInput,
): Result<ValidatedAllowanceInput, ValidationError> {
  const token = validateAddress(input.token, 'token');
  if (token.isErr()) return err(token.error);
  const owner = validateAddress(input.owner, 'owner');
  if (owner.isErr()) return err(owner.error);
  const spender = validateAddress(input.spender, 'spender');
  if (spender.isErr()) return err(spender.error);
  const required = validatePositiveUint256(input.requiredAmount, 'requiredAmount');
  if (required.isErr()) return err(required.error);
  if (input.policy !== 'exact' && input.policy !== 'max' && input.policy !== 'none') {
    return err(
      new ValidationError('approval policy must be exact, max, or none', 'approvalPolicy'),
    );
  }
  if (input.enforceSpendingCap && input.policy === 'max') {
    return err(
      new ValidationError(
        'max approval cannot enforce this route’s maximum-input safety bound',
        'approvalPolicy',
      ),
    );
  }
  return ok({
    ...input,
    token: token.value,
    owner: owner.value,
    spender: spender.value,
    requiredAmount: required.value,
  });
}

function readAndPrepareAllowance(
  publicClient: Pick<PublicClient, 'readContract'>,
  input: ValidatedAllowanceInput,
): ResultAsync<PreparedAllowance, ValidationError | RpcError | InsufficientAllowanceError> {
  return readAllowanceSnapshot(publicClient, input).andThen((snapshot) => {
    if (!requiresApproval(input, snapshot.allowance)) return ok({ snapshot });
    if (input.policy === 'none') {
      return err(
        new InsufficientAllowanceError(
          input.token,
          input.owner,
          input.spender,
          input.requiredAmount,
          snapshot.allowance,
        ),
      );
    }

    const approvalAmount = input.policy === 'max' ? UINT256_MAX : input.requiredAmount;
    const approval = createApprovalTransaction({
      id: input.stepId,
      chainId: input.chainId,
      owner: input.owner,
      token: input.token,
      spender: input.spender,
      amount: approvalAmount,
      ...(input.estimatedGas === undefined ? {} : { estimatedGas: input.estimatedGas }),
    });
    if (approval.isErr()) return err(approval.error);
    return ok({
      approval: approval.value,
      snapshot: { ...snapshot, approvalAmount },
    });
  });
}

function readAllowanceSnapshot(
  publicClient: Pick<PublicClient, 'readContract'>,
  input: ValidatedAllowanceInput,
): ResultAsync<AllowanceSnapshot, RpcError> {
  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: input.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.spender],
      ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber }),
    }),
    (cause) =>
      RpcError.from({
        cause,
        operation: 'readContract',
        chainId: input.chainId,
        contract: input.token,
        functionName: 'allowance',
      }),
  ).map((allowance) => allowanceSnapshot(input, allowance));
}

function allowanceSnapshot(input: ValidatedAllowanceInput, allowance: bigint): AllowanceSnapshot {
  const snapshot = {
    token: input.token,
    owner: input.owner,
    spender: input.spender,
    allowance,
    requiredAmount: input.requiredAmount,
    policy: input.policy,
  } satisfies AllowanceSnapshot;
  return input.blockNumber === undefined
    ? snapshot
    : { ...snapshot, observedAtBlock: input.blockNumber };
}

function requiresApproval(input: ValidatedAllowanceInput, allowance: bigint): boolean {
  return input.enforceSpendingCap
    ? allowance !== input.requiredAmount
    : allowance < input.requiredAmount;
}
