import { parseUnits } from 'viem';
import { vi } from 'vitest';

import { PSM_ADDRESSES } from './addresses.js';
import { UnexpectedError } from './errors.js';
import { applySlippage, usdsFromUsdcViaSellGem } from './math.js';
import { makeTransactionRequest } from './plan.js';
import { runTransactionPreflightChecks, type PreflightReaders } from './preflight.js';
import { okAsync } from './result.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;
const WRAPPER = '0x2222222222222222222222222222222222222222' as const;

describe('runTransactionPreflightChecks', () => {
  it('skips transactions without preflight checks', async () => {
    const readLitePsmTin = vi.fn<PreflightReaders['readLitePsmTin']>(() => okAsync(0n));
    const tx = makeTransactionRequest({
      chainId: 1,
      from: SENDER,
      to: WRAPPER,
      data: '0x01',
      operation: 'MINT_USDS',
    });

    const result = await runTransactionPreflightChecks(tx, { readLitePsmTin });

    expect(result.isOk()).toBe(true);
    expect(readLitePsmTin).not.toHaveBeenCalled();
  });

  it('passes mainnet mintUsds when the live tin still satisfies the guarded output', async () => {
    const amount = parseUnits('100', 6);
    const quoteTin = 10n ** 16n;
    const minUsdsOut = applySlippage(usdsFromUsdcViaSellGem(amount, quoteTin), 5);
    const readLitePsmTin = vi.fn<PreflightReaders['readLitePsmTin']>(() => okAsync(quoteTin));
    const tx = makeGuardedMintUsdsTx(amount, minUsdsOut);

    const result = await runTransactionPreflightChecks(tx, { readLitePsmTin });

    expect(result.isOk()).toBe(true);
    expect(readLitePsmTin).toHaveBeenCalledWith(PSM_ADDRESSES[1]!.litePsm);
  });

  it('rejects mainnet mintUsds when live tin would return less than the guarded output', async () => {
    const amount = parseUnits('100', 6);
    const minUsdsOut = usdsFromUsdcViaSellGem(amount, 0n);
    const readLitePsmTin = vi.fn<PreflightReaders['readLitePsmTin']>(() => okAsync(10n ** 16n));
    const tx = makeGuardedMintUsdsTx(amount, minUsdsOut);

    const result = await runTransactionPreflightChecks(tx, { readLitePsmTin });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toContain('below guarded minimum');
    }
  });
});

function makeGuardedMintUsdsTx(amount: bigint, minUsdsOut: bigint) {
  return makeTransactionRequest({
    chainId: 1,
    from: SENDER,
    to: WRAPPER,
    data: '0x01',
    operation: 'MINT_USDS',
    preflightChecks: [
      {
        kind: 'MAINNET_MINT_USDS_TIN',
        litePsm: PSM_ADDRESSES[1]!.litePsm!,
        amount,
        minUsdsOut,
      },
    ],
  });
}
