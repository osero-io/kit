import { ValidationError } from './errors.js';
import { err, ok, type Result } from './result.js';
import { isTokenSymbol, type TokenSymbol } from './tokens.js';

export const UINT256_MAX = 2n ** 256n - 1n;
const SLIPPAGE_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const slippageBrand: unique symbol = Symbol('Slippage');

export type Slippage = {
  readonly bps: string;
  readonly [slippageBrand]: true;
};

export type SlippageInput = {
  readonly bps: string;
};

export const DEFAULT_SLIPPAGE: Slippage = Object.freeze({
  bps: '5',
  [slippageBrand]: true as const,
});

export function parseSlippage(input: SlippageInput): Result<Slippage, ValidationError> {
  if (typeof input !== 'object' || input === null) {
    return err(
      ValidationError.forField(
        'slippage',
        'slippage must specify basis points as an object with a bps string',
      ),
    );
  }

  const { bps } = input;
  if (typeof bps !== 'string' || !SLIPPAGE_PATTERN.test(bps)) {
    return err(
      ValidationError.forField(
        'slippage.bps',
        'slippage.bps must be a non-negative decimal string without exponent notation',
      ),
    );
  }

  const [whole = '0', fraction = ''] = bps.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(whole) * scale + BigInt(fraction || '0');
  if (units > 10_000n * scale) {
    return err(ValidationError.forField('slippage.bps', 'slippage.bps must not exceed 10000'));
  }

  return ok(Object.freeze({ bps, [slippageBrand]: true as const }));
}

export function slippageRatio(slippage: Slippage): {
  readonly units: bigint;
  readonly scale: bigint;
} {
  const [whole = '0', fraction = ''] = slippage.bps.split('.');
  const scale = 10n ** BigInt(fraction.length);
  return {
    units: BigInt(whole) * scale + BigInt(fraction || '0'),
    scale,
  };
}

export type TokenAmount<Symbol extends TokenSymbol = TokenSymbol> = {
  readonly symbol: Symbol;
  readonly raw: bigint;
};

export function tokenAmount<Symbol extends TokenSymbol>(
  symbol: Symbol,
  raw: bigint,
): Result<TokenAmount<Symbol>, ValidationError> {
  if (!isTokenSymbol(symbol)) {
    return err(ValidationError.forField('symbol', `Unknown local token symbol: ${String(symbol)}`));
  }
  if (typeof raw !== 'bigint' || raw <= 0n || raw > UINT256_MAX) {
    return err(
      ValidationError.forField(
        'raw',
        'token amount must be a positive bigint that fits within uint256',
      ),
    );
  }
  return ok(Object.freeze({ symbol, raw }));
}

export type Referral = false | { readonly code: bigint };

export function referral(code: bigint): Result<Exclude<Referral, false>, ValidationError> {
  if (typeof code !== 'bigint' || code < 0n || code > UINT256_MAX) {
    return err(
      ValidationError.forField(
        'referral.code',
        'referral code must be a non-negative bigint that fits within uint256',
      ),
    );
  }
  return ok(Object.freeze({ code }));
}

export type ApprovalPolicy = 'exact' | 'max' | 'none';

export type AllowanceSnapshot = {
  readonly token: `0x${string}`;
  readonly owner: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly allowance: bigint;
  readonly requiredAmount: bigint;
  readonly approvalAmount?: bigint;
  readonly policy: ApprovalPolicy;
  readonly observedAtBlock?: bigint;
};

export type AdvisoryGasEstimate = {
  readonly gas: bigint;
  readonly source: 'hosted-api' | 'local-simulation';
  readonly observedAtBlock?: bigint;
};
