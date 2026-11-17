import { encodeFunctionData, type Address, type Hex } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import type { AdvisoryGasEstimate } from './domain.js';
import {
  QuoteExpiredError,
  ValidationError,
  type CompletedExecutionStep,
  type ExecutionFailureContext,
  type OseroError,
} from './errors.js';
import { err, ok, type Result } from './result.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutionPlanMetadata,
  ExecutorRequirements,
  ExecutionResumeState,
  OperationType,
  QuoteExpiry,
  TransactionRequest,
} from './types.js';
import {
  computeExecutionPlanId,
  validateAddress,
  validateExecutionPlan,
  validatePositiveUint256,
  validateQuoteExpiry,
  validateResumeState,
  validateResumeStateShape,
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

  return createPreparedApprovalTransaction({
    id: input.id,
    chainId: input.chainId,
    sender: owner.value,
    recipient: token.value,
    calldata: data,
    value: 0n,
    token: token.value,
    spender: spender.value,
    requiredAmount: amount.value,
    ...(input.estimatedGas === undefined ? {} : { estimatedGas: input.estimatedGas }),
  });
}

export function createPreparedApprovalTransaction(input: {
  readonly id: string;
  readonly chainId: number;
  readonly sender: Address;
  readonly recipient: Address;
  readonly calldata: Hex;
  readonly value: bigint;
  readonly token: Address;
  readonly spender: Address;
  readonly requiredAmount: bigint;
  readonly estimatedGas?: AdvisoryGasEstimate;
}): Result<TransactionRequest, ValidationError> {
  return validateTransactionRequest({
    __typename: 'TransactionRequest',
    id: input.id,
    chainId: input.chainId,
    from: input.sender,
    to: input.recipient,
    data: input.calldata,
    value: input.value,
    operation: 'APPROVE_ERC20',
    authorization: {
      kind: 'erc20-approval',
      token: input.token,
      owner: input.sender,
      spender: input.spender,
      amount: input.requiredAmount,
    },
    ...(input.estimatedGas === undefined ? {} : { estimatedGas: input.estimatedGas }),
  });
}

export type CreateExecutionPlanInput = {
  readonly steps: readonly TransactionRequest[];
  readonly quoteExpiresAt?: string;
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
  let quoteExpiresAt: QuoteExpiry | undefined;
  if (input.quoteExpiresAt !== undefined) {
    const expiry = validateQuoteExpiry(input.quoteExpiresAt, 'plan.quoteExpiresAt');
    if (expiry.isErr()) return err(expiry.error);
    quoteExpiresAt = expiry.value;
  }
  const id = computeExecutionPlanId(steps, requirements, quoteExpiresAt);
  const common = {
    __typename: 'ExecutionPlan',
    id,
    steps,
    requirements,
    metadata: input.metadata ?? { source: 'custom' },
  } as const;
  return quoteExpiresAt === undefined
    ? validateExecutionPlan({ ...common, version: 1 })
    : validateExecutionPlan({ ...common, version: 2, quoteExpiresAt });
}

export function serializeExecutionPlan(plan: ExecutionPlan): Result<string, ValidationError> {
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return err(validated.error);
  try {
    return ok(JSON.stringify(validated.value, encodeBigint));
  } catch (cause) {
    return err(
      new ValidationError('Execution plan could not be serialized', 'plan', undefined, { cause }),
    );
  }
}

function encodeBigint(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
}

function decodeBigint(_key: string, nested: unknown): unknown {
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
    value = JSON.parse(serialized, decodeBigint);
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
  if (
    computeExecutionPlanId(
      validated.value.steps,
      validated.value.requirements,
      validated.value.quoteExpiresAt,
    ) !== validated.value.id
  ) {
    return err(
      ValidationError.forField('plan.id', 'plan id does not match its transaction contents'),
    );
  }
  return validated;
}

export function checkExecutionPlanExpiry(
  plan: ExecutionPlan,
  execution?: ExecutionFailureContext,
): Result<void, QuoteExpiredError> {
  if (plan.quoteExpiresAt === undefined || Date.now() < Date.parse(plan.quoteExpiresAt)) {
    return ok(undefined);
  }
  return err(new QuoteExpiredError(plan, plan.quoteExpiresAt, execution));
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

/**
 * Serializes resume state with the same canonical, bigint-safe encoding as
 * {@link serializeExecutionPlan}. The state is checked for shape only; whether
 * it matches a particular plan is decided when it is used, by
 * {@link resumeExecutionPlan} and by every adapter.
 */
export function serializeExecutionResumeState(
  state: ExecutionResumeState,
): Result<string, ValidationError> {
  const validated = validateResumeStateShape(state);
  if (validated.isErr()) return err(validated.error);
  try {
    return ok(JSON.stringify(validated.value, encodeBigint));
  } catch (cause) {
    return err(
      new ValidationError('Resume state could not be serialized', 'resume', undefined, { cause }),
    );
  }
}

export function deserializeExecutionResumeState(
  serialized: string,
): Result<ExecutionResumeState, ValidationError> {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    return err(
      ValidationError.forField('serialized', 'serialized resume state must be a non-empty string'),
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized, decodeBigint);
  } catch (cause) {
    return err(
      new ValidationError(
        'serialized resume state is not valid canonical JSON',
        'serialized',
        undefined,
        { cause },
      ),
    );
  }
  return validateResumeStateShape(value as ExecutionResumeState);
}

export type ExecutionResumeFromErrorOptions = {
  /**
   * What to do when the step that failed may already have been submitted and
   * its outcome is unknown: a receipt wait that timed out, a broadcast that
   * failed ambiguously, a replaced transaction, a resume proof that could not
   * be verified, or an EIP-5792 batch whose status never arrived.
   *
   * - `'reject'` (default) returns a `ValidationError` whose `details` carry the
   *   stage and any transaction hash or batch id to check.
   * - `'assume-not-executed'` returns the confirmed prefix, so resuming sends
   *   the failed step again. Pass it only after confirming on chain, or with
   *   the wallet, that the step did not execute. If it did execute, resuming
   *   this way executes it twice.
   */
  readonly unresolvedStep?: 'reject' | 'assume-not-executed';
};

/**
 * Whether the failure proves its step did not take effect. Only these do: the
 * step was never sent (preflight, simulation, a progress callback before
 * submission, a user rejection), or it was mined and reverted. A progress
 * failure after confirmation lists its step as completed, so it is covered too.
 */
function failedStepProvablyNotExecuted(error: OseroError, stage: unknown): boolean {
  switch (stage) {
    case 'preflight':
    case 'simulation':
    case 'revert':
    case 'progress':
      return true;
    case 'signing':
      return error.code === 'CANCELLED';
    default:
      // broadcast, confirmation, replacement, and anything unrecognized.
      return false;
  }
}

/**
 * Builds resume state from a failed execution.
 *
 * Every bundled adapter attaches the confirmed prefix, with receipt evidence, to
 * the error it returns. This turns that evidence into the `resume` option for
 * the next `sendWith` call, which re-verifies each receipt before skipping it.
 *
 * It fails rather than guesses:
 *
 * - the error must carry an execution context for this plan, and every completed
 *   step must carry its confirmation. An error raised before execution started,
 *   or by a custom executor that does not record confirmations, cannot be turned
 *   into resume state;
 * - resuming sends every step after the confirmed prefix, starting with the one
 *   that failed. When that step may already have been submitted and its outcome
 *   is unknown, this returns a `ValidationError` instead of state that would
 *   send it again. See {@link ExecutionResumeFromErrorOptions.unresolvedStep}.
 */
export function executionResumeStateFromError(
  plan: ExecutionPlan,
  error: OseroError,
  options?: ExecutionResumeFromErrorOptions,
): Result<ExecutionResumeState, ValidationError> {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    return err(ValidationError.forField('options', 'options must be an object'));
  }
  const unresolvedStep = options?.unresolvedStep ?? 'reject';
  if (unresolvedStep !== 'reject' && unresolvedStep !== 'assume-not-executed') {
    return err(
      ValidationError.forField(
        'options.unresolvedStep',
        'unresolvedStep must be reject or assume-not-executed',
      ),
    );
  }
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return err(validated.error);
  const execution =
    typeof error === 'object' && error !== null && 'execution' in error
      ? (error.execution as ExecutionFailureContext | undefined)
      : undefined;
  if (typeof execution !== 'object' || execution === null) {
    return err(
      ValidationError.forField(
        'error.execution',
        'error carries no execution context; nothing is known about confirmed steps',
      ),
    );
  }
  if (execution.planId !== validated.value.id) {
    return err(
      ValidationError.forField(
        'error.execution.planId',
        'execution failure belongs to a different execution plan',
      ),
    );
  }
  if (!Array.isArray(execution.completed)) {
    return err(
      ValidationError.forField('error.execution.completed', 'completed steps must be an array'),
    );
  }

  const confirmed: ConfirmedTransaction[] = [];
  for (const [index, step] of (
    execution.completed as readonly CompletedExecutionStep[]
  ).entries()) {
    if (
      typeof step !== 'object' ||
      step === null ||
      step.confirmation === undefined ||
      step.submittedHash === undefined
    ) {
      return err(
        ValidationError.forField(
          `error.execution.completed[${index}]`,
          'completed step carries no confirmation data; resume state cannot be derived from it',
        ),
      );
    }
    confirmed.push({
      planId: step.planId,
      stepId: step.stepId,
      stepIndex: step.stepIndex,
      operation: step.operation as OperationType,
      submittedHash: step.submittedHash,
      hash: step.hash,
      ...(step.replacement === undefined ? {} : { replacement: step.replacement }),
      confirmation: step.confirmation,
    });
  }

  const state: ExecutionResumeState = { planId: validated.value.id, confirmed };
  const shape = validateResumeStateShape(state);
  if (shape.isErr()) return err(shape.error);
  const matched = validateResumeState(validated.value, state);
  if (matched.isErr()) return err(matched.error);

  // Resuming sends the failed step again unless it is part of the confirmed
  // prefix. Refuse when nothing proves that step did not already take effect.
  const failedStepIsConfirmed = confirmed.some(
    (transaction) => transaction.stepIndex === execution.stepIndex,
  );
  if (
    !failedStepIsConfirmed &&
    unresolvedStep === 'reject' &&
    !failedStepProvablyNotExecuted(error, execution.stage)
  ) {
    return err(
      ValidationError.forField(
        'error.execution.stage',
        `step ${String(execution.stepId)} failed at stage ${String(execution.stage)} and may already have been submitted; ` +
          "confirm its outcome, then pass unresolvedStep: 'assume-not-executed' to resume from the confirmed prefix",
        {
          stage: execution.stage,
          stepId: execution.stepId,
          stepIndex: execution.stepIndex,
          ...(execution.hash === undefined ? {} : { hash: execution.hash }),
          ...(execution.batchId === undefined ? {} : { batchId: execution.batchId }),
        },
      ),
    );
  }
  return ok(state);
}
