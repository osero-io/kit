import { readFileSync } from 'node:fs';

import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi as fullErc20Abi,
  getAddress,
  type Hex,
} from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { toCompletedExecutionStep } from './adapters.js';
import {
  BroadcastError,
  CancelError,
  ConfirmationError,
  ProgressCallbackError,
  QuoteExpiredError,
  SigningError,
  SimulationError,
  TransactionError,
  UnexpectedError,
  ValidationError,
  type ExecutionFailureContext,
} from './errors.js';
import {
  createApprovalTransaction,
  createExecutionPlan,
  createPreparedApprovalTransaction,
  createTransactionRequest,
  deserializeExecutionPlan,
  deserializeExecutionResumeState,
  executionResumeStateFromError,
  resumeExecutionPlan,
  serializeExecutionPlan,
  serializeExecutionResumeState,
} from './plan.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutionResumeState,
  TransactionRequest,
} from './types.js';
import { computeExecutionPlanId, validateExecutionPlan } from './validation.js';

const ACCOUNT_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const ACCOUNT = getAddress(ACCOUNT_LOWER);
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const TARGET = '0x3333333333333333333333333333333333333333' as const;
const TOKEN = '0x4444444444444444444444444444444444444444' as const;
const HASH = `0x${'a'.repeat(64)}` as const;

function transaction(id: string, overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  const result = createTransactionRequest({
    id,
    chainId: 8453,
    from: ACCOUNT,
    to: TARGET,
    data: '0x1234',
    value: 99n,
    operation: 'SWAP_EXACT_IN',
    ...overrides,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

function confirmed(planId: string, step: TransactionRequest, index: number): ConfirmedTransaction {
  return {
    planId,
    stepId: step.id,
    stepIndex: index,
    operation: step.operation,
    submittedHash: HASH,
    hash: HASH,
    confirmation: {
      status: 'success',
      transactionHash: HASH,
      blockNumber: 123n,
      gasUsed: 42n,
      effectiveGasPrice: 7n,
      confirmations: 2,
    },
  };
}

describe('transaction construction', () => {
  it('validates every executable field without throwing', () => {
    const malformed = [
      { field: 'id', value: '' },
      { field: 'chainId', value: 1.5 },
      { field: 'from', value: '0x1234' },
      { field: 'to', value: '0x1234' },
      { field: 'data', value: '0x123' },
      { field: 'value', value: -1n },
      { field: 'operation', value: 'UNKNOWN' },
    ] as const;

    for (const sample of malformed) {
      const result = createTransactionRequest({
        id: 'step',
        chainId: 1,
        from: ACCOUNT,
        to: TARGET,
        data: '0x',
        operation: 'SWAP_EXACT_IN',
        [sample.field]: sample.value,
      } as never);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    }
    expect(createTransactionRequest(null as never).isErr()).toBe(true);
  });

  it('builds a self-describing ERC-20 approval and validates its calldata', () => {
    const result = createApprovalTransaction({
      id: 'approve-token',
      chainId: 8453,
      owner: ACCOUNT,
      token: TOKEN,
      spender: TARGET,
      amount: 123n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: result.value.data });
      expect(decoded).toEqual({ functionName: 'approve', args: [TARGET, 123n] });
      expect(result.value.authorization).toEqual({
        kind: 'erc20-approval',
        token: TOKEN,
        owner: ACCOUNT,
        spender: TARGET,
        amount: 123n,
      });
    }
  });

  it('validates an authoritative prepared approval without regenerating its calldata', () => {
    const calldata = createApprovalTransaction({
      id: 'source',
      chainId: 8453,
      owner: ACCOUNT,
      token: TOKEN,
      spender: TARGET,
      amount: 123n,
    });
    if (calldata.isErr()) throw calldata.error;

    const result = createPreparedApprovalTransaction({
      id: 'prepared',
      chainId: 8453,
      sender: ACCOUNT,
      recipient: TOKEN,
      calldata: calldata.value.data,
      value: 0n,
      token: TOKEN,
      spender: TARGET,
      requiredAmount: 123n,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.data).toBe(calldata.value.data);
  });
});

describe('approval calldata integrity', () => {
  const AMOUNT = 5n;
  const canonical = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [TARGET, AMOUNT],
  });

  function prepared(
    overrides: Partial<Parameters<typeof createPreparedApprovalTransaction>[0]> = {},
  ) {
    return createPreparedApprovalTransaction({
      id: 'approve',
      chainId: 8453,
      sender: ACCOUNT,
      recipient: TOKEN,
      calldata: canonical,
      value: 0n,
      token: TOKEN,
      spender: TARGET,
      requiredAmount: AMOUNT,
      ...overrides,
    });
  }

  it('accepts the canonical encoding with upper-case argument hex', () => {
    // viem matches the 4-byte selector case-sensitively, so only the arguments vary in case.
    const upper = `${canonical.slice(0, 10)}${canonical.slice(10).toUpperCase()}` as Hex;

    expect(prepared().isOk()).toBe(true);
    expect(prepared({ calldata: upper }).isOk()).toBe(true);
  });

  it.each([
    ['one trailing byte', { calldata: `${canonical}00` as Hex }, 'transaction.data'],
    [
      'a trailing 32-byte word',
      { calldata: `${canonical}${'00'.repeat(32)}` as Hex },
      'transaction.data',
    ],
    [
      'a trailing word that looks like a second amount',
      { calldata: `${canonical}${'ff'.repeat(32)}` as Hex },
      'transaction.data',
    ],
    ['truncated calldata', { calldata: canonical.slice(0, -2) as Hex }, 'transaction.data'],
    [
      'an ERC-20 transfer selector',
      {
        calldata: encodeFunctionData({
          abi: fullErc20Abi,
          functionName: 'transfer',
          args: [TARGET, AMOUNT],
        }),
      },
      'transaction.data',
    ],
    [
      'a calldata amount that differs from the authorized amount',
      {
        calldata: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [TARGET, AMOUNT + 1n],
        }),
      },
      'transaction.data',
    ],
    [
      'a calldata spender that differs from the authorized spender',
      {
        calldata: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [OTHER_ACCOUNT, AMOUNT],
        }),
      },
      'transaction.data',
    ],
    ['a recipient that is not the token', { recipient: TARGET }, 'transaction.authorization'],
    ['native value', { value: 1n }, 'transaction.value'],
  ])('rejects a prepared approval with %s', (_name, overrides, field) => {
    const result = prepared(overrides);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.field).toBe(field);
    }
  });

  it('rejects non-canonical approval calldata in custom, serialized, and resumed plans', () => {
    const approval = prepared();
    if (approval.isErr()) throw approval.error;
    const padded = { ...approval.value, data: `${canonical}00` as Hex };

    const custom = createExecutionPlan({ steps: [padded] });
    const valid = createExecutionPlan({ steps: [approval.value] });
    if (valid.isErr()) throw valid.error;
    const serialized = serializeExecutionPlan(valid.value);
    if (serialized.isErr()) throw serialized.error;
    const tampered = deserializeExecutionPlan(
      serialized.value.replace(canonical, `${canonical}00`),
    );
    const resumed = resumeExecutionPlan({ ...valid.value, steps: [padded] });
    const directlySerialized = serializeExecutionPlan({ ...valid.value, steps: [padded] });

    for (const result of [custom, tampered, resumed, directlySerialized]) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.field).toMatch(/steps\[0\]\.data$/);
      }
    }
  });
});

describe('flat execution plans', () => {
  it('assigns a deterministic identity to ordered steps and requirements', () => {
    const steps = [transaction('one'), transaction('two', { data: '0xabcd' })];
    const first = createExecutionPlan({ steps });
    const second = createExecutionPlan({ steps });
    const batch = createExecutionPlan({
      steps,
      requirements: {
        execution: 'atomic-batch',
        authorization: 'transactions',
        sponsored: false,
        chainTransitions: false,
      },
    });

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(batch.isOk()).toBe(true);
    if (first.isOk() && second.isOk() && batch.isOk()) {
      expect(first.value.id).toBe(second.value.id);
      expect(batch.value.id).not.toBe(first.value.id);
      expect(first.value.steps).toEqual(steps);
    }
  });

  it('rejects duplicate IDs, mixed accounts, and unmodelled mixed chains', () => {
    const duplicate = createExecutionPlan({ steps: [transaction('same'), transaction('same')] });
    const mixedAccount = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { from: OTHER_ACCOUNT })],
    });
    const mixedChain = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { chainId: 10 })],
    });
    const modelledTransition = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { chainId: 10 })],
      requirements: {
        execution: 'sequential',
        authorization: 'transactions',
        sponsored: false,
        chainTransitions: true,
      },
    });

    expect(duplicate.isErr()).toBe(true);
    expect(mixedAccount.isErr()).toBe(true);
    expect(mixedChain.isErr()).toBe(true);
    expect(modelledTransition.isOk()).toBe(true);
  });

  it('treats checksum-equivalent sender spellings as one account', () => {
    const result = createExecutionPlan({
      steps: [transaction('one'), transaction('two', { from: ACCOUNT_LOWER })],
    });
    expect(result.isOk()).toBe(true);
  });

  it('preserves validation and resume behavior for expiry-free plans with custom identities', () => {
    const plan = createExecutionPlan({ steps: [transaction('one')] });
    if (plan.isErr()) throw plan.error;
    const customIdentity = { ...plan.value, id: 'plan-expiring-custom-id' };

    const result = resumeExecutionPlan(customIdentity);

    expect(result.isOk()).toBe(true);
  });

  it('validates quote expiry and includes it in plan identity', () => {
    const steps = [transaction('one')];
    const first = createExecutionPlan({
      steps,
      quoteExpiresAt: '2026-07-22T20:00:00.000Z',
    });
    const refreshed = createExecutionPlan({
      steps,
      quoteExpiresAt: '2026-07-22T20:01:00.000Z',
    });
    const malformed = createExecutionPlan({
      steps,
      quoteExpiresAt: 'tomorrow',
    });

    expect(first.isOk()).toBe(true);
    expect(refreshed.isOk()).toBe(true);
    expect(malformed.isErr()).toBe(true);
    if (first.isOk() && refreshed.isOk()) {
      expect(first.value.version).toBe(2);
      expect(first.value.quoteExpiresAt).toBe('2026-07-22T20:00:00.000Z');
      expect(refreshed.value.id).not.toBe(first.value.id);
    }
    if (malformed.isErr()) expect(malformed.error.field).toBe('plan.quoteExpiresAt');
  });
});

describe('canonical persistence and recovery', () => {
  it('round-trips bigint, hex, estimates, and approval metadata exactly', () => {
    const approval = createApprovalTransaction({
      id: 'approve',
      chainId: 8453,
      owner: ACCOUNT,
      token: TOKEN,
      spender: TARGET,
      amount: 2n ** 255n,
      estimatedGas: { gas: 21_000n, source: 'hosted-api' },
    });
    if (approval.isErr()) throw approval.error;
    const plan = createExecutionPlan({
      steps: [approval.value, transaction('swap')],
      quoteExpiresAt: '2026-07-22T20:00:00Z',
      metadata: {
        source: 'hosted-api',
        allowanceSnapshots: [
          {
            token: TOKEN,
            owner: ACCOUNT,
            spender: TARGET,
            allowance: 0n,
            requiredAmount: 2n ** 255n,
            approvalAmount: 2n ** 255n,
            policy: 'exact',
            observedAtBlock: 999n,
          },
        ],
      },
    });
    if (plan.isErr()) throw plan.error;

    const serialized = serializeExecutionPlan(plan.value);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isOk()) {
      const restored = deserializeExecutionPlan(serialized.value);
      expect(restored).toEqual(plan);
    }
  });

  it('rejects tampered serialized plans', () => {
    const plan = createExecutionPlan({ steps: [transaction('one')] });
    if (plan.isErr()) throw plan.error;
    const serialized = serializeExecutionPlan(plan.value);
    if (serialized.isErr()) throw serialized.error;
    const tampered = serialized.value.replace('0x1234', '0xabcd');

    const result = deserializeExecutionPlan(tampered);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.field).toBe('plan.id');
  });

  it('rejects malformed or identity-detached serialized quote expiry', () => {
    const plan = createExecutionPlan({ steps: [transaction('one')] });
    if (plan.isErr()) throw plan.error;
    const serialized = serializeExecutionPlan(plan.value);
    if (serialized.isErr()) throw serialized.error;
    const parsed = JSON.parse(serialized.value) as Record<string, unknown>;

    const malformed = deserializeExecutionPlan(
      JSON.stringify({ ...parsed, quoteExpiresAt: '2026-02-30T12:00:00Z' }),
    );
    const detached = deserializeExecutionPlan(
      JSON.stringify({ ...parsed, quoteExpiresAt: '2026-07-22T20:00:00Z' }),
    );

    expect(malformed.isErr()).toBe(true);
    if (malformed.isErr()) expect(malformed.error.field).toBe('plan.quoteExpiresAt');
    expect(detached.isErr()).toBe(true);
    if (detached.isErr()) expect(detached.error.field).toBe('plan.quoteExpiresAt');
  });

  it('refuses to serialize quote expiry detached from plan identity', () => {
    const plan = createExecutionPlan({
      steps: [transaction('one')],
      quoteExpiresAt: '2026-07-22T20:00:00Z',
    });
    const refreshed = createExecutionPlan({
      steps: [transaction('one')],
      quoteExpiresAt: '2026-07-22T20:01:00Z',
    });
    if (plan.isErr() || refreshed.isErr()) throw new Error('test plan failed');
    if (plan.value.version !== 2 || refreshed.value.version !== 2) {
      throw new Error('test plan is not expiry-constrained');
    }

    const result = serializeExecutionPlan({
      ...plan.value,
      quoteExpiresAt: refreshed.value.quoteExpiresAt,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.field).toBe('plan.id');
  });

  it('rejects a version 2 plan after its quote expiry is removed', () => {
    const plan = createExecutionPlan({
      steps: [transaction('one')],
      quoteExpiresAt: '2026-07-22T20:00:00Z',
    });
    if (plan.isErr()) throw plan.error;
    const detached = { ...plan.value, quoteExpiresAt: undefined } as unknown as ExecutionPlan;

    const serialized = serializeExecutionPlan(detached);
    const resumed = resumeExecutionPlan(detached);

    expect(serialized.isErr()).toBe(true);
    if (serialized.isErr()) expect(serialized.error.field).toBe('plan.quoteExpiresAt');
    expect(resumed.isErr()).toBe(true);
    if (resumed.isErr()) expect(resumed.error.field).toBe('plan.quoteExpiresAt');
  });

  it('resumes only an ordered prefix proven confirmed', () => {
    const plan = createExecutionPlan({ steps: [transaction('one'), transaction('two')] });
    if (plan.isErr()) throw plan.error;
    const first = confirmed(plan.value.id, plan.value.steps[0]!, 0);

    const resumed = resumeExecutionPlan(plan.value, {
      planId: plan.value.id,
      confirmed: [first],
    });
    const skippedSecond = resumeExecutionPlan(plan.value, {
      planId: plan.value.id,
      confirmed: [{ ...confirmed(plan.value.id, plan.value.steps[1]!, 1), stepIndex: 1 }],
    });

    expect(resumed.isOk()).toBe(true);
    if (resumed.isOk()) {
      expect(resumed.value.confirmed).toEqual([first]);
      expect(resumed.value.pending.map((step) => step.id)).toEqual(['two']);
    }
    expect(skippedSecond.isErr()).toBe(true);
  });
});

const OTHER_HASH = `0x${'b'.repeat(64)}` as const;

function twoStepPlanWithState(): {
  readonly plan: ExecutionPlan;
  readonly state: ExecutionResumeState;
} {
  const plan = createExecutionPlan({ steps: [transaction('one'), transaction('two')] });
  if (plan.isErr()) throw plan.error;
  const first: ConfirmedTransaction = {
    ...confirmed(plan.value.id, plan.value.steps[0]!, 0),
    submittedHash: OTHER_HASH,
    replacement: { reason: 'repriced', originalHash: OTHER_HASH, replacementHash: HASH },
    confirmation: {
      status: 'success',
      transactionHash: HASH,
      blockNumber: 2n ** 70n,
      gasUsed: 2n ** 65n + 1n,
      effectiveGasPrice: 0n,
      confirmations: 3,
    },
  };
  return { plan: plan.value, state: { planId: plan.value.id, confirmed: [first] } };
}

describe('resume state persistence', () => {
  it('round-trips resume state exactly, including bigints beyond the safe integer range', () => {
    const { plan, state } = twoStepPlanWithState();

    const serialized = serializeExecutionResumeState(state);

    expect(serialized.isOk()).toBe(true);
    if (serialized.isErr()) return;
    expect(serialized.value).toContain(`{"$bigint":"${(2n ** 70n).toString()}"}`);
    expect(() => JSON.parse(serialized.value)).not.toThrow();
    const restored = deserializeExecutionResumeState(serialized.value);
    expect(restored.isOk()).toBe(true);
    if (restored.isErr()) return;
    expect(restored.value).toEqual(state);
    expect(typeof restored.value.confirmed[0]?.confirmation.blockNumber).toBe('bigint');
    // The restored state is accepted for the plan it belongs to.
    const resumed = resumeExecutionPlan(plan, restored.value);
    expect(resumed.isOk()).toBe(true);
    if (resumed.isOk()) expect(resumed.value.pending.map((step) => step.id)).toEqual(['two']);
  });

  it('round-trips an empty confirmed prefix', () => {
    const { state } = twoStepPlanWithState();
    const empty = { planId: state.planId, confirmed: [] };

    const serialized = serializeExecutionResumeState(empty);

    expect(serialized.isOk()).toBe(true);
    if (serialized.isOk()) {
      expect(deserializeExecutionResumeState(serialized.value)).toEqual(
        serializeExecutionResumeState(empty).map(() => empty),
      );
    }
  });

  it.each([
    [
      'an entry for another plan',
      (entry: Record<string, unknown>) => (entry.planId = 'plan-other'),
    ],
    ['an out-of-order step index', (entry: Record<string, unknown>) => (entry.stepIndex = 1)],
    ['an unknown operation', (entry: Record<string, unknown>) => (entry.operation = 'DRAIN')],
    ['a malformed hash', (entry: Record<string, unknown>) => (entry.hash = '0x1234')],
    [
      'a reverted confirmation',
      (entry: Record<string, unknown>) =>
        ((entry.confirmation as Record<string, unknown>).status = 'reverted'),
    ],
    [
      'a confirmation for another hash',
      (entry: Record<string, unknown>) =>
        ((entry.confirmation as Record<string, unknown>).transactionHash = OTHER_HASH),
    ],
    [
      'zero confirmations',
      (entry: Record<string, unknown>) =>
        ((entry.confirmation as Record<string, unknown>).confirmations = 0),
    ],
    [
      'a block number that is not a bigint',
      (entry: Record<string, unknown>) =>
        ((entry.confirmation as Record<string, unknown>).blockNumber = 12),
    ],
    [
      'replacement data that does not link the hashes',
      (entry: Record<string, unknown>) =>
        ((entry.replacement as Record<string, unknown>).originalHash = HASH),
    ],
    ['a missing confirmation', (entry: Record<string, unknown>) => delete entry.confirmation],
  ])('rejects tampered serialized resume state with %s', (_name, tamper) => {
    const { state } = twoStepPlanWithState();
    const serialized = serializeExecutionResumeState(state);
    if (serialized.isErr()) throw serialized.error;
    const parsed = JSON.parse(serialized.value) as { confirmed: Record<string, unknown>[] };
    tamper(parsed.confirmed[0]!);

    const result = deserializeExecutionResumeState(JSON.stringify(parsed));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.field).toBe('resume.confirmed[0]');
    }
  });

  it.each([
    ['an empty string', ''],
    ['text that is not JSON', '{not json'],
    ['a JSON scalar', '7'],
    ['a state without a confirmed list', '{"planId":"plan-x"}'],
    ['a state with a malformed plan id', '{"planId":"","confirmed":[]}'],
  ])('rejects %s as serialized resume state', (_name, serialized) => {
    const result = deserializeExecutionResumeState(serialized);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('refuses to serialize malformed resume state', () => {
    const { state } = twoStepPlanWithState();

    expect(serializeExecutionResumeState(null as never).isErr()).toBe(true);
    expect(
      serializeExecutionResumeState({
        ...state,
        confirmed: [{ ...state.confirmed[0]!, hash: '0x12' as never }],
      }).isErr(),
    ).toBe(true);
  });

  it('leaves plan matching to resume: a well-formed state for another plan is rejected there', () => {
    const { state } = twoStepPlanWithState();
    const other = createExecutionPlan({ steps: [transaction('one', { data: '0xbeef' })] });
    if (other.isErr()) throw other.error;
    const serialized = serializeExecutionResumeState(state);
    if (serialized.isErr()) throw serialized.error;
    const restored = deserializeExecutionResumeState(serialized.value);
    if (restored.isErr()) throw restored.error;

    const resumed = resumeExecutionPlan(other.value, restored.value);

    expect(resumed.isErr()).toBe(true);
    if (resumed.isErr()) expect(resumed.error.field).toBe('resume.planId');
  });
});

function failureContextFor(
  plan: ExecutionPlan,
  completed: ExecutionFailureContext['completed'],
): ExecutionFailureContext {
  const step = plan.steps[completed.length]!;
  return {
    planId: plan.id,
    stepId: step.id,
    stepIndex: completed.length,
    operation: step.operation,
    stage: 'confirmation',
    hash: OTHER_HASH,
    completed,
  };
}

const cancelledError = (context: ExecutionFailureContext) =>
  CancelError.from(Object.assign(new Error('user rejected'), { code: 4001 }), context);
const abortedError = (context: ExecutionFailureContext) =>
  CancelError.from(new Error('Request was aborted.'), context);
const signingError = (context: ExecutionFailureContext) =>
  SigningError.from(new Error('wallet error'), context);
const broadcastError = (context: ExecutionFailureContext) =>
  BroadcastError.from(new Error('rpc timeout'), context);
const confirmationError = (context: ExecutionFailureContext) =>
  new ConfirmationError('receipt timeout', context);
const simulationError = (context: ExecutionFailureContext) =>
  SimulationError.from(new Error('estimate failed'), context);
const revertedError = (context: ExecutionFailureContext) =>
  new TransactionError('reverted', OTHER_HASH, context);
const progressError = (context: ExecutionFailureContext) =>
  ProgressCallbackError.from(new Error('callback failed'), context);

describe('resume state from a failed execution', () => {
  it('derives state that resume accepts from a failure carrying confirmations', () => {
    const { plan, state } = twoStepPlanWithState();
    const error = new TransactionError('step two reverted', OTHER_HASH, {
      ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
      stage: 'revert',
    });

    const derived = executionResumeStateFromError(plan, error);

    expect(derived.isOk()).toBe(true);
    if (derived.isErr()) return;
    expect(derived.value).toEqual(state);
    expect(resumeExecutionPlan(plan, derived.value).isOk()).toBe(true);
  });

  describe('when the failed step may already have been submitted', () => {
    it.each([
      ['a receipt wait that timed out', 'confirmation', confirmationError, { hash: OTHER_HASH }],
      [
        'an EIP-5792 batch whose status never arrived',
        'confirmation',
        confirmationError,
        { batchId: 'batch-7' },
      ],
      ['a replaced transaction', 'replacement', confirmationError, { hash: OTHER_HASH }],
      ['a broadcast that failed without a hash', 'broadcast', broadcastError, {}],
      ['a signing failure that was not a user rejection', 'signing', signingError, {}],
      ['a cancellation that was a client-side abort', 'signing', abortedError, {}],
      ['a stage this SDK release does not know', 'future-stage', confirmationError, {}],
    ] as const)('refuses %s by default and names what to check', (_name, stage, build, extra) => {
      const { plan, state } = twoStepPlanWithState();
      const context = {
        ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
        hash: undefined,
        ...extra,
        stage,
      } as unknown as ExecutionFailureContext;
      const error = build(context);

      const refused = executionResumeStateFromError(plan, error);
      const explicit = executionResumeStateFromError(plan, error, { unresolvedStep: 'reject' });
      const acknowledged = executionResumeStateFromError(plan, error, {
        unresolvedStep: 'assume-not-executed',
      });

      for (const result of [refused, explicit]) {
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.field).toBe('error.execution.stage');
          expect(result.error.details).toMatchObject({
            stage,
            stepId: 'two',
            stepIndex: 1,
            ...extra,
          });
          expect(result.error.message).toContain("unresolvedStep: 'assume-not-executed'");
        }
      }
      // Acknowledging returns the confirmed prefix: resuming would send step two again.
      expect(acknowledged.isOk()).toBe(true);
      if (acknowledged.isOk()) expect(acknowledged.value).toEqual(state);
    });

    it.each([
      ['a quote that expired before the step was sent', 'preflight', confirmationError],
      ['a failed gas estimate', 'simulation', simulationError],
      ['a user rejection', 'signing', cancelledError],
      ['a mined transaction that reverted', 'revert', revertedError],
      ['a progress callback that failed before submission', 'progress', progressError],
    ] as const)('derives state without acknowledgement for %s', (_name, stage, build) => {
      const { plan, state } = twoStepPlanWithState();
      const error = build({
        ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
        stage,
      });

      const derived = executionResumeStateFromError(plan, error);

      expect(derived.isOk()).toBe(true);
      if (derived.isOk()) expect(derived.value).toEqual(state);
    });

    it.each([
      ['EIP-1193 code 4001', { code: 4001 }],
      ['EIP-5792 code 5750', { code: 5750 }],
      ['ethers ACTION_REJECTED', { code: 'ACTION_REJECTED' }],
      ['a rejection nested in a wrapper error', { cause: { code: 4001 } }],
    ])('treats a cancellation carrying %s as an explicit wallet refusal', (_name, evidence) => {
      const { plan, state } = twoStepPlanWithState();
      const error = CancelError.from(Object.assign(new Error('rejected'), evidence), {
        ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
        stage: 'signing',
      });

      expect(executionResumeStateFromError(plan, error).isOk()).toBe(true);
    });

    it('does not loop on a cancellation whose cause chain is circular', () => {
      const { plan, state } = twoStepPlanWithState();
      const loop: { cause?: unknown } = {};
      loop.cause = loop;
      const error = CancelError.from(Object.assign(new Error('aborted'), loop), {
        ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
        stage: 'signing',
      });

      expect(executionResumeStateFromError(plan, error).isErr()).toBe(true);
    });

    it('derives state when the failing step is itself among the completed steps', () => {
      const { plan, state } = twoStepPlanWithState();
      // A progress callback that failed after its step confirmed names that step.
      const error = new ConfirmationError('reported after confirmation', {
        ...failureContextFor(plan, state.confirmed.map(toCompletedExecutionStep)),
        stepId: 'one',
        stepIndex: 0,
      });

      expect(executionResumeStateFromError(plan, error).isOk()).toBe(true);
    });

    it.each([
      ['a non-object', 'yes'],
      ['null', null],
      ['an unknown choice', { unresolvedStep: 'always' }],
    ])('rejects %s as options', (_name, options) => {
      const { plan } = twoStepPlanWithState();
      const error = new ConfirmationError('receipt timeout', failureContextFor(plan, []));

      const result = executionResumeStateFromError(plan, error, options as never);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.field).toMatch(/^options/);
    });
  });

  it('derives an empty prefix when the first step failed', () => {
    const { plan } = twoStepPlanWithState();
    const error = SimulationError.from(new Error('estimate failed'), {
      ...failureContextFor(plan, []),
      stage: 'simulation',
    });

    const derived = executionResumeStateFromError(plan, error);

    expect(derived.isOk()).toBe(true);
    if (derived.isOk()) expect(derived.value).toEqual({ planId: plan.id, confirmed: [] });
  });

  it('derives state from a quote expiry that happened mid-plan', () => {
    const expiring = createExecutionPlan({
      steps: [transaction('one'), transaction('two')],
      quoteExpiresAt: '2026-07-22T20:00:00Z',
    });
    if (expiring.isErr() || expiring.value.version !== 2) throw new Error('test plan failed');
    const first = confirmed(expiring.value.id, expiring.value.steps[0]!, 0);
    const error = new QuoteExpiredError(expiring.value, expiring.value.quoteExpiresAt, {
      ...failureContextFor(expiring.value, [toCompletedExecutionStep(first)]),
      stage: 'preflight',
    });

    const derived = executionResumeStateFromError(expiring.value, error);

    expect(derived.isOk()).toBe(true);
    if (derived.isOk()) expect(derived.value.confirmed).toEqual([first]);
  });

  it('refuses to guess when a completed step carries no confirmation data', () => {
    const { plan, state } = twoStepPlanWithState();
    const first = state.confirmed[0]!;
    // The shape a custom executor, or an SDK release before 1.1.0, reports.
    const legacy = {
      planId: first.planId,
      stepId: first.stepId,
      stepIndex: first.stepIndex,
      operation: first.operation,
      hash: first.hash,
    };
    const error = new ConfirmationError('receipt timeout', failureContextFor(plan, [legacy]));

    const derived = executionResumeStateFromError(plan, error);

    expect(derived.isErr()).toBe(true);
    if (derived.isErr()) expect(derived.error.field).toBe('error.execution.completed[0]');
  });

  it('rejects an error without execution context, for another plan, or with a mismatched prefix', () => {
    const { plan, state } = twoStepPlanWithState();
    const other = createExecutionPlan({ steps: [transaction('one', { data: '0xbeef' })] });
    if (other.isErr()) throw other.error;
    const completed = state.confirmed.map(toCompletedExecutionStep);

    const noContext = executionResumeStateFromError(
      plan,
      UnexpectedError.from(new Error('defect')),
    );
    const validation = executionResumeStateFromError(
      plan,
      ValidationError.forField('plan', 'malformed'),
    );
    const otherPlan = executionResumeStateFromError(
      other.value,
      new ConfirmationError('receipt timeout', failureContextFor(plan, completed)),
    );
    const mismatched = executionResumeStateFromError(
      plan,
      new ConfirmationError(
        'receipt timeout',
        failureContextFor(plan, [{ ...completed[0]!, stepId: 'two' }]),
      ),
    );
    const malformedPlan = executionResumeStateFromError(
      null as never,
      new ConfirmationError('receipt timeout', failureContextFor(plan, completed)),
    );

    expect(noContext.isErr() && noContext.error.field).toBe('error.execution');
    expect(validation.isErr() && validation.error.field).toBe('error.execution');
    expect(otherPlan.isErr() && otherPlan.error.field).toBe('error.execution.planId');
    expect(mismatched.isErr() && mismatched.error.field).toBe('resume.confirmed[0]');
    expect(malformedPlan.isErr() && malformedPlan.error.field).toBe('plan');
  });
});

/**
 * Plans serialized by the published 1.0.1 build (origin/main @ 2392165). The
 * file is generated once from that build and must never be regenerated: it
 * proves that plans persisted by an earlier release keep deserializing,
 * validating, and hashing to the same identity.
 */
const FROZEN_PLANS = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/execution-plans.v1_0_1.json', import.meta.url),
    'utf8',
  ),
) as {
  readonly plans: readonly {
    readonly name: string;
    readonly version: 1 | 2;
    readonly id: string;
    readonly serialized: string;
  }[];
};

describe('plan identity frozen at 1.0.1', () => {
  it('covers one version 1 plan and one version 2 plan with quote expiry', () => {
    expect(FROZEN_PLANS.plans.map((plan) => plan.version)).toEqual([1, 2]);
    expect(FROZEN_PLANS.plans[1]?.serialized).toContain('"quoteExpiresAt"');
  });

  it.each(FROZEN_PLANS.plans)(
    'deserializes, validates, and re-identifies the $name plan identically',
    ({ id, serialized, version }) => {
      const restored = deserializeExecutionPlan(serialized);

      expect(restored.isOk()).toBe(true);
      if (restored.isErr()) return;
      const plan = restored.value;
      expect(plan.version).toBe(version);
      expect(plan.id).toBe(id);
      expect(computeExecutionPlanId(plan.steps, plan.requirements, plan.quoteExpiresAt)).toBe(id);
      expect(validateExecutionPlan(plan).isOk()).toBe(true);

      // Rebuilding the plan from its parts through the public constructor yields the same identity.
      const rebuilt = createExecutionPlan({
        steps: plan.steps,
        requirements: plan.requirements,
        metadata: plan.metadata,
        ...(plan.quoteExpiresAt === undefined ? {} : { quoteExpiresAt: plan.quoteExpiresAt }),
      });
      expect(rebuilt.isOk()).toBe(true);
      if (rebuilt.isOk()) {
        expect(rebuilt.value.id).toBe(id);
        expect(rebuilt.value.version).toBe(version);
      }

      // The serialization format itself is byte-stable.
      const reserialized = serializeExecutionPlan(plan);
      expect(reserialized.isOk()).toBe(true);
      if (reserialized.isOk()) expect(reserialized.value).toBe(serialized);
    },
  );
});
