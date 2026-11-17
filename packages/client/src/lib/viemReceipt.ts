import {
  type Address,
  type Chain,
  type Client,
  type GetBlockParameters,
  type Hex,
  type TransactionReceipt,
  type Transport,
} from 'viem';
import { getBlock, waitForTransactionReceipt } from 'viem/actions';

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

/** A transaction from the submitting account, as viem read it from a block. Hex is lower-cased. */
type ObservedTransaction = {
  readonly from: string;
  readonly to: string | null;
  readonly input: string;
  readonly value: bigint;
};

function observeBlockTransactions(
  block: unknown,
  sender: string,
  observed: Map<string, ObservedTransaction>,
): void {
  if (typeof block !== 'object' || block === null) return;
  const { transactions } = block as { readonly transactions?: unknown };
  if (!Array.isArray(transactions)) return;
  for (const entry of transactions) {
    // Blocks read without transaction bodies list bare hashes.
    if (typeof entry !== 'object' || entry === null) continue;
    const { hash, from, to, input, value } = entry as Record<string, unknown>;
    if (
      typeof hash !== 'string' ||
      typeof from !== 'string' ||
      typeof input !== 'string' ||
      typeof value !== 'bigint' ||
      from.toLowerCase() !== sender
    ) {
      continue;
    }
    observed.set(hash.toLowerCase(), {
      from: sender,
      to: typeof to === 'string' ? to.toLowerCase() : null,
      input: input.toLowerCase(),
      value,
    });
  }
}

/**
 * Returns a view of `client` that records the sender's transactions from every
 * block viem reads through it.
 *
 * viem finds a replacement by reading the block that mined it, and resolves its
 * nested actions through the client it was given. Observing that read gives the
 * replacement's contents without any request of our own: the view issues exactly
 * the requests viem would have issued on `client`.
 */
function observingClient(
  client: Client<Transport, Chain | undefined>,
  sender: string,
  observed: Map<string, ObservedTransaction>,
): Client<Transport, Chain | undefined> {
  const own = (client as { readonly getBlock?: unknown }).getBlock;
  const read =
    typeof own === 'function'
      ? (parameters: unknown): unknown => Reflect.apply(own, client, [parameters])
      : (parameters: unknown): unknown => getBlock(client, parameters as GetBlockParameters);
  const view = Object.create(client) as Client<Transport, Chain | undefined>;
  Object.defineProperty(view, 'getBlock', {
    value: async (parameters: unknown): Promise<unknown> => {
      const block = await read(parameters);
      observeBlockTransactions(block, sender, observed);
      return block;
    },
  });
  return view;
}

/**
 * Classifies a substitution viem returned without naming a reason.
 *
 * viem only calls `onReplaced` when the replacement already has enough
 * confirmations in the block it is found in. With more than one confirmation
 * requested it keeps the replacement's receipt, waits for later blocks, and
 * then resolves without the callback. The transaction viem found in the block
 * is therefore compared with what was submitted: the same sender, target,
 * calldata, and value under another hash is the same transaction at a
 * different fee. Anything else, including a transaction that was not observed,
 * is not a repricing.
 */
function classifyUnreportedReplacement(
  mined: ObservedTransaction | undefined,
  submitted: SubmittedTransaction,
): ViemReplacementReason {
  if (mined === undefined) return 'replaced';
  if (
    mined.to === submitted.to.toLowerCase() &&
    mined.input === submitted.data.toLowerCase() &&
    mined.value === submitted.value
  ) {
    return 'repriced';
  }
  if (mined.to === mined.from && mined.value === 0n) return 'cancelled';
  return 'replaced';
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
 * The check issues no request beyond the ones viem makes for the wait.
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
  const observed = new Map<string, ObservedTransaction>();
  const { submitted } = args;
  const receipt = await waitForTransactionReceipt(
    submitted === undefined
      ? client
      : observingClient(client, submitted.from.toLowerCase(), observed),
    {
      hash: args.hash,
      confirmations: args.confirmations,
      ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
      onReplaced: (replacement) => {
        reason =
          replacement.reason === 'repriced' || replacement.reason === 'cancelled'
            ? replacement.reason
            : 'replaced';
      },
    },
  );
  if (reason === undefined && receipt.transactionHash.toLowerCase() !== args.hash.toLowerCase()) {
    reason =
      submitted === undefined
        ? 'replaced'
        : classifyUnreportedReplacement(
            observed.get(receipt.transactionHash.toLowerCase()),
            submitted,
          );
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
