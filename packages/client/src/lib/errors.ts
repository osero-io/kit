import type { Address, Hex } from 'viem';

export type ExecutionStage =
  | 'preflight'
  | 'simulation'
  | 'signing'
  | 'broadcast'
  | 'confirmation'
  | 'replacement'
  | 'revert'
  | 'progress';

export type CompletedExecutionStep = {
  readonly planId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly operation: string;
  readonly hash: Hex;
};

export type ExecutionFailureContext = {
  readonly planId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly operation: string;
  readonly stage: ExecutionStage;
  readonly hash?: Hex;
  readonly completed: readonly CompletedExecutionStep[];
};

export type OseroErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'UNSUPPORTED_CHAIN'
  | 'ACCOUNT_MISMATCH'
  | 'CHAIN_MISMATCH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'CANCELLED'
  | 'SIMULATION_FAILED'
  | 'SIGNING_FAILED'
  | 'BROADCAST_FAILED'
  | 'CONFIRMATION_FAILED'
  | 'TRANSACTION_REVERTED'
  | 'RPC_REQUEST_FAILED'
  | 'API_REQUEST_FAILED'
  | 'API_TRANSPORT_FAILED'
  | 'API_RESPONSE_INVALID'
  | 'TIMEOUT'
  | 'PROGRESS_CALLBACK_FAILED'
  | 'UNEXPECTED_ERROR';

function extractMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function serialize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: serialize(value.cause) }),
    };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serialize(nested)]),
    );
  }
  return value;
}

/** Base class for every stable, public SDK error. */
export abstract class OseroError<Code extends OseroErrorCode = OseroErrorCode> extends Error {
  abstract override readonly name: string;
  abstract readonly code: Code;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    const fields = Object.fromEntries(
      Object.entries(this)
        .filter(([key]) => key !== 'name' && key !== 'code')
        .map(([key, value]) => [key, serialize(value)]),
    );
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.cause === undefined ? {} : { cause: serialize(this.cause) }),
      ...fields,
    };
  }
}

export class ValidationError extends OseroError<'VALIDATION_ERROR'> {
  override readonly name = 'ValidationError' as const;
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(
    message: string,
    readonly field: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  static forField(
    field: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): ValidationError {
    return new ValidationError(message, field, details);
  }
}

export class ConfigurationError extends OseroError<'CONFIGURATION_ERROR'> {
  override readonly name = 'ConfigurationError' as const;
  readonly code = 'CONFIGURATION_ERROR' as const;

  constructor(
    message: string,
    readonly field?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class UnsupportedChainError extends OseroError<'UNSUPPORTED_CHAIN'> {
  override readonly name = 'UnsupportedChainError' as const;
  readonly code = 'UNSUPPORTED_CHAIN' as const;

  constructor(readonly chainId: number) {
    super(`Chain ${chainId} is not supported by this operation`);
  }
}

export class AccountMismatchError extends OseroError<'ACCOUNT_MISMATCH'> {
  override readonly name = 'AccountMismatchError' as const;
  readonly code = 'ACCOUNT_MISMATCH' as const;

  constructor(
    readonly expectedAccount: Address,
    readonly actualAccount: Address,
    readonly execution?: ExecutionFailureContext,
  ) {
    super(`Executor account ${actualAccount} does not match plan account ${expectedAccount}`);
  }
}

export class ChainMismatchError extends OseroError<'CHAIN_MISMATCH'> {
  override readonly name = 'ChainMismatchError' as const;
  readonly code = 'CHAIN_MISMATCH' as const;

  constructor(
    readonly expectedChainId: number,
    readonly actualChainId: number,
    readonly execution?: ExecutionFailureContext,
  ) {
    super(`Executor chain ${actualChainId} does not match plan chain ${expectedChainId}`);
  }
}

export class UnsupportedCapabilityError extends OseroError<'UNSUPPORTED_CAPABILITY'> {
  override readonly name = 'UnsupportedCapabilityError' as const;
  readonly code = 'UNSUPPORTED_CAPABILITY' as const;

  constructor(
    readonly capability: string,
    readonly executor: string,
  ) {
    super(`${executor} does not support required capability: ${capability}`);
  }
}

export class InsufficientAllowanceError extends OseroError<'INSUFFICIENT_ALLOWANCE'> {
  override readonly name = 'InsufficientAllowanceError' as const;
  readonly code = 'INSUFFICIENT_ALLOWANCE' as const;

  constructor(
    readonly token: Address,
    readonly owner: Address,
    readonly spender: Address,
    readonly required: bigint,
    readonly allowance: bigint,
  ) {
    super(
      `Allowance ${allowance} for ${token} is below required amount ${required} for spender ${spender}`,
    );
  }
}

abstract class ExecutionError<Code extends OseroErrorCode> extends OseroError<Code> {
  constructor(
    message: string,
    readonly execution?: ExecutionFailureContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ProgressCallbackError extends ExecutionError<'PROGRESS_CALLBACK_FAILED'> {
  override readonly name = 'ProgressCallbackError' as const;
  readonly code = 'PROGRESS_CALLBACK_FAILED' as const;

  static from(cause: unknown, execution: ExecutionFailureContext): ProgressCallbackError {
    return new ProgressCallbackError(
      extractMessage(cause, 'Execution progress callback failed'),
      execution,
      { cause },
    );
  }
}

export class CancelError extends ExecutionError<'CANCELLED'> {
  override readonly name = 'CancelError' as const;
  readonly code = 'CANCELLED' as const;

  static from(cause: unknown, execution?: ExecutionFailureContext): CancelError {
    return new CancelError(extractMessage(cause, 'Operation was cancelled'), execution, { cause });
  }
}

export class SimulationError extends ExecutionError<'SIMULATION_FAILED'> {
  override readonly name = 'SimulationError' as const;
  readonly code = 'SIMULATION_FAILED' as const;

  static from(cause: unknown, execution?: ExecutionFailureContext): SimulationError {
    return new SimulationError(extractMessage(cause, 'Transaction simulation failed'), execution, {
      cause,
    });
  }
}

export class SigningError extends ExecutionError<'SIGNING_FAILED'> {
  override readonly name = 'SigningError' as const;
  readonly code = 'SIGNING_FAILED' as const;

  static from(cause: unknown, execution?: ExecutionFailureContext): SigningError {
    return new SigningError(extractMessage(cause, 'Transaction signing failed'), execution, {
      cause,
    });
  }
}

export class BroadcastError extends ExecutionError<'BROADCAST_FAILED'> {
  override readonly name = 'BroadcastError' as const;
  readonly code = 'BROADCAST_FAILED' as const;

  static from(cause: unknown, execution?: ExecutionFailureContext): BroadcastError {
    return new BroadcastError(extractMessage(cause, 'Transaction broadcast failed'), execution, {
      cause,
    });
  }
}

export class ConfirmationError extends ExecutionError<'CONFIRMATION_FAILED'> {
  override readonly name = 'ConfirmationError' as const;
  readonly code = 'CONFIRMATION_FAILED' as const;

  static from(cause: unknown, execution: ExecutionFailureContext): ConfirmationError {
    return new ConfirmationError(
      extractMessage(cause, 'Transaction confirmation failed'),
      execution,
      { cause },
    );
  }
}

export class TransactionError extends ExecutionError<'TRANSACTION_REVERTED'> {
  override readonly name = 'TransactionError' as const;
  readonly code = 'TRANSACTION_REVERTED' as const;

  constructor(
    message: string,
    readonly txHash: Hex,
    execution?: ExecutionFailureContext,
    options?: ErrorOptions,
  ) {
    super(message, execution, options);
  }
}

export class RpcError extends OseroError<'RPC_REQUEST_FAILED'> {
  override readonly name = 'RpcError' as const;
  readonly code = 'RPC_REQUEST_FAILED' as const;

  static from(args: {
    readonly cause: unknown;
    readonly operation: string;
    readonly chainId: number;
    readonly contract?: Address;
    readonly functionName?: string;
  }): RpcError {
    return new RpcError({
      ...args,
      message: extractMessage(args.cause, `RPC ${args.operation} failed`),
    });
  }

  constructor(args: {
    readonly message: string;
    readonly operation: string;
    readonly chainId: number;
    readonly contract?: Address;
    readonly functionName?: string;
    readonly cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.operation = args.operation;
    this.chainId = args.chainId;
    this.contract = args.contract;
    this.functionName = args.functionName;
  }

  readonly operation: string;
  readonly chainId: number;
  readonly contract?: Address;
  readonly functionName?: string;
}

export const OSERO_API_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'QUOTE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type OseroApiErrorCode = (typeof OSERO_API_ERROR_CODES)[number] | (string & {});

export class ApiRequestError extends OseroError<'API_REQUEST_FAILED'> {
  override readonly name = 'ApiRequestError' as const;
  readonly code = 'API_REQUEST_FAILED' as const;

  constructor(args: {
    readonly url: string;
    readonly method: string;
    readonly statusCode: number;
    readonly statusText: string;
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>>;
    readonly apiCode?: OseroApiErrorCode;
    readonly correlationId?: string;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  }) {
    super(
      `Osero API ${args.method} ${args.url} failed with ${args.statusCode} ${args.statusText}`,
      { cause: args.cause },
    );
    Object.assign(this, args);
  }

  readonly url!: string;
  readonly method!: string;
  readonly statusCode!: number;
  readonly statusText!: string;
  readonly body!: unknown;
  readonly headers!: Readonly<Record<string, string>>;
  readonly apiCode?: OseroApiErrorCode;
  readonly correlationId?: string;
  readonly retryAfterMs?: number;
}

export class ApiTransportError extends OseroError<'API_TRANSPORT_FAILED'> {
  override readonly name = 'ApiTransportError' as const;
  readonly code = 'API_TRANSPORT_FAILED' as const;

  static from(cause: unknown, url: string, method: string): ApiTransportError {
    return new ApiTransportError(
      extractMessage(cause, `Osero API ${method} ${url} failed before receiving a response`),
      url,
      method,
      { cause },
    );
  }

  constructor(
    message: string,
    readonly url: string,
    readonly method: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ApiResponseError extends OseroError<'API_RESPONSE_INVALID'> {
  override readonly name = 'ApiResponseError' as const;
  readonly code = 'API_RESPONSE_INVALID' as const;

  static from(cause: unknown, url: string, method: string): ApiResponseError {
    return new ApiResponseError(
      extractMessage(cause, `Osero API ${method} ${url} returned an invalid response`),
      url,
      method,
      { cause },
    );
  }

  constructor(
    message: string,
    readonly url: string,
    readonly method: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class TimeoutError extends OseroError<'TIMEOUT'> {
  override readonly name = 'TimeoutError' as const;
  readonly code = 'TIMEOUT' as const;

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
  }
}

export class UnexpectedError extends OseroError<'UNEXPECTED_ERROR'> {
  override readonly name = 'UnexpectedError' as const;
  readonly code = 'UNEXPECTED_ERROR' as const;

  static from(cause: unknown): UnexpectedError {
    return new UnexpectedError(extractMessage(cause, 'An unexpected SDK error occurred'), {
      cause,
    });
  }
}
