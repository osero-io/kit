import type { Chain, Client, Hex, TransactionReceipt, Transport } from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';

import { ConfirmationError, type ExecutionFailureContext } from './errors.js';

export type ViemReplacementReason = 'repriced' | 'cancelled' | 'replaced';

export type ViemReceiptOutcome = {
  readonly receipt: TransactionReceipt;
  /**
   * Present when the confirmed receipt belongs to a different transaction than
   * the submitted one. `replaced` is also reported when the receipt hash
   * differs but viem named no reason, so an unexplained substitution is never
   * mistaken for a harmless fee bump.
   */
  readonly replacement?: ViemReplacementReason;
};

/**
 * Waits for a receipt through viem while observing transaction replacement.
 *
 * viem resolves `waitForTransactionReceipt` with the replacement's receipt for
 * every replacement kind, including a cancellation or a different transaction
 * that reused the nonce. Callers must therefore inspect `replacement` before
 * treating the receipt as confirmation of the submitted plan step.
 */
export async function waitForViemReceipt(
  client: Client<Transport, Chain | undefined>,
  args: {
    readonly hash: Hex;
    readonly confirmations: number;
    readonly timeout?: number;
  },
): Promise<ViemReceiptOutcome> {
  let reason: ViemReplacementReason | undefined;
  const receipt = await waitForTransactionReceipt(client, {
    hash: args.hash,
    confirmations: args.confirmations,
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    onReplaced: (replacement) => {
      reason =
        replacement.reason === 'repriced' || replacement.reason === 'cancelled'
          ? replacement.reason
          : 'replaced';
    },
  });
  if (reason === undefined && receipt.transactionHash.toLowerCase() !== args.hash.toLowerCase()) {
    reason = 'replaced';
  }
  return reason === undefined ? { receipt } : { receipt, replacement: reason };
}

/**
 * The error every adapter returns when the submitted transaction was replaced
 * by anything other than the same transaction at a higher fee. The message and
 * stage match the ethers adapter.
 */
export function nonRepricedReplacementError(
  submittedHash: Hex,
  reason: Exclude<ViemReplacementReason, 'repriced'>,
  replacementHash: Hex,
  execution: ExecutionFailureContext,
): ConfirmationError {
  return new ConfirmationError(
    `Transaction ${submittedHash} was ${reason} and cannot be treated as this plan step`,
    execution,
    { cause: { reason, originalHash: submittedHash, replacementHash } },
  );
}
