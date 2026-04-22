import type { ResolvedClientConfig } from './config.js';

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
