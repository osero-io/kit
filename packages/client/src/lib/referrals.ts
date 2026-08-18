import type { ReferralCapability } from './capabilities.js';
import type { Referral } from './domain.js';
import { ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';

export const OSERO_REFERRAL_CODE = 3000n;

export function resolveReferral(
  request: { readonly referral?: Referral },
  configured: Referral,
): Referral {
  return 'referral' in request ? (request.referral ?? false) : configured;
}

export function referralCodeForRoute(
  configured: Referral,
  capability: ReferralCapability,
): Result<bigint, ValidationError> {
  if (configured === false) return ok(0n);
  if (capability === 'none') {
    return err(
      ValidationError.forField('referral', 'referral attribution is not supported by this route'),
    );
  }
  if (capability === 'uint16' && configured.code > 65_535n) {
    return err(
      ValidationError.forField(
        'referral.code',
        'referral code must fit within uint16 for this route',
      ),
    );
  }
  return ok(configured.code);
}

export function referralCodeForApi(
  configured: Referral,
): Result<number | undefined, ValidationError> {
  if (configured === false) return ok(undefined);
  if (configured.code > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err(
      ValidationError.forField(
        'referral.code',
        'referral code is not safely representable by the hosted API JSON contract',
      ),
    );
  }
  return ok(Number(configured.code));
}
