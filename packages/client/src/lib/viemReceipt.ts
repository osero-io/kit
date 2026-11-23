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

/**
 * What adapter waits on one submitted hash have observed. viem may run a single
 * poller for several of them, and only that poller's reads can be observed, so
 * every wait viem could put on the same poller records into the same map.
 */
type Observation = {
  /** The `uid` every view in this observation presents to viem. */
  readonly uid: string;
  readonly observed: Map<string, ObservedTransaction>;
  waiters: number;
};

/**
 * Live observations, keyed by the client `uid` and the hash. `client.extend()`
 * returns another object with the same `uid`, so objects cannot key this.
 */
const observations = new Map<string, Observation>();
let observationCount = 0;

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
 * own watchers exactly as before, and viem keeps nothing else under the view's
 * `uid` once the wait has settled.
 */
function observingClient(
  client: ClientLike,
  sender: string,
  { uid, observed }: Observation,
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
    uid: { value: uid },
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
 * Adapter waits that are live at the same time on one client `uid` and hash
 * share an observation, and through its `uid` a viem poller, as they did before
 * the view existed. Each observation gets a fresh `uid`: viem 2.28 leaves the
 * poller of a timed-out wait running, and a later wait must not join a poller
 * whose reads go to an observation that is already gone.
 */
function joinObservation(client: ClientLike, key: string): Observation {
  let observation = observations.get(key);
  if (observation === undefined) {
    observationCount += 1;
    observation = {
      uid: `${String(client.uid)}:osero-receipt:${observationCount}`,
      observed: new Map(),
      waiters: 0,
    };
    observations.set(key, observation);
  }
  observation.waiters += 1;
  return observation;
}

function leaveObservation(key: string, observation: Observation): void {
  observation.waiters -= 1;
  if (observation.waiters === 0 && observations.get(key) === observation) observations.delete(key);
}

/**
 * Classifies a substitution viem returned without naming a reason.
 *
 * Before 2.57.12, viem only calls `onReplaced` when the replacement already has
 * enough confirmations in the block it is found in. With more than one
 * confirmation requested it keeps the replacement's receipt, waits for later
 * blocks, and then resolves without the callback. Later versions name the
 * replacement for any confirmation count, so this runs only on the older viem
 * the peer range still admits. The transaction viem found in the block
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
  if (submitted === undefined) {
    const receipt = await waitForTransactionReceipt(
      client,
      waitParameters(args, (named) => {
        reason = named;
      }),
    );
    if (reason === undefined && receipt.transactionHash.toLowerCase() !== hash) reason = 'replaced';
    return reason === undefined ? { receipt } : { receipt, replacement: reason };
  }
  const key = `${String(client.uid)}\u0000${hash}`;
  const observation = joinObservation(client, key);
  try {
    const view = observingClient(client, submitted.from.toLowerCase(), observation);
    const receipt = await waitForTransactionReceipt(
      view,
      waitParameters(args, (named) => {
        reason = named;
      }),
    );
    if (reason === undefined && receipt.transactionHash.toLowerCase() !== hash) {
      reason = classifyUnreportedReplacement(
        observation.observed.get(receipt.transactionHash.toLowerCase()),
        submitted,
      );
    }
    return reason === undefined ? { receipt } : { receipt, replacement: reason };
  } finally {
    leaveObservation(key, observation);
  }
}

function waitParameters(
  args: { readonly hash: Hex; readonly confirmations: number; readonly timeout?: number },
  onNamed: (reason: ViemReplacementReason) => void,
) {
  return {
    hash: args.hash,
    confirmations: args.confirmations,
    ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
    onReplaced: (replacement: { readonly reason: string }) => {
      onNamed(
        replacement.reason === 'repriced' || replacement.reason === 'cancelled'
          ? replacement.reason
          : 'replaced',
      );
    },
  };
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
