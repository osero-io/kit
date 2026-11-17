import {
  createPublicClient,
  createWalletClient,
  custom,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

import { sendWith } from '../viem.js';
import { ConfirmationError } from './errors.js';
import { createExecutionPlan, createTransactionRequest } from './plan.js';
import { waitForViemReceipt, type SubmittedTransaction } from './viemReceipt.js';

/**
 * These tests run viem's real `waitForTransactionReceipt` against a scripted
 * JSON-RPC node, because the behaviour under test is viem's own: with more
 * than one confirmation requested it resolves with a replacement's receipt
 * without ever calling `onReplaced`. A mocked waiter cannot show that.
 */

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
function scriptedNode(replacement: Mined) {
  const replacedAt = START_BLOCK + 1n;
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
        if (first === ORIGINAL) return rpcTransaction(ORIGINAL, SUBMITTED_AS_MINED, null);
        if (first === REPLACEMENT && head >= replacedAt) {
          return rpcTransaction(REPLACEMENT, replacement, replacedAt);
        }
        return null;
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
  return { transport: custom({ request }), calls, sent };
}

const SUBMITTED_AS_MINED: Mined = { to: TARGET, input: '0x1234', value: 0n };
const REPRICED = SUBMITTED_AS_MINED;
const CANCELLED: Mined = { to: ACCOUNT, input: '0x', value: 0n };
const OTHER_CALL: Mined = { to: TARGET, input: '0xdeadbeef', value: 0n };

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
    // viem named the reason through onReplaced, so the replacement is not read back.
    expect(node.calls.filter((method) => method === 'eth_getTransactionByHash')).toHaveLength(1);
  });

  it.each([
    ['a repricing', REPRICED, 'repriced'],
    ['a cancellation', CANCELLED, 'cancelled'],
    ['a different call', OTHER_CALL, 'replaced'],
  ] as const)(
    'classifies %s itself when two confirmations make viem skip onReplaced',
    async (_name, replacement, expected) => {
      const { client } = publicClient(replacement);

      const outcome = await waitForViemReceipt(client, {
        hash: ORIGINAL,
        confirmations: 2,
        submitted: SUBMITTED,
      });
      // The premise, checked on a fresh node: viem's own callback stays silent here.
      let reportedByViem: string | undefined;
      const direct = await publicClient(replacement).client.waitForTransactionReceipt({
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
    },
  );

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

describe('viem adapter with multiple confirmations against the real viem waiter', () => {
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
