import type { Address, Hex } from 'viem';

function extractMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return fallback;
}

/**
 * Base class for every error produced by the Osero SDK.
 *
 * All SDK errors are instances of {@link OseroError} and expose a unique
 * {@link OseroError.name | name} that can be used to discriminate them
 * inside a `switch` after `.isErr()`.
 */
export abstract class OseroError extends Error {}

/**
 * Raised when the user cancels a signing or approval prompt in their wallet.
 */
export class CancelError extends OseroError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CancelError';
  }

  static from(cause: unknown): CancelError {
    return new CancelError(extractMessage(cause, 'The user cancelled the request'), { cause });
  }
}

/**
 * Raised when the wallet fails to sign a message or transaction for any
 * reason other than an explicit cancellation.
 */
export class SigningError extends OseroError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SigningError';
  }

  static from(cause: unknown): SigningError {
    return new SigningError(extractMessage(cause, 'Failed to sign the request'), { cause });
  }
}

/**
 * Raised when a transaction is submitted but reverts or is otherwise
 * rejected by the network.
 */
export class TransactionError extends OseroError {
  readonly txHash: Hex;
  readonly link?: string;

  constructor(message: string, options: ErrorOptions & { txHash: Hex; link?: string }) {
    super(message, { cause: options.cause });
    this.name = 'TransactionError';
    this.txHash = options.txHash;
    this.link = options.link;
  }

  static from(params: {
    txHash: Hex;
    link?: string;
    cause?: unknown;
    message?: string;
  }): TransactionError {
    const message =
      params.message ?? extractMessage(params.cause, `Transaction ${params.txHash} reverted`);
    return new TransactionError(message, {
      txHash: params.txHash,
      link: params.link,
      cause: params.cause,
    });
  }
}

/**
 * Raised when user-supplied input is invalid (amount <= 0, unknown token,
 * out-of-range slippage, etc.). The optional {@link ValidationError.field}
 * identifies the input field that failed validation.
 */
export class ValidationError<Context = unknown> extends OseroError {
  readonly context: Context;

  constructor(message: string, context: Context, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ValidationError';
    this.context = context;
  }

  static forField(field: string, message: string): ValidationError<{ field: string }> {
    return new ValidationError(message, { field });
  }
}

/**
 * Raised when the caller targets a chain that is not listed in the
 * {@link CHAINS} registry.
 */
export class UnsupportedChainError extends OseroError {
  readonly chainId: number;

  constructor(chainId: number, message?: string) {
    super(message ?? `Chain ${chainId} is not supported by @osero/client`);
    this.name = 'UnsupportedChainError';
    this.chainId = chainId;
  }
}

/**
 * Raised when the caller's on-chain balance is not enough to cover an
 * action. Produced by previews and sanity checks that happen before the
 * transaction is broadcast.
 */
export class InsufficientBalanceError extends OseroError {
  readonly token: Address;
  readonly required: bigint;
  readonly available: bigint;

  constructor(params: { token: Address; required: bigint; available: bigint; message?: string }) {
    super(
      params.message ??
        `Insufficient balance of ${params.token}: required ${params.required}, available ${params.available}`,
    );
    this.name = 'InsufficientBalanceError';
    this.token = params.token;
    this.required = params.required;
    this.available = params.available;
  }
}

/**
 * Raised for any error that does not fit the other, more specific
 * categories — typically an RPC failure, a network timeout, or an
 * unforeseen runtime exception. Always wraps the underlying error in
 * {@link Error.cause | cause}.
 */
export class UnexpectedError extends OseroError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnexpectedError';
  }

  static from(cause: unknown): UnexpectedError {
    if (cause instanceof UnexpectedError) return cause;
    return new UnexpectedError(extractMessage(cause, 'An unexpected error occurred'), { cause });
  }
}
