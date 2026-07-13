import { parseSlippage, referral, tokenAmount, UINT256_MAX } from './domain.js';
import { ValidationError } from './errors.js';

describe('domain value constructors', () => {
  it.each(['-1', '1e2', '.5', '10000.1', '', ' 5'])(
    'rejects malformed or out-of-range slippage %j',
    (value) => {
      const result = parseSlippage(value);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error).toBeInstanceOf(ValidationError);
    },
  );

  it('preserves decimal basis-point precision in the branded value', () => {
    const result = parseSlippage('0.125');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.bps).toBe('0.125');
  });

  it('validates token symbol and positive uint256 amount boundaries', () => {
    const valid = tokenAmount('USDC', UINT256_MAX);
    const unknown = tokenAmount('DAI' as never, 1n);
    const zero = tokenAmount('USDC', 0n);
    const overflow = tokenAmount('USDC', UINT256_MAX + 1n);

    expect(valid.isOk()).toBe(true);
    expect(unknown.isErr()).toBe(true);
    expect(zero.isErr()).toBe(true);
    expect(overflow.isErr()).toBe(true);
  });

  it('validates referral code uint256 boundaries while allowing explicit zero', () => {
    const zero = referral(0n);
    const maximum = referral(UINT256_MAX);
    const negative = referral(-1n);
    const overflow = referral(UINT256_MAX + 1n);

    expect(zero.isOk()).toBe(true);
    expect(maximum.isOk()).toBe(true);
    expect(negative.isErr()).toBe(true);
    expect(overflow.isErr()).toBe(true);
  });
});
