import type { PrivyClient } from '@privy-io/node';
import {
  createClient,
  createPublicClient,
  createWalletClient,
  custom,
  numberToHex,
  publicActions,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';
import { base } from 'viem/chains';

import { sendWith as sendWithPrivy } from '../privy.js';
import { sendWith } from '../viem.js';
import { ConfirmationError } from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import { waitForViemReceipt, type SubmittedTransaction } from './viemReceipt.js';

/**
 * These tests run viem's real `waitForTransactionReceipt` against a scripted
 * JSON-RPC node, because the behaviour under test is viem's own. Before viem
 * 2.57.12, with more than one confirmation requested, it resolved with a
 * replacement's receipt without ever calling `onReplaced`; later versions name
 * the replacement for any confirmation count. A mocked waiter cannot show either.
 *
 * The peer range still admits the older viem, so the adapter's own
 * classification is tested against it too: `viemBefore2_57_12` runs the real
 * waiter but withholds `onReplaced` whenever more than one confirmation is
 * requested, which is exactly what that viem did (wevm/viem#5284).
 */
const waiter = vi.hoisted(() => ({ viemBefore2_57_12: false }));

vi.mock('viem/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/actions')>();
  const wait: typeof actual.waitForTransactionReceipt = (client, parameters) =>
    actual.waitForTransactionReceipt(
      client,
      waiter.viemBefore2_57_12 && (parameters.confirmations ?? 1) > 1
        ? { ...parameters, onReplaced: undefined }
        : parameters,
    );
  return { ...actual, waitForTransactionReceipt: wait };
});

/** Runs the enclosing `describe` against viem's waiter as it behaved before 2.57.12. */
function emulateViemBefore2_57_12(): void {
  beforeEach(() => {
    waiter.viemBefore2_57_12 = true;
  });
  afterEach(() => {
    waiter.viemBefore2_57_12 = false;
  });
}

const WAITERS = [
  ['the real viem waiter', false],
  ['the real viem waiter as it behaved before 2.57.12', true],
] as const;

const ACCOUNT: Address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TARGET: Address = '0x2222222222222222222222222222222222222222';
const ORIGINAL = `0x${'a1'.repeat(32)}` as Hex;
const REPLACEMENT = `0x${'b2'.repeat(32)}` as Hex;
const START_BLOCK = 100n;
const SUBMITTED: SubmittedTransaction = { from: ACCOUNT, to: TARGET, data: '0x1234', value: 0n };

type Mined = { readonly to: Address; readonly input: Hex; readonly value: bigint };

function rpcTransaction(hash: Hex, fields: Mined, blockNumber: bigint | null) {
  return {
    hash,
    from: ACCOUNT,
    to: fields.to,
    input: fields.input,
    value: numberToHex(fields.value),
    nonce: '0x7',
    gas: '0x5208',
    maxFeePerGas: hash === ORIGINAL ? '0x1' : '0x2',
    maxPriorityFeePerGas: '0x1',
    type: '0x2',
    chainId: numberToHex(base.id),
    accessList: [],
    blockNumber: blockNumber === null ? null : numberToHex(blockNumber),
    blockHash: blockNumber === null ? null : `0x${'cc'.repeat(32)}`,
    transactionIndex: blockNumber === null ? null : '0x0',
    v: '0x0',
    r: '0x1',
    s: '0x1',
  };
}

/**
 * A node on which the submitted transaction never mines. One block after the
 * start, a transaction from the same sender with the same nonce mines instead.
 */
function scriptedNode(replacement: Mined, options: { readonly mineAfter?: bigint } = {}) {
  // The replacement mines one block after the start, or later when asked.
  let replacedAt = START_BLOCK + (options.mineAfter ?? 1n);
  let head = START_BLOCK - 1n;
  const calls: string[] = [];
  const sent: unknown[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push(method);
    const [first] = (params ?? []) as readonly unknown[];
    switch (method) {
      case 'eth_chainId':
        return numberToHex(base.id);
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_sendTransaction':
        sent.push(first);
        return ORIGINAL;
      case 'eth_blockNumber':
        // Every poll observes a new block.
        head += 1n;
        return numberToHex(head);
      case 'eth_getTransactionByHash':
        // viem reads the replacement from its block, never by hash. Neither may the adapter.
        if (first !== ORIGINAL) throw new Error('unexpected read of a transaction by hash');
        return rpcTransaction(ORIGINAL, SUBMITTED_AS_MINED, null);
      case 'eth_getTransactionReceipt':
        if (first !== REPLACEMENT || head < replacedAt) return null;
        return {
          transactionHash: REPLACEMENT,
          blockNumber: numberToHex(replacedAt),
          blockHash: `0x${'cc'.repeat(32)}`,
          transactionIndex: '0x0',
          from: ACCOUNT,
          to: replacement.to,
          status: '0x1',
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x2',
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x2',
        };
      case 'eth_getBlockByNumber': {
        const number = BigInt(first as Hex);
        return {
          number: numberToHex(number),
          hash: `0x${'cc'.repeat(32)}`,
          parentHash: `0x${'dd'.repeat(32)}`,
          timestamp: '0x1',
          gasLimit: '0x1',
          gasUsed: '0x1',
          transactions:
            number === replacedAt ? [rpcTransaction(REPLACEMENT, replacement, replacedAt)] : [],
        };
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  return {
    transport: custom({ request }),
    calls,
    sent,
    /** Mines the replacement in the next block. */
    mineNow(): void {
      replacedAt = head + 1n;
    },
  };
}

const SUBMITTED_AS_MINED: Mined = { to: TARGET, input: '0x1234', value: 0n };
const REPRICED = SUBMITTED_AS_MINED;
const CANCELLED: Mined = { to: ACCOUNT, input: '0x', value: 0n };
const OTHER_CALL: Mined = { to: TARGET, input: '0xdeadbeef', value: 0n };
const OTHER_VALUE: Mined = { to: TARGET, input: '0x1234', value: 1n };

function publicClient(replacement: Mined) {
  const node = scriptedNode(replacement);
  return {
    node,
    client: createPublicClient({ chain: base, transport: node.transport, pollingInterval: 1 }),
  };
}

describe('waitForViemReceipt against the real viem waiter', () => {
  it('lets viem name a repricing when one confirmation is requested', async () => {
    const { client, node } = publicClient(REPRICED);

    const outcome = await waitForViemReceipt(client, {
      hash: ORIGINAL,
      confirmations: 1,
      submitted: SUBMITTED,
    });

    expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
    expect(outcome.replacement).toBe('repriced');
    expect(node.calls.filter((method) => method === 'eth_getTransactionByHash')).toHaveLength(1);
  });

  it.each([
    ['a repricing', REPRICED, 'repriced'],
    ['a cancellation', CANCELLED, 'cancelled'],
    ['a different call', OTHER_CALL, 'replaced'],
    ['the same call with another value', OTHER_VALUE, 'replaced'],
  ] as const)(
    'takes the reason viem names for %s when two confirmations are requested',
    async (_name, replacement, expected) => {
      const { client, node } = publicClient(replacement);

      const outcome = await waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations: 2,
        submitted: SUBMITTED,
      });
      // The premise, checked on a fresh node: since 2.57.12 viem's own callback
      // names the replacement here, with the reason the adapter would have given.
      let reportedByViem: string | undefined;
      const plain = publicClient(replacement);
      const direct = await plain.client.waitForTransactionReceipt({
        hash: ORIGINAL,
        confirmations: 2,
        onReplaced: (response) => {
          reportedByViem = response.reason;
        },
      });

      expect(direct.transactionHash).toBe(REPLACEMENT);
      expect(reportedByViem).toBe(expected);
      expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
      expect(outcome.receipt.blockNumber).toBe(START_BLOCK + 1n);
      expect(outcome.replacement).toBe(expected);
      expect(node.calls).toEqual(plain.node.calls);
    },
  );
});

describe('waitForViemReceipt against the real viem waiter as it behaved before 2.57.12', () => {
  emulateViemBefore2_57_12();

  it.each([
    ['a repricing', REPRICED, 'repriced'],
    ['a cancellation', CANCELLED, 'cancelled'],
    ['a different call', OTHER_CALL, 'replaced'],
    ['the same call with another value', OTHER_VALUE, 'replaced'],
  ] as const)(
    'classifies %s itself when two confirmations make viem skip onReplaced',
    async (_name, replacement, expected) => {
      const { client, node } = publicClient(replacement);

      const outcome = await waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations: 2,
        submitted: SUBMITTED,
      });
      // The premise, checked on a fresh node through the same `viem/actions`
      // import the adapter uses: viem's own callback stays silent here.
      let reportedByViem: string | undefined;
      const plain = publicClient(replacement);
      const direct = await waitForTransactionReceipt(plain.client, {
        hash: ORIGINAL,
        confirmations: 2,
        onReplaced: (response) => {
          reportedByViem = response.reason;
        },
      });

      expect(direct.transactionHash).toBe(REPLACEMENT);
      expect(reportedByViem).toBeUndefined();
      expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
      expect(outcome.receipt.blockNumber).toBe(START_BLOCK + 1n);
      expect(outcome.replacement).toBe(expected);
      // Classifying costs nothing: the node saw exactly the requests of a plain viem wait.
      expect(node.calls).toEqual(plain.node.calls);
      expect(node.calls).toContain('eth_getBlockByNumber');
    },
  );

  it('classifies through a client that is not decorated with public actions', async () => {
    const node = scriptedNode(REPRICED);
    const client = createClient({ chain: base, transport: node.transport, pollingInterval: 1 });

    const outcome = await waitForViemReceipt(client, {
      hash: ORIGINAL,
      confirmations: 2,
      submitted: SUBMITTED,
    });

    expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
    expect(outcome.replacement).toBe('repriced');
  });

  it.each([1, 2])(
    'still recognises a repricing while the caller waits on the same client and hash (%i confirmations)',
    async (confirmations) => {
      // viem shares one poller between waits on the same client and hash. The
      // caller's wait starts first, so a shared poller would read blocks through
      // the caller's client and never name the replacement to the adapter.
      const { client } = publicClient(REPRICED);
      const callers = client.waitForTransactionReceipt({ hash: ORIGINAL, confirmations: 2 });

      const outcome = await waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations,
        submitted: SUBMITTED,
      });

      expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
      expect(outcome.replacement).toBe('repriced');
      expect((await callers).transactionHash).toBe(REPLACEMENT);
    },
  );

  it('shares what it observed between adapter waits on the same client and hash', async () => {
    const { client } = publicClient(REPRICED);
    const wait = () =>
      waitForViemReceipt(client, { hash: ORIGINAL, confirmations: 2, submitted: SUBMITTED });

    const outcomes = await Promise.all([wait(), wait()]);

    expect(outcomes.map((outcome) => outcome.replacement)).toEqual(['repriced', 'repriced']);
  });

  it('shares what it observed with a wait on an extension of the same client', async () => {
    // client.extend() returns another object with the same uid, so viem puts both
    // waits on one poller and only one of the two views reads the block.
    const { client } = publicClient(REPRICED);
    const extended = client.extend(() => ({}));
    const wait = (through: typeof client) =>
      waitForViemReceipt(through, { hash: ORIGINAL, confirmations: 2, submitted: SUBMITTED });

    const outcomes = await Promise.all([wait(client), wait(extended as typeof client)]);

    expect(outcomes.map((outcome) => outcome.replacement)).toEqual(['repriced', 'repriced']);
  });

  it('recognises a repricing after an earlier wait on the same hash timed out', async () => {
    // viem 2.28 leaves the poller of a timed-out wait running. A later wait must
    // not join it: its reads go to an observation that no longer exists.
    const node = scriptedNode(REPRICED, { mineAfter: 1_000n });
    const client = createPublicClient({
      chain: base,
      transport: node.transport,
      pollingInterval: 1,
    });
    const wait = (timeout?: number) =>
      waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations: 2,
        submitted: SUBMITTED,
        ...(timeout === undefined ? {} : { timeout }),
      });

    await expect(wait(20)).rejects.toThrow(/Timed out while waiting for transaction/);
    node.mineNow();
    const outcome = await wait();

    expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
    expect(outcome.replacement).toBe('repriced');
  });

  it('fails closed when the confirmed transaction was sent by another account', async () => {
    const { client } = publicClient(REPRICED);

    const outcome = await waitForViemReceipt(client, {
      hash: ORIGINAL,
      confirmations: 2,
      submitted: { ...SUBMITTED, from: TARGET },
    });

    expect(outcome.replacement).toBe('replaced');
  });

  it('fails closed without the submitted transaction to compare against', async () => {
    const { client } = publicClient(REPRICED);

    const outcome = await waitForViemReceipt(client, { hash: ORIGINAL, confirmations: 2 });

    expect(outcome.replacement).toBe('replaced');
  });
});

function plan() {
  const steps = ['one', 'two'].map((id) => {
    const step = createTransactionRequest({
      id,
      chainId: base.id,
      from: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      operation: 'SWAP_EXACT_IN',
    });
    if (step.isErr()) throw step.error;
    return step.value;
  });
  const result = createExecutionPlan({ steps: [steps[0]!] });
  if (result.isErr()) throw result.error;
  return { single: result.value, steps };
}

function walletClient(replacement: Mined) {
  const node = scriptedNode(replacement);
  return {
    node,
    wallet: createWalletClient({
      account: ACCOUNT,
      chain: base,
      transport: node.transport,
      pollingInterval: 1,
    }),
  };
}

describe.each(WAITERS)('viem adapter with multiple confirmations against %s', (_name, older) => {
  if (older) emulateViemBefore2_57_12();

  it('confirms a repriced step instead of failing it', async () => {
    const { wallet, node } = walletClient(REPRICED);

    const result = await sendWith(wallet, plan().single, { confirmations: 2 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.txHash).toBe(REPLACEMENT);
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: ORIGINAL,
        hash: REPLACEMENT,
        replacement: { reason: 'repriced', originalHash: ORIGINAL, replacementHash: REPLACEMENT },
        confirmation: { status: 'success', transactionHash: REPLACEMENT, confirmations: 2 },
      });
    }
    expect(node.sent).toHaveLength(1);
  });

  it('confirms a repriced step while the caller monitors the same hash on the same client', async () => {
    const { wallet, node } = walletClient(REPRICED);
    const monitoring = wallet.extend(publicActions);
    const monitored: Promise<unknown>[] = [];

    const result = await sendWith(monitoring, plan().single, {
      confirmations: 2,
      onProgress(event) {
        if (event.type !== 'step-submitted') return;
        monitored.push(
          monitoring.waitForTransactionReceipt({ hash: event.hash, confirmations: 2 }),
        );
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.transactions[0]).toMatchObject({
        submittedHash: ORIGINAL,
        hash: REPLACEMENT,
        replacement: { reason: 'repriced' },
      });
    }
    expect(monitored).toHaveLength(1);
    await expect(monitored[0]).resolves.toMatchObject({ transactionHash: REPLACEMENT });
    expect(node.sent).toHaveLength(1);
  });

  it.each([
    ['cancelled', CANCELLED],
    ['replaced', OTHER_CALL],
  ] as const)(
    'stops a two-step plan when the first step is %s, without sending the second',
    async (reason, replacement) => {
      const { wallet, node } = walletClient(replacement);
      const twoSteps = createExecutionPlan({ steps: plan().steps });
      if (twoSteps.isErr()) throw twoSteps.error;

      const result = await sendWith(wallet, twoSteps.value, { confirmations: 2 });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConfirmationError);
        expect(result.error.message).toBe(
          `Transaction ${ORIGINAL} was ${reason} and cannot be treated as this plan step`,
        );
        if (result.error instanceof ConfirmationError) {
          expect(result.error.execution).toMatchObject({
            stage: 'replacement',
            stepId: 'one',
            hash: ORIGINAL,
            completed: [],
          });
        }
      }
      expect(node.sent).toHaveLength(1);
    },
  );
});

describe.each(WAITERS)('Privy adapter with multiple confirmations against %s', (_name, older) => {
  if (older) emulateViemBefore2_57_12();

  it('confirms a repriced step for two sends that share a hash, one through an extended receipt client', async () => {
    // A retry with the same idempotency key resolves to the same hash.
    const privy = {
      wallets: () => ({ ethereum: () => ({ sendTransaction: async () => ({ hash: ORIGINAL }) }) }),
    } as unknown as PrivyClient;
    const { client } = publicClient(REPRICED);
    const send = (receiptClient: PublicClient) =>
      sendWithPrivy(privy, { id: 'wallet-1', address: ACCOUNT }, plan().single, {
        chainId: base.id,
        receiptClient,
        idempotencyKeys: { one: 'key-one' },
        confirmations: 2,
      });

    const results = await Promise.all([
      send(client as unknown as PublicClient),
      send(client.extend(() => ({})) as unknown as PublicClient),
    ]);

    for (const result of results) {
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.transactions[0]).toMatchObject({
          submittedHash: ORIGINAL,
          hash: REPLACEMENT,
          replacement: { reason: 'repriced' },
        });
      }
    }
  });
});
