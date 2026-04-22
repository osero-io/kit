import type { ResolvedClientConfig } from './config.js';
import { ValidationError } from './errors.js';

/**
 * SDK-wide default referral code, applied when neither the request
 * nor the client explicitly specifies one. Callers can opt out by
 * passing `referralCode: undefined` on a request, or by passing
 * `defaultReferralCode: undefined` when constructing the client.
 */
export const DEFAULT_REFERRAL_CODE = 3000n;

type HasReferralCode = { readonly referralCode?: bigint };

/**
 * Resolves the effective referral code for an action invocation.
 *
 * Precedence (highest first):
 *  1. `request.referralCode` (explicit, including `undefined` → opt out).
 *  2. `config.defaultReferralCode` (explicit, including `undefined` → opt out at client level).
 *  3. {@link DEFAULT_REFERRAL_CODE}.
 */
export function resolveReferralCode(
  request: HasReferralCode,
  config: ResolvedClientConfig,
): bigint | undefined {
  if ('referralCode' in request) {
    return request.referralCode;
  }
  return config.defaultReferralCode;
}

/**
 * Validates that a resolved referral code is within the psm3Abi
 * `uint256` range. Returns a typed {@link ValidationError} instead
 * of throwing so actions can short-circuit via `errAsync` without
 * ever letting viem's ABI encoder raise synchronously.
 */
export function validateReferralCode(
  code: bigint | undefined,
): ValidationError<{ field: string }> | undefined {
  if (code !== undefined && code < 0n) {
    return ValidationError.forField(
      'referralCode',
      'referralCode must be greater than or equal to 0',
    );
  }
  return undefined;
}
