import type { PrivyClient } from '@privy-io/node';
import {
  createClient,
  createPublicClient,
  createWalletClient,
  custom,
  numberToHex,
  publicActions,
  type Address,
  type DataSuffix,
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
 *
 * On either, a repricing is verified against what was submitted, whether viem
 * named it or not.
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
 *
 * With `speedsUpSent`, the node holds what it was sent under the submitted
 * hash and mines that calldata again at another fee, as a wallet's speed-up
 * does. Otherwise it holds `SUBMITTED_AS_MINED` and mines `replacement`,
 * whatever it was sent.
 */
function scriptedNode(
  replacement: Mined,
  options: { readonly mineAfter?: bigint; readonly speedsUpSent?: boolean } = {},
) {
  // The replacement mines one block after the start, or later when asked.
  let replacedAt = START_BLOCK + (options.mineAfter ?? 1n);
  let head = START_BLOCK - 1n;
  const calls: string[] = [];
  const sent: unknown[] = [];
  const estimated: unknown[] = [];
  const sentCalldata = (): Hex | undefined =>
    options.speedsUpSent ? (sent[0] as { readonly data?: Hex } | undefined)?.data : undefined;
  const original = (): Mined => {
    const input = sentCalldata();
    return input === undefined ? SUBMITTED_AS_MINED : { ...SUBMITTED_AS_MINED, input };
  };
  const mined = (): Mined => {
    const input = sentCalldata();
    return input === undefined ? replacement : { ...replacement, input };
  };
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    calls.push(method);
    const [first] = (params ?? []) as readonly unknown[];
    switch (method) {
      case 'eth_chainId':
        return numberToHex(base.id);
      case 'eth_estimateGas':
        estimated.push(first);
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
        return rpcTransaction(ORIGINAL, original(), null);
      case 'eth_getTransactionReceipt':
        if (first !== REPLACEMENT || head < replacedAt) return null;
        return {
          transactionHash: REPLACEMENT,
          blockNumber: numberToHex(replacedAt),
          blockHash: `0x${'cc'.repeat(32)}`,
          transactionIndex: '0x0',
          from: ACCOUNT,
          to: mined().to,
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
            number === replacedAt ? [rpcTransaction(REPLACEMENT, mined(), replacedAt)] : [],
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
    estimated,
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

/**
 * Submissions a repricing of `SUBMITTED_AS_MINED` does not match, although
 * viem calls it a repricing: viem compares it with the transaction under the
 * submitted hash, which is `SUBMITTED_AS_MINED` itself.
 */
const MISMATCHED_SUBMISSIONS = [
  ['was sent by another account', { ...SUBMITTED, from: TARGET }],
  ['carries other calldata than was submitted', { ...SUBMITTED, data: '0xdeadbeef' }],
] as const satisfies readonly (readonly [string, SubmittedTransaction])[];

function publicClient(replacement: Mined) {
  const node = scriptedNode(replacement);
  return {
    node,
    client: createPublicClient({ chain: base, transport: node.transport, pollingInterval: 1 }),
  };
}

/**
 * Whether the installed viem names a replacement when more than one
 * confirmation is requested, as it does since 2.57.12. The `viem peer range`
 * workflow (`.github/workflows/viem-peer-range.yml`) runs this suite against
 * older viem in the peer range as well; there, the tests whose premise is the
 * newer behaviour are skipped and the emulated ones describe the real waiter.
 */
const installedViemNamesEveryReplacement = await (async () => {
  let named = false;
  await publicClient(REPRICED)
    .client.waitForTransactionReceipt({
      hash: ORIGINAL,
      confirmations: 2,
      // viem's default is 180 s: a probe that cannot see the replacement must
      // fail fast and say why, not stall the file's import.
      timeout: 5_000,
      onReplaced: () => {
        named = true;
      },
    })
    .catch((cause: unknown) => {
      throw new Error('viem probe failed: the scripted replacement was not detected', { cause });
    });
  return named;
})();

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

  describe.skipIf(!installedViemNamesEveryReplacement)('since 2.57.12', () => {
    it.each([
      ['a repricing', REPRICED, 'repriced'],
      ['a cancellation', CANCELLED, 'cancelled'],
      ['a different call', OTHER_CALL, 'replaced'],
      ['the same call with another value', OTHER_VALUE, 'replaced'],
    ] as const)(
      'agrees with the reason viem names for %s when two confirmations are requested',
      async (_name, replacement, expected) => {
        const { client, node } = publicClient(replacement);

        const outcome = await waitForViemReceipt(client, {
          hash: ORIGINAL,
          confirmations: 2,
          submitted: SUBMITTED,
        });
        // The premise, checked on a fresh node: since 2.57.12 viem's own callback
        // names the replacement here, with the reason the adapter gives.
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

  for (const confirmations of [1, 2]) {
    describe.skipIf(confirmations > 1 && !installedViemNamesEveryReplacement)(
      `with ${confirmations} confirmation${confirmations > 1 ? 's' : ''}`,
      () => {
        // viem compares the replacement with the transaction it read for the
        // submitted hash, so it calls these repricings. The adapter compares the
        // replacement with what it submitted, and they differ.
        it.each(MISMATCHED_SUBMISSIONS)(
          'fails closed although viem reports a repricing when the mined transaction %s',
          async (_name, submitted) => {
            const { client, node } = publicClient(REPRICED);

            const outcome = await waitForViemReceipt(client, {
              hash: ORIGINAL,
              confirmations,
              submitted,
            });
            // The premise, checked on a fresh node: viem itself names a repricing.
            let reportedByViem: string | undefined;
            const plain = publicClient(REPRICED);
            await plain.client.waitForTransactionReceipt({
              hash: ORIGINAL,
              confirmations,
              onReplaced: (response) => {
                reportedByViem = response.reason;
              },
            });

            expect(reportedByViem).toBe('repriced');
            expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
            expect(outcome.replacement).toBe('replaced');
            // Cross-checking costs nothing: the node saw exactly the requests of a plain viem wait.
            expect(node.calls).toEqual(plain.node.calls);
          },
        );

        // Pins `waitForViemReceipt`'s `'wallet-built'` contract. Only the EIP-5792
        // extra-confirmation wait (2+ confirmations) uses it.
        it('takes a repricing viem names without the submitted transaction to compare against', async () => {
          const { client } = publicClient(REPRICED);

          const outcome = await waitForViemReceipt(client, {
            hash: ORIGINAL,
            confirmations,
            submitted: 'wallet-built',
          });

          expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
          expect(outcome.replacement).toBe('repriced');
        });
      },
    );
  }
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

  it.each(
    MISMATCHED_SUBMISSIONS.flatMap(([name, submitted]) =>
      [1, 2].map((confirmations) => [name, confirmations, submitted] as const),
    ),
  )(
    'fails closed when the mined transaction %s (%i confirmations)',
    async (_name, confirmations, submitted) => {
      const { client, node } = publicClient(REPRICED);

      const outcome = await waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations,
        submitted,
      });
      // On this viem, one confirmation is named a repricing and two are not named at all.
      let reportedByViem: string | undefined;
      const plain = publicClient(REPRICED);
      await waitForTransactionReceipt(plain.client, {
        hash: ORIGINAL,
        confirmations,
        onReplaced: (response) => {
          reportedByViem = response.reason;
        },
      });

      expect(reportedByViem).toBe(confirmations === 1 ? 'repriced' : undefined);
      expect(outcome.receipt.transactionHash).toBe(REPLACEMENT);
      expect(outcome.replacement).toBe('replaced');
      expect(node.calls).toEqual(plain.node.calls);
    },
  );

  // Pins `waitForViemReceipt`'s `'wallet-built'` contract. Only the EIP-5792
  // extra-confirmation wait (2+ confirmations) uses it.
  it('takes a repricing viem names with one confirmation without the submitted transaction', async () => {
    const { client } = publicClient(REPRICED);

    const outcome = await waitForViemReceipt(client, {
      hash: ORIGINAL,
      confirmations: 1,
      submitted: 'wallet-built',
    });

    expect(outcome.replacement).toBe('repriced');
  });

  it('fails closed without the submitted transaction to compare against', async () => {
    const { client } = publicClient(REPRICED);

    const outcome = await waitForViemReceipt(client, {
      hash: ORIGINAL,
      confirmations: 2,
      submitted: 'wallet-built',
    });

    expect(outcome.replacement).toBe('replaced');
  });
});

function plan({ from = ACCOUNT, data = '0x1234' }: { from?: Address; data?: Hex } = {}) {
  const steps = ['one', 'two'].map((id) => {
    const step = createTransactionRequest({
      id,
      chainId: base.id,
      from,
      to: TARGET,
      data,
      operation: 'SWAP_EXACT_IN',
    });
    if (step.isErr()) throw step.error;
    return step.value;
  });
  const result = createExecutionPlan({ steps: [steps[0]!] });
  if (result.isErr()) throw result.error;
  return { single: result.value, steps };
}

function walletClient(
  replacement: Mined,
  account: Address = ACCOUNT,
  options: { readonly dataSuffix?: DataSuffix; readonly speedsUpSent?: boolean } = {},
) {
  const node = scriptedNode(replacement, { speedsUpSent: options.speedsUpSent ?? false });
  return {
    node,
    wallet: createWalletClient({
      ...(options.dataSuffix === undefined ? {} : { dataSuffix: options.dataSuffix }),
      account,
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

/**
 * What an adapter submits when the transaction that mines under its hash is
 * not what it asked for. viem calls the replacement of that transaction a
 * repricing; the adapter must not.
 */
const MISMATCHED_STEPS: readonly (readonly [string, { from?: Address; data?: Hex }])[] = [
  ['the wallet sent from another account', { from: TARGET }],
  ['the wallet sent other calldata', { data: '0xdeadbeef' }],
];

const MISMATCH_CASES = MISMATCHED_STEPS.flatMap(([name, step]) =>
  [1, 2].map((confirmations) => [name, confirmations, step] as const),
);

function expectReplacementFailure(result: Awaited<ReturnType<typeof sendWith>>): void {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(ConfirmationError);
    expect(result.error.message).toBe(
      `Transaction ${ORIGINAL} was replaced and cannot be treated as this plan step`,
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
}

describe.each(WAITERS)('adapters cross-checking a repricing against %s', (_name, older) => {
  if (older) emulateViemBefore2_57_12();

  it.each([1, 2])(
    'viem: confirms a genuine repricing (%i confirmations)',
    async (confirmations) => {
      const { wallet } = walletClient(REPRICED);

      const result = await sendWith(wallet, plan().single, { confirmations });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.transactions[0]?.replacement).toEqual({
          reason: 'repriced',
          originalHash: ORIGINAL,
          replacementHash: REPLACEMENT,
        });
      }
    },
  );

  it.each(MISMATCH_CASES)(
    'viem: fails at the replacement stage when %s (%i confirmations)',
    async (_case, confirmations, step) => {
      const { wallet, node } = walletClient(REPRICED, step.from ?? ACCOUNT);
      const twoSteps = createExecutionPlan({ steps: plan(step).steps });
      if (twoSteps.isErr()) throw twoSteps.error;

      const result = await sendWith(wallet, twoSteps.value, { confirmations });

      expectReplacementFailure(result);
      expect(node.sent).toHaveLength(1);
    },
  );

  it.each(MISMATCH_CASES)(
    'Privy: fails at the replacement stage when %s (%i confirmations)',
    async (_case, confirmations, step) => {
      const sendTransaction = vi.fn<() => Promise<{ hash: Hex }>>(async () => ({ hash: ORIGINAL }));
      const privy = {
        wallets: () => ({ ethereum: () => ({ sendTransaction }) }),
      } as unknown as PrivyClient;
      const { client } = publicClient(REPRICED);
      const twoSteps = createExecutionPlan({ steps: plan(step).steps });
      if (twoSteps.isErr()) throw twoSteps.error;

      const result = await sendWithPrivy(
        privy,
        { id: 'wallet-1', address: step.from ?? ACCOUNT },
        twoSteps.value,
        {
          chainId: base.id,
          receiptClient: client as unknown as PublicClient,
          idempotencyKeys: { one: 'key-one', two: 'key-two' },
          confirmations,
        },
      );

      expectReplacementFailure(result);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    },
  );
});

const SUFFIX: Hex = '0xcafe';

/**
 * Whether the installed viem appends a wallet client's `dataSuffix` to the
 * calldata it sends, as it does since 2.45.0. Older viem in the peer range
 * ignores the option, so a suffix never reaches the wire there. The send makes
 * one request to the scripted node and no polling, so it needs no timeout.
 */
const installedViemAppendsDataSuffix = await (async () => {
  const { wallet, node } = walletClient(REPRICED, ACCOUNT, { dataSuffix: SUFFIX });
  await wallet.sendTransaction({ to: TARGET, data: '0x1234' }).catch((cause: unknown) => {
    throw new Error('viem probe failed: the scripted node did not accept the send', { cause });
  });
  return (node.sent[0] as { readonly data?: Hex }).data === `0x1234${SUFFIX.slice(2)}`;
})();

const SUFFIXED_CASES = (
  [
    ['a string', SUFFIX],
    ['a { value } object', { value: SUFFIX }],
  ] as const
).flatMap(([form, dataSuffix]) =>
  [1, 2].map((confirmations) => [form, confirmations, dataSuffix] as const),
);

describe.each(WAITERS)(
  'viem adapter with a dataSuffix wallet client against %s',
  (_name, older) => {
    if (older) emulateViemBefore2_57_12();

    // A builder code (ERC-8021) appended by viem is part of what was broadcast,
    // so the wallet's speed-up carries it too.
    it.each(SUFFIXED_CASES)(
      'confirms a genuine repricing with the suffix as %s (%i confirmations)',
      async (_form, confirmations, dataSuffix) => {
        const { wallet, node } = walletClient(REPRICED, ACCOUNT, {
          dataSuffix,
          speedsUpSent: true,
        });

        const result = await sendWith(wallet, plan().single, { confirmations });

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.transactions[0]).toMatchObject({
            submittedHash: ORIGINAL,
            hash: REPLACEMENT,
            replacement: {
              reason: 'repriced',
              originalHash: ORIGINAL,
              replacementHash: REPLACEMENT,
            },
          });
        }
        // On viem without `dataSuffix`, nothing is appended, by viem or by the adapter.
        const broadcast = (node.sent[0] as { readonly data?: Hex }).data;
        expect(broadcast).toBe(
          installedViemAppendsDataSuffix ? `0x1234${SUFFIX.slice(2)}` : '0x1234',
        );
        // The gas is estimated for the calldata that is broadcast, in one request.
        expect(node.estimated).toEqual([expect.objectContaining({ data: broadcast })]);
        expect(node.sent).toHaveLength(1);
      },
    );

    describe.skipIf(!installedViemAppendsDataSuffix)('since viem 2.45.0', () => {
      // The node holds the calldata without the suffix under the submitted hash,
      // so viem calls the replacement a repricing. It is not what was broadcast.
      it.each(SUFFIXED_CASES)(
        'fails closed when the replacement mined without the suffix given as %s (%i confirmations)',
        async (_form, confirmations, dataSuffix) => {
          const { wallet, node } = walletClient(REPRICED, ACCOUNT, { dataSuffix });
          const twoSteps = createExecutionPlan({ steps: plan().steps });
          if (twoSteps.isErr()) throw twoSteps.error;

          const result = await sendWith(wallet, twoSteps.value, { confirmations });

          expectReplacementFailure(result);
          expect(node.sent).toHaveLength(1);
        },
      );
    });
  },
);
