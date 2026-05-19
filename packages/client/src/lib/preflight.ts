import type { Address } from 'viem';

import { UnexpectedError } from './errors.js';
import { usdsFromUsdcViaSellGem } from './math.js';
import { errAsync, okAsync, type ResultAsync } from './result.js';
import type { TransactionPreflightCheck, TransactionRequest } from './types.js';

export type PreflightReaders = {
  readonly readLitePsmTin: (address: Address) => ResultAsync<bigint, UnexpectedError>;
};

export function runTransactionPreflightChecks(
  request: TransactionRequest,
  readers: PreflightReaders,
): ResultAsync<void, UnexpectedError> {
  const checks = request.preflightChecks ?? [];

  return checks.reduce<ResultAsync<void, UnexpectedError>>(
    (acc, check) => acc.andThen(() => runTransactionPreflightCheck(check, readers)),
    okAsync(undefined),
  );
}

function runTransactionPreflightCheck(
  check: TransactionPreflightCheck,
  readers: PreflightReaders,
): ResultAsync<void, UnexpectedError> {
  switch (check.kind) {
    case 'MAINNET_MINT_USDS_TIN':
      return readers.readLitePsmTin(check.litePsm).andThen((tin) => {
        const liveUsdsOut = usdsFromUsdcViaSellGem(check.amount, tin);
        if (liveUsdsOut < check.minUsdsOut) {
          return errAsync(
            UnexpectedError.from(
              new Error(
                `Mainnet mintUsds preflight failed: live Lite PSM tin ${tin.toString()} returns ${liveUsdsOut.toString()} USDS wei, below guarded minimum ${check.minUsdsOut.toString()}`,
              ),
            ),
          );
        }
        return okAsync(undefined);
      });
  }
}
