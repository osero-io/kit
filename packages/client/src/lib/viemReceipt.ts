import {
  type Address,
  type Chain,
  type Client,
  type GetBlockParameters,
  type Hex,
  type TransactionReceipt,
  type Transport,
  type WatchBlockNumberParameters,
} from 'viem';
import { getBlock, waitForTransactionReceipt, watchBlockNumber } from 'viem/actions';

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

type ClientLike = Client<Transport, Chain | undefined>;

/** The replacement search for one submitted hash, shared by every adapter wait on it. */
type Observation = {
  readonly view: ClientLike;
  readonly observed: Map<string, ObservedTransaction>;
  waiters: number;
};

const observations = new WeakMap<ClientLike, Map<string, Observation>>();

/**
 * Returns a view of `client` that records the sender's transactions from every
 * block viem reads through it.
 *
 * viem finds a replacement by reading the block that mined it, and resolves its
 * nested actions through the client it was given. Observing that read gives the
 * replacement's contents without any request of our own.
 *
 * viem shares one poller between waits that have the same client `uid` and
 * hash, and only the first wait's client is used for the reads. The view
 * therefore has its own `uid`: an adapter wait never joins a wait the caller
 * started on the same client, whose block reads it could not observe and whose
 * confirmation count would silently replace the adapter's. Block-number
 * polling still runs on `client` itself, so it stays shared with the caller's
 * own watchers exactly as before.
 */
function observingClient(
  client: ClientLike,
  sender: string,
  observed: Map<string, ObservedTransaction>,
): ClientLike {
  const { getBlock: ownGetBlock, watchBlockNumber: ownWatchBlockNumber } = client as {
    readonly getBlock?: unknown;
    readonly watchBlockNumber?: unknown;
  };
  const readBlock =
    typeof ownGetBlock === 'function'
      ? (parameters: unknown): unknown => Reflect.apply(ownGetBlock, client, [parameters])
      : (parameters: unknown): unknown => getBlock(client, parameters as GetBlockParameters);
  const watch =
    typeof ownWatchBlockNumber === 'function'
      ? (parameters: unknown): unknown => Reflect.apply(ownWatchBlockNumber, client, [parameters])
      : (parameters: unknown): unknown =>
          watchBlockNumber(client, parameters as WatchBlockNumberParameters);
  return Object.create(client, {
    uid: { value: `${String(client.uid)}:osero-receipt` },
    getBlock: {
      value: async (parameters: unknown): Promise<unknown> => {
        const block = await readBlock(parameters);
        observeBlockTransactions(block, sender, observed);
        return block;
      },
    },
    watchBlockNumber: { value: watch },
  }) as ClientLike;
}

/**
 * Adapter waits on the same client and hash share one view, because viem may
 * run a single poller for them and only that poller's reads can be observed.
 */
function joinObservation(client: ClientLike, hash: string, sender: string): Observation {
  let byHash = observations.get(client);
  if (byHash === undefined) {
    byHash = new Map();
    observations.set(client, byHash);
  }
  let observation = byHash.get(hash);
  if (observation === undefined) {
    const observed = new Map<string, ObservedTransaction>();
    observation = { view: observingClient(client, sender, observed), observed, waiters: 0 };
    byHash.set(hash, observation);
  }
  observation.waiters += 1;
  return observation;
}

function leaveObservation(client: ClientLike, hash: string, observation: Observation): void {
  observation.waiters -= 1;
  if (observation.waiters > 0) return;
  const byHash = observations.get(client);
  if (byHash?.get(hash) === observation) byHash.delete(hash);
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
  if (mined === undefined || mined.from !== submitted.from.toLowerCase()) return 'replaced';
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
  client: ClientLike,
  args: {
    readonly hash: Hex;
    readonly confirmations: number;
    readonly timeout?: number;
    readonly submitted?: SubmittedTransaction;
  },
): Promise<ViemReceiptOutcome> {
  let reason: ViemReplacementReason | undefined;
  const { submitted } = args;
  const hash = args.hash.toLowerCase();
  const observation =
    submitted === undefined
      ? undefined
      : joinObservation(client, hash, submitted.from.toLowerCase());
  try {
    const receipt = await waitForTransactionReceipt(observation?.view ?? client, {
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
    if (reason === undefined && receipt.transactionHash.toLowerCase() !== hash) {
      reason =
        observation === undefined || submitted === undefined
          ? 'replaced'
          : classifyUnreportedReplacement(
              observation.observed.get(receipt.transactionHash.toLowerCase()),
              submitted,
            );
    }
    return reason === undefined ? { receipt } : { receipt, replacement: reason };
  } finally {
    if (observation !== undefined) leaveObservation(client, hash, observation);
  }
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
