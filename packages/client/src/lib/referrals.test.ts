import type { ResolvedClientConfig } from './config.js';
import { resolveConfig } from './config.js';
import { ValidationError } from './errors.js';
import { DEFAULT_REFERRAL_CODE, resolveReferralCode, validateReferralCode } from './referrals.js';

function makeResolvedConfig(overrides: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    transports: {},
    defaultSlippageBps: 5,
    confirmations: 1,
    defaultReferralCode: DEFAULT_REFERRAL_CODE,
    ...overrides,
  };
}

describe('DEFAULT_REFERRAL_CODE', () => {
  it('is 3000n', () => {
    expect(DEFAULT_REFERRAL_CODE).toBe(3000n);
  });
});

describe('resolveConfig', () => {
  it('fills defaultReferralCode with DEFAULT_REFERRAL_CODE when the key is absent', () => {
    const resolved = resolveConfig({});
    expect(resolved.defaultReferralCode).toBe(DEFAULT_REFERRAL_CODE);
  });

  it('passes a caller-supplied bigint through', () => {
    const resolved = resolveConfig({ defaultReferralCode: 7n });
    expect(resolved.defaultReferralCode).toBe(7n);
  });

  it('keeps undefined when the caller explicitly opts out at the client level', () => {
    const resolved = resolveConfig({ defaultReferralCode: undefined });
    expect(resolved.defaultReferralCode).toBeUndefined();
  });
});

describe('resolveReferralCode', () => {
  it('returns the SDK default when neither request nor client specifies one', () => {
    const config = makeResolvedConfig();
    expect(resolveReferralCode({}, config)).toBe(DEFAULT_REFERRAL_CODE);
  });

  it('returns the request value when provided (request beats client)', () => {
    const config = makeResolvedConfig({ defaultReferralCode: DEFAULT_REFERRAL_CODE });
    expect(resolveReferralCode({ referralCode: 42n }, config)).toBe(42n);
  });

  it('treats request { referralCode: undefined } as an explicit opt-out that beats the client default', () => {
    const config = makeResolvedConfig({ defaultReferralCode: DEFAULT_REFERRAL_CODE });
    expect(resolveReferralCode({ referralCode: undefined }, config)).toBeUndefined();
  });

  it('returns the client default when the request does not include the referralCode key', () => {
    const config = makeResolvedConfig({ defaultReferralCode: 7n });
    expect(resolveReferralCode({}, config)).toBe(7n);
  });

  it('returns undefined when the client default is undefined and the request does not set one', () => {
    const config = makeResolvedConfig({ defaultReferralCode: undefined });
    expect(resolveReferralCode({}, config)).toBeUndefined();
  });
});

describe('validateReferralCode', () => {
  it('accepts the SDK default', () => {
    expect(validateReferralCode(DEFAULT_REFERRAL_CODE)).toBeUndefined();
  });

  it('accepts zero', () => {
    expect(validateReferralCode(0n)).toBeUndefined();
  });

  it('accepts a large positive value', () => {
    expect(validateReferralCode(10n ** 70n)).toBeUndefined();
  });

  it('accepts undefined (opt-out)', () => {
    expect(validateReferralCode(undefined)).toBeUndefined();
  });

  it('rejects a negative value with a typed ValidationError', () => {
    const result = validateReferralCode(-1n);
    expect(result).toBeInstanceOf(ValidationError);
    expect(result?.context).toEqual({ field: 'referralCode' });
  });
});
