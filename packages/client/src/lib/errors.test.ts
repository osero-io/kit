import {
  AccountMismatchError,
  ApiRequestError,
  BroadcastError,
  CancelError,
  ChainMismatchError,
  ConfirmationError,
  ConfigurationError,
  InsufficientAllowanceError,
  ProgressCallbackError,
  QuoteExpiredError,
  RpcError,
  SigningError,
  SimulationError,
  TimeoutError,
  TransactionError,
  UnexpectedError,
  UnsupportedCapabilityError,
  UnsupportedChainError,
  ValidationError,
  type ExecutionFailureContext,
  type OseroError,
} from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222' as const;
const HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const QUOTE_EXPIRES_AT = '2026-07-22T20:00:00Z';
const EXECUTION: ExecutionFailureContext = {
  planId: 'plan-abc',
  stepId: 'swap',
  stepIndex: 1,
  operation: 'SWAP_EXACT_IN',
  stage: 'confirmation',
  hash: HASH,
  completed: [
    {
      planId: 'plan-abc',
      stepId: 'approve',
      stepIndex: 0,
      operation: 'APPROVE_ERC20',
      hash: HASH,
    },
  ],
};

function expiringPlan() {
  const step = createTransactionRequest({
    id: 'swap',
    chainId: 8453,
    from: ACCOUNT,
    to: OTHER_ACCOUNT,
    data: '0x1234',
    operation: 'SWAP_EXACT_IN',
  });
  if (step.isErr()) throw step.error;
  const plan = createExecutionPlan({
    steps: [step.value],
    quoteExpiresAt: QUOTE_EXPIRES_AT,
  });
  if (plan.isErr()) throw plan.error;
  return plan.value;
}

describe('public error discriminants', () => {
  it('uses stable code and name pairs across validation, preflight, and execution stages', () => {
    const plan = expiringPlan();
    const errors: readonly OseroError[] = [
      new ValidationError('invalid', 'amount'),
      new ConfigurationError('missing transport', 'transport'),
      new UnsupportedChainError(137),
      new AccountMismatchError(ACCOUNT, OTHER_ACCOUNT),
      new ChainMismatchError(1, 8453),
      new UnsupportedCapabilityError('atomic-batch', 'viem'),
      new InsufficientAllowanceError(ACCOUNT, ACCOUNT, OTHER_ACCOUNT, 2n, 1n),
      new QuoteExpiredError(plan, plan.quoteExpiresAt!),
      new CancelError('cancelled'),
      new SimulationError('simulation'),
      new SigningError('signing'),
      new BroadcastError('broadcast'),
      new ConfirmationError('confirmation', EXECUTION),
      new TransactionError('reverted', HASH),
      new TimeoutError('poll', 1_000),
      UnexpectedError.from(new Error('unexpected')),
    ];

    expect(new Set(errors.map((error) => error.code)).size).toBe(errors.length);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toMatch(/Error$/);
      expect(error.code).toMatch(/^[A-Z_]+$/);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it('reports the expired plan and its quote expiry', () => {
    const plan = expiringPlan();

    const error = new QuoteExpiredError(plan, plan.quoteExpiresAt!);

    expect(error.code).toBe('QUOTE_EXPIRED');
    expect(error.plan).toBe(plan);
    expect(error.quoteExpiresAt).toBe(QUOTE_EXPIRES_AT);
  });

  it('preserves field and structured details on validation failures', () => {
    const error = ValidationError.forField('amount', 'must be positive', {
      minimum: 1n,
      received: 0n,
    });

    expect(error.field).toBe('amount');
    expect(error.details).toEqual({ minimum: 1n, received: 0n });
    expect(error.toJSON()).toMatchObject({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      field: 'amount',
      details: { minimum: '1', received: '0' },
    });
  });

  it('serializes causes, bigint fields, and recovery context without losing hashes', () => {
    const cause = new Error('receipt unavailable', { cause: new Error('upstream timeout') });
    const error = ConfirmationError.from(cause, EXECUTION);

    expect(error.cause).toBe(cause);
    expect(error.execution).toEqual(EXECUTION);
    expect(error.toJSON()).toEqual(
      expect.objectContaining({
        code: 'CONFIRMATION_FAILED',
        execution: expect.objectContaining({
          planId: 'plan-abc',
          hash: HASH,
          completed: [expect.objectContaining({ stepId: 'approve', hash: HASH })],
        }),
        cause: {
          name: 'Error',
          message: 'receipt unavailable',
          cause: { name: 'Error', message: 'upstream timeout' },
        },
      }),
    );
  });

  it('keeps insufficient allowance integers machine-readable and JSON-safe', () => {
    const error = new InsufficientAllowanceError(ACCOUNT, ACCOUNT, OTHER_ACCOUNT, 10n, 3n);

    expect(error.required).toBe(10n);
    expect(error.allowance).toBe(3n);
    expect(error.toJSON()).toMatchObject({ required: '10', allowance: '3' });
    expect(() => JSON.stringify(error)).not.toThrow();
  });

  it('preserves authoritative HTTP metadata on API request failures', () => {
    const error = new ApiRequestError({
      url: 'https://api.osero.org/v1/swap/quote',
      method: 'POST',
      statusCode: 429,
      statusText: 'Too Many Requests',
      body: { code: 'RATE_LIMITED' },
      headers: { 'retry-after': '2' },
      apiCode: 'RATE_LIMITED',
      correlationId: 'corr-1',
      retryAfterMs: 2_000,
    });

    expect(error.code).toBe('API_REQUEST_FAILED');
    expect(error.apiCode).toBe('RATE_LIMITED');
    expect(error.correlationId).toBe('corr-1');
    expect(error.retryAfterMs).toBe(2_000);
  });

  it('maps stage causes into truthful error classes', () => {
    const cause = new Error('provider failure');
    const errors = [
      CancelError.from(cause, EXECUTION),
      SimulationError.from(cause, EXECUTION),
      SigningError.from(cause, EXECUTION),
      BroadcastError.from(cause, EXECUTION),
      ProgressCallbackError.from(cause, EXECUTION),
      RpcError.from({ cause, operation: 'readContract', chainId: 8453 }),
      UnexpectedError.from(cause),
    ] as const;

    expect(errors.map((error) => error.code)).toEqual([
      'CANCELLED',
      'SIMULATION_FAILED',
      'SIGNING_FAILED',
      'BROADCAST_FAILED',
      'PROGRESS_CALLBACK_FAILED',
      'RPC_REQUEST_FAILED',
      'UNEXPECTED_ERROR',
    ]);
    for (const error of errors) expect(error.cause).toBe(cause);
  });
});
