import {
  CancelError,
  InsufficientBalanceError,
  OseroError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
} from './errors.js';

describe('Osero errors', () => {
  it('every concrete error extends OseroError', () => {
    const errors = [
      new CancelError('x'),
      new SigningError('x'),
      new TransactionError('x', { txHash: '0xabcd' }),
      new ValidationError('x', { field: 'amount' }),
      new UnsupportedChainError(999),
      new InsufficientBalanceError({
        token: '0x0000000000000000000000000000000000000000',
        required: 1n,
        available: 0n,
      }),
      new UnexpectedError('x'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(OseroError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('every error has a distinct, descriptive name', () => {
    expect(new CancelError('x').name).toBe('CancelError');
    expect(new SigningError('x').name).toBe('SigningError');
    expect(new TransactionError('x', { txHash: '0xabcd' }).name).toBe('TransactionError');
    expect(new ValidationError('x', {}).name).toBe('ValidationError');
    expect(new UnsupportedChainError(1).name).toBe('UnsupportedChainError');
    expect(
      new InsufficientBalanceError({
        token: '0x0000000000000000000000000000000000000000',
        required: 1n,
        available: 0n,
      }).name,
    ).toBe('InsufficientBalanceError');
    expect(new UnexpectedError('x').name).toBe('UnexpectedError');
  });

  describe('CancelError.from', () => {
    it('extracts the message from a plain Error', () => {
      const original = new Error('user cancelled');
      const err = CancelError.from(original);
      expect(err.message).toBe('user cancelled');
      expect(err.cause).toBe(original);
    });

    it('falls back to the default message for non-Error causes', () => {
      const err = CancelError.from({ anything: 42 });
      expect(err.message).toBe('The user cancelled the request');
      expect(err.cause).toEqual({ anything: 42 });
    });
  });

  describe('UnexpectedError.from', () => {
    it('short-circuits when passed an existing UnexpectedError', () => {
      const original = new UnexpectedError('boom');
      expect(UnexpectedError.from(original)).toBe(original);
    });

    it('wraps any other error', () => {
      const err = UnexpectedError.from(new Error('rpc down'));
      expect(err).toBeInstanceOf(UnexpectedError);
      expect(err.message).toBe('rpc down');
    });
  });

  describe('ValidationError.forField', () => {
    it('tags the context with the offending field', () => {
      const err = ValidationError.forField('amount', 'must be > 0');
      expect(err.context.field).toBe('amount');
      expect(err.message).toBe('must be > 0');
    });
  });

  describe('TransactionError', () => {
    it('exposes the tx hash and optional explorer link', () => {
      const err = TransactionError.from({
        txHash: '0xdeadbeef',
        link: 'https://etherscan.io/tx/0xdeadbeef',
      });
      expect(err.txHash).toBe('0xdeadbeef');
      expect(err.link).toBe('https://etherscan.io/tx/0xdeadbeef');
    });
  });

  describe('UnsupportedChainError', () => {
    it('captures the unsupported chain ID', () => {
      const err = new UnsupportedChainError(9999);
      expect(err.chainId).toBe(9999);
      expect(err.message).toContain('9999');
    });
  });
});
