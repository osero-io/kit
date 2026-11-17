import {
  AccountMismatchError,
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  ApprovalLimitError,
  BroadcastError,
  CancelError,
  ChainMismatchError,
  ConfirmationError,
  ConfigurationError,
  InsufficientAllowanceError,
  ProgressCallbackError,
  QuoteExpiredError,
  QuoteRefreshLimitError,
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
  type OseroErrorCode,
} from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import type { SendWithError } from './types.js';

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

// F05: `error.code` is a literal discriminant on every concrete class, so a union of SDK errors
// narrows to one class per `case`. Everything below is checked by `tsc` (the typecheck task
// includes test files): widening or dropping any member's literal `code` breaks the build.

/** Every concrete public error class, keyed by the literal `code` it declares. */
type PublicErrorByCode = {
  readonly VALIDATION_ERROR: ValidationError;
  readonly CONFIGURATION_ERROR: ConfigurationError;
  readonly UNSUPPORTED_CHAIN: UnsupportedChainError;
  readonly ACCOUNT_MISMATCH: AccountMismatchError;
  readonly CHAIN_MISMATCH: ChainMismatchError;
  readonly UNSUPPORTED_CAPABILITY: UnsupportedCapabilityError;
  readonly INSUFFICIENT_ALLOWANCE: InsufficientAllowanceError;
  readonly QUOTE_EXPIRED: QuoteExpiredError;
  readonly CANCELLED: CancelError;
  readonly SIMULATION_FAILED: SimulationError;
  readonly SIGNING_FAILED: SigningError;
  readonly BROADCAST_FAILED: BroadcastError;
  readonly CONFIRMATION_FAILED: ConfirmationError;
  readonly TRANSACTION_REVERTED: TransactionError;
  readonly RPC_REQUEST_FAILED: RpcError;
  readonly API_REQUEST_FAILED: ApiRequestError;
  readonly API_TRANSPORT_FAILED: ApiTransportError;
  readonly API_RESPONSE_INVALID: ApiResponseError;
  readonly TIMEOUT: TimeoutError;
  readonly PROGRESS_CALLBACK_FAILED: ProgressCallbackError;
  readonly APPROVAL_LIMIT_EXCEEDED: ApprovalLimitError;
  readonly QUOTE_REFRESH_LIMIT_EXCEEDED: QuoteRefreshLimitError;
  readonly UNEXPECTED_ERROR: UnexpectedError;
};

type PublicError = PublicErrorByCode[keyof PublicErrorByCode];

type SendWithErrorClass = { readonly prototype: SendWithError };

/**
 * Narrows `SendWithError` on `error.code` alone. Each branch asserts the exact class the
 * compiler narrowed to, and `default` only compiles while the switch is exhaustive.
 */
function sendWithErrorClassFor(error: SendWithError): SendWithErrorClass {
  switch (error.code) {
    case 'VALIDATION_ERROR':
      expectTypeOf(error).toEqualTypeOf<ValidationError>();
      return ValidationError;
    case 'CONFIGURATION_ERROR':
      expectTypeOf(error).toEqualTypeOf<ConfigurationError>();
      return ConfigurationError;
    case 'ACCOUNT_MISMATCH':
      expectTypeOf(error).toEqualTypeOf<AccountMismatchError>();
      return AccountMismatchError;
    case 'CHAIN_MISMATCH':
      expectTypeOf(error).toEqualTypeOf<ChainMismatchError>();
      return ChainMismatchError;
    case 'UNSUPPORTED_CAPABILITY':
      expectTypeOf(error).toEqualTypeOf<UnsupportedCapabilityError>();
      return UnsupportedCapabilityError;
    case 'QUOTE_EXPIRED':
      expectTypeOf(error).toEqualTypeOf<QuoteExpiredError>();
      return QuoteExpiredError;
    case 'CANCELLED':
      expectTypeOf(error).toEqualTypeOf<CancelError>();
      return CancelError;
    case 'SIMULATION_FAILED':
      expectTypeOf(error).toEqualTypeOf<SimulationError>();
      return SimulationError;
    case 'SIGNING_FAILED':
      expectTypeOf(error).toEqualTypeOf<SigningError>();
      return SigningError;
    case 'BROADCAST_FAILED':
      expectTypeOf(error).toEqualTypeOf<BroadcastError>();
      return BroadcastError;
    case 'CONFIRMATION_FAILED':
      expectTypeOf(error).toEqualTypeOf<ConfirmationError>();
      return ConfirmationError;
    case 'TRANSACTION_REVERTED':
      expectTypeOf(error).toEqualTypeOf<TransactionError>();
      return TransactionError;
    case 'PROGRESS_CALLBACK_FAILED':
      expectTypeOf(error).toEqualTypeOf<ProgressCallbackError>();
      return ProgressCallbackError;
    case 'RPC_REQUEST_FAILED':
      expectTypeOf(error).toEqualTypeOf<RpcError>();
      return RpcError;
    case 'UNEXPECTED_ERROR':
      expectTypeOf(error).toEqualTypeOf<UnexpectedError>();
      return UnexpectedError;
    default: {
      const exhausted: never = error;
      return exhausted;
    }
  }
}

describe('error code narrowing', () => {
  it('narrows SendWithError to one concrete class per code in an exhaustive switch', () => {
    const plan = expiringPlan();
    const cause = new Error('provider failure');
    const errors: readonly SendWithError[] = [
      new ValidationError('invalid', 'amount'),
      new ConfigurationError('missing transport', 'transport'),
      new AccountMismatchError(ACCOUNT, OTHER_ACCOUNT),
      new ChainMismatchError(1, 8453),
      new UnsupportedCapabilityError('atomic-batch', 'viem'),
      new QuoteExpiredError(plan, plan.quoteExpiresAt!),
      new CancelError('cancelled'),
      new SimulationError('simulation'),
      new SigningError('signing'),
      new BroadcastError('broadcast'),
      new ConfirmationError('confirmation', EXECUTION),
      new TransactionError('reverted', HASH),
      ProgressCallbackError.from(cause, EXECUTION),
      RpcError.from({ cause, operation: 'readContract', chainId: 8453 }),
      UnexpectedError.from(cause),
    ];

    const classes = errors.map((error) => sendWithErrorClassFor(error));

    for (const [index, error] of errors.entries()) {
      expect(error).toBeInstanceOf(classes[index]);
      expect(error.constructor).toBe(classes[index]);
    }
    expect(new Set(classes).size).toBe(errors.length);
    expectTypeOf<SendWithError['code']>().toEqualTypeOf<
      | 'VALIDATION_ERROR'
      | 'CONFIGURATION_ERROR'
      | 'ACCOUNT_MISMATCH'
      | 'CHAIN_MISMATCH'
      | 'UNSUPPORTED_CAPABILITY'
      | 'QUOTE_EXPIRED'
      | 'CANCELLED'
      | 'SIMULATION_FAILED'
      | 'SIGNING_FAILED'
      | 'BROADCAST_FAILED'
      | 'CONFIRMATION_FAILED'
      | 'TRANSACTION_REVERTED'
      | 'PROGRESS_CALLBACK_FAILED'
      | 'RPC_REQUEST_FAILED'
      | 'UNEXPECTED_ERROR'
    >();
  });

  it('maps every public error code to exactly one concrete class at compile time', () => {
    expectTypeOf<PublicError['code']>().toEqualTypeOf<OseroErrorCode>();
    expectTypeOf<keyof PublicErrorByCode>().toEqualTypeOf<OseroErrorCode>();
    expectTypeOf<{
      readonly [Code in OseroErrorCode]: Extract<PublicError, { readonly code: Code }>;
    }>().toEqualTypeOf<PublicErrorByCode>();
    expectTypeOf<{
      readonly [Code in OseroErrorCode]: PublicErrorByCode[Code]['code'];
    }>().toEqualTypeOf<{ readonly [Code in OseroErrorCode]: Code }>();
    expectTypeOf<SendWithError>().toExtend<PublicError>();
  });
});
