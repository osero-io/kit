import {
  decodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { UINT256_MAX } from './domain.js';
import { AccountMismatchError, ChainMismatchError, ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutorRequirements,
  ExecutionResumeState,
  OperationType,
  QuoteExpiry,
  TransactionRequest,
} from './types.js';

const OPERATIONS: Readonly<Record<OperationType, true>> = {
  APPROVE_ERC20: true,
  SWAP_EXACT_IN: true,
  SWAP_EXACT_OUT: true,
  MINT_USDS: true,
  DEPOSIT_USDS_FOR_SUSDS: true,
  MINT_SUSDS_WITH_USDS: true,
  REDEEM_USDS_FOR_USDC: true,
  REDEEM_SUSDS_FOR_USDS: true,
  WITHDRAW_USDS_FROM_SUSDS: true,
  RECOVER_CROSS_CHAIN_TRANSFER: true,
};
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UTC_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export function computeExecutionPlanId(
  steps: readonly TransactionRequest[],
  requirements: ExecutorRequirements,
  quoteExpiresAt?: string,
): string {
  const canonical = JSON.stringify({
    requirements,
    ...(quoteExpiresAt === undefined ? {} : { quoteExpiresAt }),
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

export function validateAddress(value: unknown, field: string): Result<Address, ValidationError> {
  if (typeof value !== 'string' || !isAddress(value)) {
    return err(ValidationError.forField(field, `${field} must be a valid EVM address`));
  }
  return ok(getAddress(value));
}

export function validatePositiveUint256(
  value: unknown,
  field: string,
): Result<bigint, ValidationError> {
  if (typeof value !== 'bigint' || value <= 0n || value > UINT256_MAX) {
    return err(
      ValidationError.forField(field, `${field} must be a positive bigint within uint256`),
    );
  }
  return ok(value);
}

export function validateConfirmations(value: unknown): Result<number, ValidationError> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return err(
      ValidationError.forField('confirmations', 'confirmations must be a positive safe integer'),
    );
  }
  return ok(value);
}

export function validateQuoteExpiry(
  value: unknown,
  field = 'plan.quoteExpiresAt',
): Result<QuoteExpiry, ValidationError> {
  if (typeof value !== 'string') {
    return err(ValidationError.forField(field, `${field} must be a valid UTC instant`));
  }
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return err(ValidationError.forField(field, `${field} must be a valid UTC instant`));
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const instant = new Date(0);
  instant.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  instant.setUTCHours(
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0').slice(0, 3)),
  );
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.getUTCFullYear() !== Number(year) ||
    instant.getUTCMonth() !== Number(month) - 1 ||
    instant.getUTCDate() !== Number(day) ||
    instant.getUTCHours() !== Number(hour) ||
    instant.getUTCMinutes() !== Number(minute) ||
    instant.getUTCSeconds() !== Number(second)
  ) {
    return err(ValidationError.forField(field, `${field} must be a valid UTC instant`));
  }
  return ok(value as QuoteExpiry);
}

export function validateTransactionRequest(
  transaction: TransactionRequest,
  field = 'transaction',
): Result<TransactionRequest, ValidationError> {
  if (
    typeof transaction !== 'object' ||
    transaction === null ||
    transaction.__typename !== 'TransactionRequest'
  ) {
    return err(ValidationError.forField(field, `${field} must be a TransactionRequest object`));
  }
  if (typeof transaction.id !== 'string' || !IDENTIFIER_PATTERN.test(transaction.id)) {
    return err(
      ValidationError.forField(`${field}.id`, `${field}.id must be a stable ASCII identifier`),
    );
  }
  if (!Number.isSafeInteger(transaction.chainId) || transaction.chainId <= 0) {
    return err(
      ValidationError.forField(
        `${field}.chainId`,
        `${field}.chainId must be a positive safe integer`,
      ),
    );
  }

  const from = validateAddress(transaction.from, `${field}.from`);
  if (from.isErr()) return err(from.error);
  const to = validateAddress(transaction.to, `${field}.to`);
  if (to.isErr()) return err(to.error);

  if (typeof transaction.data !== 'string' || !HEX_BYTES_PATTERN.test(transaction.data)) {
    return err(
      ValidationError.forField(
        `${field}.data`,
        `${field}.data must be a 0x-prefixed, byte-aligned hex string`,
      ),
    );
  }
  if (
    typeof transaction.value !== 'bigint' ||
    transaction.value < 0n ||
    transaction.value > UINT256_MAX
  ) {
    return err(
      ValidationError.forField(
        `${field}.value`,
        `${field}.value must be a non-negative bigint within uint256`,
      ),
    );
  }
  if (
    typeof transaction.operation !== 'string' ||
    !Object.hasOwn(OPERATIONS, transaction.operation)
  ) {
    return err(
      ValidationError.forField(`${field}.operation`, `${field}.operation is not recognized`),
    );
  }

  if (transaction.authorization !== undefined) {
    const integrity = validateApprovalIntegrity(transaction, field);
    if (integrity.isErr()) return err(integrity.error);
  } else if (transaction.operation === 'APPROVE_ERC20') {
    return err(
      ValidationError.forField(
        `${field}.authorization`,
        'ERC-20 approval steps require explicit authorization metadata',
      ),
    );
  }

  if (transaction.estimatedGas !== undefined) {
    if (
      typeof transaction.estimatedGas !== 'object' ||
      transaction.estimatedGas === null ||
      typeof transaction.estimatedGas.gas !== 'bigint' ||
      transaction.estimatedGas.gas <= 0n
    ) {
      return err(
        ValidationError.forField(
          `${field}.estimatedGas.gas`,
          'estimated gas must be a positive bigint',
        ),
      );
    }
    if (
      transaction.estimatedGas.source !== 'hosted-api' &&
      transaction.estimatedGas.source !== 'local-simulation'
    ) {
      return err(
        ValidationError.forField(
          `${field}.estimatedGas.source`,
          'estimated gas source is not recognized',
        ),
      );
    }
  }

  return ok({
    ...transaction,
    from: from.value,
    to: to.value,
    data: transaction.data as Hex,
  });
}

function validateApprovalIntegrity(
  transaction: TransactionRequest,
  field: string,
): Result<void, ValidationError> {
  const authorization = transaction.authorization;
  if (
    typeof authorization !== 'object' ||
    authorization === null ||
    authorization.kind !== 'erc20-approval'
  ) {
    return err(
      ValidationError.forField(
        `${field}.authorization`,
        'authorization kind must be erc20-approval',
      ),
    );
  }
  const token = validateAddress(authorization.token, `${field}.authorization.token`);
  if (token.isErr()) return err(token.error);
  const owner = validateAddress(authorization.owner, `${field}.authorization.owner`);
  if (owner.isErr()) return err(owner.error);
  const spender = validateAddress(authorization.spender, `${field}.authorization.spender`);
  if (spender.isErr()) return err(spender.error);
  const amount = validatePositiveUint256(authorization.amount, `${field}.authorization.amount`);
  if (amount.isErr()) return err(amount.error);

  if (transaction.operation !== 'APPROVE_ERC20') {
    return err(
      ValidationError.forField(
        `${field}.operation`,
        'an ERC-20 authorization must use the APPROVE_ERC20 operation',
      ),
    );
  }
  if (transaction.value !== 0n) {
    return err(
      ValidationError.forField(`${field}.value`, 'an ERC-20 approval must have zero native value'),
    );
  }
  if (getAddress(transaction.to) !== token.value || getAddress(transaction.from) !== owner.value) {
    return err(
      ValidationError.forField(
        `${field}.authorization`,
        'approval token and owner metadata must match transaction to/from',
      ),
    );
  }

  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data });
    if (
      decoded.functionName !== 'approve' ||
      decoded.args[0] === undefined ||
      decoded.args[1] === undefined ||
      getAddress(decoded.args[0]) !== spender.value ||
      decoded.args[1] !== amount.value
    ) {
      return err(
        ValidationError.forField(
          `${field}.data`,
          'approval calldata must encode approve(spender, amount) matching authorization metadata',
        ),
      );
    }
  } catch (cause) {
    return err(
      new ValidationError(
        'approval calldata is not a valid ERC-20 approve call',
        `${field}.data`,
        undefined,
        { cause },
      ),
    );
  }

  return ok(undefined);
}

export function validateExecutionPlan(plan: ExecutionPlan): Result<ExecutionPlan, ValidationError> {
  if (
    typeof plan !== 'object' ||
    plan === null ||
    plan.__typename !== 'ExecutionPlan' ||
    (plan.version !== 1 && plan.version !== 2)
  ) {
    return err(ValidationError.forField('plan', 'plan must be a supported ExecutionPlan'));
  }
  if (typeof plan.id !== 'string' || !IDENTIFIER_PATTERN.test(plan.id)) {
    return err(ValidationError.forField('plan.id', 'plan.id must be a stable ASCII identifier'));
  }
  if (plan.version === 1 && plan.quoteExpiresAt !== undefined) {
    return err(
      ValidationError.forField('plan.quoteExpiresAt', 'version 1 plans cannot carry quote expiry'),
    );
  }
  if (plan.version === 2 && plan.quoteExpiresAt === undefined) {
    return err(
      ValidationError.forField('plan.quoteExpiresAt', 'version 2 plans require quote expiry'),
    );
  }
  if (plan.quoteExpiresAt !== undefined) {
    const expiry = validateQuoteExpiry(plan.quoteExpiresAt);
    if (expiry.isErr()) return err(expiry.error);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return err(ValidationError.forField('plan.steps', 'plan must contain at least one step'));
  }
  if (
    typeof plan.requirements !== 'object' ||
    plan.requirements === null ||
    (plan.requirements.execution !== 'sequential' &&
      plan.requirements.execution !== 'atomic-batch') ||
    (plan.requirements.authorization !== 'transactions' &&
      plan.requirements.authorization !== 'permit') ||
    typeof plan.requirements.sponsored !== 'boolean' ||
    typeof plan.requirements.chainTransitions !== 'boolean'
  ) {
    return err(ValidationError.forField('plan.requirements', 'plan requirements are malformed'));
  }
  if (typeof plan.metadata !== 'object' || plan.metadata === null) {
    return err(ValidationError.forField('plan.metadata', 'plan metadata must be an object'));
  }
  if (
    plan.metadata.source !== 'local' &&
    plan.metadata.source !== 'hosted-api' &&
    plan.metadata.source !== 'custom'
  ) {
    return err(ValidationError.forField('plan.metadata.source', 'plan source is not recognized'));
  }

  const ids = new Set<string>();
  const steps: TransactionRequest[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const validated = validateTransactionRequest(step, `plan.steps[${index}]`);
    if (validated.isErr()) return err(validated.error);
    if (ids.has(validated.value.id)) {
      return err(
        ValidationError.forField(
          `plan.steps[${index}].id`,
          `duplicate execution step id: ${validated.value.id}`,
        ),
      );
    }
    ids.add(validated.value.id);
    steps.push(validated.value);
  }

  const expectedAccount = getAddress(steps[0]!.from);
  const expectedChainId = steps[0]!.chainId;
  for (const [index, step] of steps.entries()) {
    if (getAddress(step.from) !== expectedAccount) {
      return err(
        ValidationError.forField(
          `plan.steps[${index}].from`,
          'mixed-account execution plans are not supported',
        ),
      );
    }
    if (step.chainId !== expectedChainId && !plan.requirements.chainTransitions) {
      return err(
        ValidationError.forField(
          `plan.steps[${index}].chainId`,
          'mixed-chain execution plans require an explicit chain-transition capability',
        ),
      );
    }
  }

  if (
    plan.version === 2 &&
    computeExecutionPlanId(steps, plan.requirements, plan.quoteExpiresAt) !== plan.id
  ) {
    return err(
      ValidationError.forField('plan.id', 'plan id does not match its transaction contents'),
    );
  }

  return ok({ ...plan, steps });
}

export function validateExecutorBinding(
  plan: ExecutionPlan,
  account: Address,
  chainId: number,
): Result<ExecutionPlan, AccountMismatchError | ChainMismatchError | ValidationError> {
  const validated = validateExecutionPlan(plan);
  if (validated.isErr()) return err(validated.error);
  const executorAccount = validateAddress(account, 'executor.account');
  if (executorAccount.isErr()) return err(executorAccount.error);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return err(
      ValidationError.forField('executor.chainId', 'executor chainId must be a positive integer'),
    );
  }

  const first = validated.value.steps[0]!;
  const expectedAccount = getAddress(first.from);
  if (expectedAccount !== executorAccount.value) {
    return err(new AccountMismatchError(expectedAccount, executorAccount.value));
  }
  if (first.chainId !== chainId) {
    return err(new ChainMismatchError(first.chainId, chainId));
  }
  return ok(validated.value);
}

export function validateResumeState(
  plan: ExecutionPlan,
  resume: ExecutionResumeState | undefined,
): Result<readonly ConfirmedTransaction[], ValidationError> {
  if (resume === undefined) return ok([]);
  if (
    typeof resume !== 'object' ||
    resume === null ||
    typeof resume.planId !== 'string' ||
    !Array.isArray(resume.confirmed)
  ) {
    return err(ValidationError.forField('resume', 'resume state is malformed'));
  }
  if (resume.planId !== plan.id) {
    return err(
      ValidationError.forField(
        'resume.planId',
        'resume state belongs to a different execution plan',
      ),
    );
  }
  if (resume.confirmed.length > plan.steps.length) {
    return err(
      ValidationError.forField(
        'resume.confirmed',
        'resume state contains too many confirmed steps',
      ),
    );
  }

  for (const [index, transaction] of resume.confirmed.entries()) {
    const step = plan.steps[index];
    if (
      step === undefined ||
      typeof transaction !== 'object' ||
      transaction === null ||
      typeof transaction.confirmation !== 'object' ||
      transaction.confirmation === null ||
      transaction.planId !== plan.id ||
      transaction.stepId !== step.id ||
      transaction.stepIndex !== index ||
      transaction.operation !== step.operation ||
      transaction.confirmation.status !== 'success' ||
      typeof transaction.hash !== 'string' ||
      typeof transaction.submittedHash !== 'string' ||
      typeof transaction.confirmation.transactionHash !== 'string' ||
      !HASH_PATTERN.test(transaction.hash) ||
      !HASH_PATTERN.test(transaction.submittedHash) ||
      transaction.confirmation.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()
    ) {
      return err(
        ValidationError.forField(
          `resume.confirmed[${index}]`,
          'resume state must be an ordered, confirmed prefix matching the plan',
        ),
      );
    }
  }
  return ok(resume.confirmed);
}
