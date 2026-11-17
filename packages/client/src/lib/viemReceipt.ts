import {
  isAddressEqual,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type TransactionReceipt,
  type Transport,
} from 'viem';
import { getTransaction, waitForTransactionReceipt } from 'viem/actions';

import { ConfirmationError, type ExecutionFailureContext } from './errors.js';

export type ViemReplacementReason = 'repriced' | 'cancelled' | 'replaced';

/** What the adapter asked the wallet to send for a plan step. */
export type SubmittedTransaction = {
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
};

export type ViemReceiptOutcome = {
  readonly receipt: TransactionReceipt;
  /**
   * Present when the confirmed receipt belongs to a different transaction than
   * the submitted one. `replaced` is also reported whenever a substitution
   * cannot be proven to be a repricing, so an unexplained substitution is never
   * mistaken for a harmless fee bump.
   */
  readonly replacement?: ViemReplacementReason;
};

/**
 * Classifies a substitution viem returned without naming a reason.
 *
 * viem only calls `onReplaced` when the replacement already has enough
 * confirmations in the block it is found in. With more than one confirmation
 * requested it keeps the replacement's receipt, waits for later blocks, and
 * then resolves without the callback. The confirmed transaction is therefore
 * read back and compared with what was submitted: the same sender, target,
 * calldata, and value under another hash is the same transaction at a
 * different fee. Anything else, including a failed read, is not a repricing.
 */
async function classifyUnreportedReplacement(
  client: Client<Transport, Chain | undefined>,
  replacementHash: Hex,
  submitted: SubmittedTransaction | undefined,
): Promise<ViemReplacementReason> {
  if (submitted === undefined) return 'replaced';
  try {
    const mined = await getTransaction(client, { hash: replacementHash });
    if (
      mined.hash.toLowerCase() === replacementHash.toLowerCase() &&
      isAddressEqual(mined.from, submitted.from) &&
      mined.to !== null &&
      isAddressEqual(mined.to, submitted.to) &&
      mined.input.toLowerCase() === submitted.data.toLowerCase() &&
      mined.value === submitted.value
    ) {
      return 'repriced';
    }
    if (mined.to !== null && isAddressEqual(mined.from, mined.to) && mined.value === 0n) {
      return 'cancelled';
    }
    return 'replaced';
  } catch {
    return 'replaced';
  }
}

/**
 * Waits for a receipt through viem while observing transaction replacement.
 *
 * viem resolves `waitForTransactionReceipt` with the replacement's receipt for
 * every replacement kind, including a cancellation or a different transaction
 * that reused the nonce. Callers must therefore inspect `replacement` before
 * treating the receipt as confirmation of the submitted plan step.
 *
 * Pass `submitted` so a substitution viem does not explain can be checked
 * against what was sent. Without it, an unexplained substitution is `replaced`.
 */
export async function waitForViemReceipt(
  client: Client<Transport, Chain | undefined>,
  args: {
    readonly hash: Hex;
    readonly confirmations: number;
    readonly timeout?: number;
    readonly submitted?: SubmittedTransaction;
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
    reason = await classifyUnreportedReplacement(client, receipt.transactionHash, args.submitted);
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
