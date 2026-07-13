import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import type { AdvisoryGasEstimate } from './domain.js';
import { ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';
import type {
  ExecutionPlan,
  ExecutionPlanMetadata,
  ExecutorRequirements,
  ExecutionResumeState,
  OperationType,
  TransactionRequest,
} from './types.js';
import {
  validateAddress,
  validateExecutionPlan,
  validatePositiveUint256,
  validateResumeState,
  validateTransactionRequest,
} from './validation.js';

export type TransactionRequestInput = {
  readonly id: string;
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
  readonly operation: OperationType;
  readonly estimatedGas?: AdvisoryGasEstimate;
};

export function createTransactionRequest(
  input: TransactionRequestInput,
): Result<TransactionRequest, ValidationError> {
  if (typeof input !== 'object' || input === null) {
    return err(ValidationError.forField('input', 'transaction input must be an object'));
  }
  const transaction: TransactionRequest = {
    __typename: 'TransactionRequest',
    id: input.id,
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    data: input.data,
    value: input.value ?? 0n,
    operation: input.operation,
    ...(input.estimatedGas === undefined ? {} : { estimatedGas: input.estimatedGas }),
  };
  return validateTransactionRequest(transaction);
}

export function createApprovalTransaction(input: {
  readonly id: string;
  readonly chainId: number;
  readonly owner: Address;
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
  readonly estimatedGas?: AdvisoryGasEstimate;
}): Result<TransactionRequest, ValidationError> {
  if (typeof input !== 'object' || input === null) {
    return err(ValidationError.forField('input', 'approval input must be an object'));
  }
  const owner = validateAddress(input.owner, 'owner');
  if (owner.isErr()) return err(owner.error);
  const token = validateAddress(input.token, 'token');
  if (token.isErr()) return err(token.error);
  const spender = validateAddress(input.spender, 'spender');
  if (spender.isErr()) return err(spender.error);
  const amount = validatePositiveUint256(input.amount, 'amount');
  if (amount.isErr()) return err(amount.error);

  let data: Hex;
  try {
    data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender.value, amount.value],
    });
  } catch (cause) {
    return err(
      new ValidationError('Could not encode ERC-20 approval', 'approval', undefined, { cause }),
    );
  }

  return validateTransactionRequest({
    __typename: 'TransactionRequest',
    id: input.id,
    chainId: input.chainId,
    from: owner.value,
    to: token.value,
    data,
    value: 0n,
    operation: 'APPROVE_ERC20',
    authorization: {
      kind: 'erc20-approval',
      token: token.value,
      owner: owner.value,
      spender: spender.value,
      amount: amount.value,
    },
    ...(input.estimatedGas === undefined ? {} : { estimatedGas: input.estimatedGas }),
  });
}

export type CreateExecutionPlanInput = {
  readonly steps: readonly TransactionRequest[];
  readonly requirements?: ExecutorRequirements;
  readonly metadata?: ExecutionPlanMetadata;
};

export function createExecutionPlan(
  input: CreateExecutionPlanInput,
): Result<ExecutionPlan, ValidationError> {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(input.steps) ||
    input.steps.length === 0
  ) {
    return err(ValidationError.forField('steps', 'an execution plan requires at least one step'));
  }
  const steps: TransactionRequest[] = [];
  for (const [index, step] of input.steps.entries()) {
    const validated = validateTransactionRequest(step, `steps[${index}]`);
    if (validated.isErr()) return err(validated.error);
    steps.push(validated.value);
  }
  const requirements: ExecutorRequirements = input.requirements ?? {
    execution: 'sequential',
    authorization: 'transactions',
    sponsored: false,
    chainTransitions: false,
  };
  const id = computePlanId(steps, requirements);
  return validateExecutionPlan({
    __typename: 'ExecutionPlan',
    version: 1,
    id,
    steps,
    requirements,
    metadata: input.metadata ?? { source: 'custom' },
  });
}

function computePlanId(
  steps: readonly TransactionRequest[],
  requirements: ExecutorRequirements,
): string {
  const canonical = JSON.stringify({
    requirements,
    steps: steps.map((step) => ({
      id: step.id,
      chainId: step.chainId,
      from: step.from.toLowerCase(),
      to: step.to.toLowerCase(),
      data: step.data.toLowerCase(),
      value: step.value.toString(),
      operation: step.operation,
      authorization:
        step.authorization === undefined
          ? null
          : {
              token: step.authorization.token.toLowerCase(),
              owner: step.authorization.owner.toLowerCase(),
              spender: step.authorization.spender.toLowerCase(),
              amount: step.authorization.amount.toString(),
            },
    })),
  });
  return `plan-${keccak256(stringToHex(canonical)).slice(2)}`;
}

export function serializeExecutionPlan(plan: ExecutionPlan): Result<string, ValidationError> {
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return err(validated.error);
  try {
    return ok(
      JSON.stringify(validated.value, (_key, value: unknown) =>
        typeof value === 'bigint' ? { $bigint: value.toString() } : value,
      ),
    );
  } catch (cause) {
    return err(
      new ValidationError('Execution plan could not be serialized', 'plan', undefined, { cause }),
    );
  }
}

export function deserializeExecutionPlan(
  serialized: string,
): Result<ExecutionPlan, ValidationError> {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    return err(
      ValidationError.forField(
        'serialized',
        'serialized execution plan must be a non-empty string',
      ),
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized, (_key, nested: unknown) => {
      if (
        typeof nested === 'object' &&
        nested !== null &&
        Object.keys(nested).length === 1 &&
        '$bigint' in nested &&
        typeof nested.$bigint === 'string' &&
        /^(?:0|[1-9][0-9]*)$/.test(nested.$bigint)
      ) {
        return BigInt(nested.$bigint);
      }
      return nested;
    });
  } catch (cause) {
    return err(
      new ValidationError(
        'serialized execution plan is not valid canonical JSON',
        'serialized',
        undefined,
        {
          cause,
        },
      ),
    );
  }

  const validated = validateExecutionPlan(value as ExecutionPlan);
  if (validated.isErr()) return err(validated.error);
  if (computePlanId(validated.value.steps, validated.value.requirements) !== validated.value.id) {
    return err(
      ValidationError.forField('plan.id', 'plan id does not match its transaction contents'),
    );
  }
  return validated;
}

export function resumeExecutionPlan(
  plan: ExecutionPlan,
  state?: ExecutionResumeState,
): Result<
  {
    readonly confirmed: ExecutionResumeState['confirmed'];
    readonly pending: readonly TransactionRequest[];
  },
  ValidationError
> {
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return err(validated.error);
  const confirmed = validateResumeState(validated.value, state);
  if (confirmed.isErr()) return err(confirmed.error);
  return ok({
    confirmed: confirmed.value,
    pending: validated.value.steps.slice(confirmed.value.length),
  });
}
