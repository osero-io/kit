import type { Signer, TransactionResponse } from 'ethers';

import { sendWith } from './ethers.js';
import { UnexpectedError } from './lib/errors.js';
import { makeTransactionRequest } from './lib/plan.js';

const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'b'.repeat(64)}` as `0x${string}`;

const request = makeTransactionRequest({
  chainId: 1,
  from,
  to,
  data: '0x1234',
  operation: 'MINT_USDS',
});

describe('ethers sendWith', () => {
  it('preserves the transaction hash when receipt polling fails', async () => {
    const pollingError = new Error('receipt polling timed out');
    const signer = makeSigner({
      hash: txHash,
      wait: async () => {
        throw pollingError;
      },
    });

    const result = await sendWith(signer, request);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      expect(error).toBeInstanceOf(UnexpectedError);
      if (!(error instanceof UnexpectedError)) {
        throw new Error(`Expected UnexpectedError, received ${error.name}`);
      }
      expect(error.txHash).toBe(txHash);
      expect(error.cause).toBe(pollingError);
    }
  });

  it('preserves the transaction hash when ethers returns a null receipt', async () => {
    const signer = makeSigner({
      hash: txHash,
      wait: async () => null,
    });

    const result = await sendWith(signer, request);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      expect(error).toBeInstanceOf(UnexpectedError);
      if (!(error instanceof UnexpectedError)) {
        throw new Error(`Expected UnexpectedError, received ${error.name}`);
      }
      expect(error.txHash).toBe(txHash);
      expect(error.message).toContain(txHash);
    }
  });
});

function makeSigner(response: Pick<TransactionResponse, 'hash' | 'wait'>): Signer {
  return {
    provider: {
      getNetwork: async () => ({ chainId: 1n }),
    },
    sendTransaction: async () => response,
  } as unknown as Signer;
}
