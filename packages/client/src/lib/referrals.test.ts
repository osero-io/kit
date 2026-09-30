import { resolveConfig } from './config.js';
import { referral, type Referral } from './domain.js';
import { ValidationError } from './errors.js';
import {
  OSERO_REFERRAL_CODE,
  referralCodeForApi,
  referralCodeForRoute,
  resolveReferral,
} from './referrals.js';

function referralValue(code: bigint): Exclude<Referral, false> {
  const result = referral(code);
  if (result.isErr()) throw result.error;
  return result.value;
}

describe('referral attribution', () => {
  it('defaults to no attribution and exposes Osero attribution as explicit opt-in', () => {
    expect(resolveConfig({}).referral).toBe(false);
    expect(OSERO_REFERRAL_CODE).toBe(3000n);
    expect(resolveConfig({ referral: referralValue(OSERO_REFERRAL_CODE) }).referral).toEqual({
      code: 3000n,
    });
  });

  it('gives request policy precedence and supports explicit opt-out', () => {
    const configured = referralValue(3001n);

    expect(resolveReferral({}, configured)).toEqual(configured);
    expect(resolveReferral({ referral: referralValue(3002n) }, configured)).toEqual({
      code: 3002n,
    });
    expect(resolveReferral({ referral: false }, configured)).toBe(false);
    expect(resolveReferral({ referral: undefined }, configured)).toBe(false);
  });

  it('adapts referral codes to each route ABI capability', () => {
    const small = referralValue(3001n);
    const large = referralValue(70_000n);
    const disabled = referralCodeForRoute(false, 'none');
    const unsupported = referralCodeForRoute(small, 'none');
    const uint16 = referralCodeForRoute(small, 'uint16');
    const overflow = referralCodeForRoute(large, 'uint16');
    const uint256 = referralCodeForRoute(large, 'uint256');

    expect(disabled.isOk() && disabled.value === 0n).toBe(true);
    expect(unsupported.isErr()).toBe(true);
    if (unsupported.isErr()) expect(unsupported.error).toBeInstanceOf(ValidationError);
    expect(uint16.isOk() && uint16.value === 3001n).toBe(true);
    expect(overflow.isErr()).toBe(true);
    expect(uint256.isOk() && uint256.value === 70_000n).toBe(true);
  });

  it('enforces the hosted API safe-integer boundary', () => {
    const safe = referralCodeForApi(referralValue(BigInt(Number.MAX_SAFE_INTEGER)));
    const unsafe = referralCodeForApi(referralValue(BigInt(Number.MAX_SAFE_INTEGER) + 1n));
    const disabled = referralCodeForApi(false);

    expect(safe.isOk() && safe.value === Number.MAX_SAFE_INTEGER).toBe(true);
    expect(unsafe.isErr()).toBe(true);
    if (unsafe.isErr()) expect(unsafe.error.field).toBe('referral.code');
    expect(disabled.isOk() && disabled.value === undefined).toBe(true);
  });
});
