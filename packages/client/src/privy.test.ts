import { APIUserAbortError } from '@privy-io/node';
import { vi } from 'vitest';

import { CancelError, SigningError, TransactionError, UnexpectedError } from './lib/errors.js';
import { makeSingleApprovalPlan, makeTransactionRequest } from './lib/plan.js';
import { sendWith, type PrivyWallet } from './privy.js';

const actions = vi.hoisted(() => ({
  waitForTransactionReceipt: vi.fn<
    (
      client: unknown,
      args: { readonly hash: `0x${string}`; readonly confirmations?: number },
    ) => Promise<{
      readonly status: 'success' | 'reverted';
      readonly transactionHash: `0x${string}`;
    }>
  >(),
}));

vi.mock('viem/actions', () => actions);

const WALLET_ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const TARGET = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const HASH = `0x${'1'.repeat(64)}` as const;
const WALLET_ID = 'wallet_123';
const AUTHORIZATION_CONTEXT = { authorization_private_keys: ['authorization-key'] };
const PRIVY_WALLET = {
  id: WALLET_ID,
  address: WALLET_ADDRESS,
  authorizationContext: AUTHORIZATION_CONTEXT,
} satisfies PrivyWallet;

function requestFor(chainId: number) {
  return makeTransactionRequest({
    chainId,
    from: WALLET_ADDRESS,
    to: TARGET,
    data: '0x1234',
    value: 123n,
    operation: 'MINT_USDS',
  });
}

function approvalPlanFor(chainId: number) {
  return makeSingleApprovalPlan({
    chainId,
    from: WALLET_ADDRESS,
    token: TOKEN,
    spender: TARGET,
    amount: 5n,
    mainTransaction: requestFor(chainId),
  });
}

function fakePrivy(
  sendTransaction = vi.fn<
    (walletId: string, input: Record<string, unknown>) => Promise<{ readonly hash: string }>
  >(),
) {
  const ethereum = vi.fn<() => { readonly sendTransaction: typeof sendTransaction }>(() => ({
    sendTransaction,
  }));
  const wallets = vi.fn<() => { readonly ethereum: typeof ethereum }>(() => ({ ethereum }));

  return {
    privy: {
      wallets,
    } as unknown as Parameters<typeof sendWith>[0],
    wallets,
    ethereum,
    sendTransaction,
  };
}

describe('Privy sendWith', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a transaction through Privy using the request chain as CAIP-2', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: HASH });
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: HASH,
    });

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453), {
      confirmations: 2,
      idempotencyKeys: ['mint-usds-1'],
    });

    expect(result.isOk()).toBe(true);
    expect(sendTransaction).toHaveBeenCalledWith(WALLET_ID, {
      caip2: 'eip155:8453',
      authorization_context: AUTHORIZATION_CONTEXT,
      idempotency_key: 'mint-usds-1',
      params: {
        transaction: {
          from: WALLET_ADDRESS,
          to: TARGET,
          value: '0x7b',
          chain_id: 8453,
          data: '0x1234',
        },
      },
    });
    expect(actions.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hash: HASH, confirmations: 2 }),
    );
    if (result.isOk()) {
      expect(result.value.txHash).toBe(HASH);
      expect(result.value.operations).toEqual(['MINT_USDS']);
    }
  });

  it('omits authorization_context and idempotency_key from the payload when not provided', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: HASH });
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: HASH,
    });
    const wallet = { id: WALLET_ID, address: WALLET_ADDRESS } satisfies PrivyWallet;

    const result = await sendWith(privy, wallet, requestFor(8453));

    expect(result.isOk()).toBe(true);
    expect(Object.keys(sendTransaction.mock.calls[0]![1])).toEqual(['caip2', 'params']);
  });

  it('broadcasts a multi-transaction plan in order with one idempotency key per transaction', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: HASH });
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: HASH,
    });

    const result = await sendWith(privy, PRIVY_WALLET, approvalPlanFor(8453), {
      idempotencyKeys: ['approve-1', 'mint-1'],
    });

    expect(result.isOk()).toBe(true);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(actions.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(sendTransaction.mock.calls[0]![1]).toMatchObject({
      idempotency_key: 'approve-1',
      params: { transaction: expect.objectContaining({ to: TOKEN }) },
    });
    expect(sendTransaction.mock.calls[1]![1]).toMatchObject({
      idempotency_key: 'mint-1',
      params: { transaction: expect.objectContaining({ to: TARGET }) },
    });
    if (result.isOk()) {
      expect(result.value.operations).toEqual(['APPROVE_ERC20', 'MINT_USDS']);
    }
  });

  it('restarts idempotency key assignment when a curried handler is reused', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: HASH });
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: HASH,
    });

    const handler = sendWith(privy, PRIVY_WALLET, { idempotencyKeys: ['retry-key'] });

    const first = await handler(requestFor(8453));
    const second = await handler(requestFor(8453));

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(sendTransaction.mock.calls[0]![1]).toMatchObject({ idempotency_key: 'retry-key' });
    expect(sendTransaction.mock.calls[1]![1]).toMatchObject({ idempotency_key: 'retry-key' });
  });

  it('fails before sending when the idempotency key count does not match the plan', async () => {
    const { privy, sendTransaction } = fakePrivy();

    const result = await sendWith(privy, PRIVY_WALLET, approvalPlanFor(8453), {
      idempotencyKeys: ['only-one'],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe(
        'Execution plan has 2 transaction(s) but 1 Privy idempotency key(s) were provided; pass exactly one key per transaction',
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('returns TransactionError when the receipt is reverted', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: HASH });
    actions.waitForTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      transactionHash: HASH,
    });

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TransactionError);
      expect(result.error).toMatchObject({
        txHash: HASH,
        link: `https://basescan.org/tx/${HASH}`,
      });
    }
  });

  it('returns SigningError when Privy rejects the transaction', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockRejectedValue(new Error('policy violation'));

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(SigningError);
    }
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('returns CancelError when the Privy request is aborted', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockRejectedValue(new APIUserAbortError());

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(CancelError);
    }
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('returns UnexpectedError when Privy does not return a valid transaction hash', async () => {
    const { privy, sendTransaction } = fakePrivy();
    sendTransaction.mockResolvedValue({ hash: '' });

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toContain('did not return a valid transaction hash');
    }
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('fails before sending when the Privy wallet address does not match the transaction sender', async () => {
    const { privy, sendTransaction } = fakePrivy();
    const wallet = { ...PRIVY_WALLET, address: TARGET } satisfies PrivyWallet;

    const result = await sendWith(privy, wallet, requestFor(8453));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe(
        `Privy wallet ${WALLET_ID} address ${TARGET} does not match transaction sender ${WALLET_ADDRESS}`,
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('fails before sending when the idempotency key is empty', async () => {
    const { privy, sendTransaction } = fakePrivy();

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453), {
      idempotencyKeys: [''],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe('Privy idempotency key cannot be empty');
    }
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('fails before sending when the idempotency key exceeds the Privy limit', async () => {
    const { privy, sendTransaction } = fakePrivy();

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(8453), {
      idempotencyKeys: ['k'.repeat(257)],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe('Privy idempotency key cannot exceed 256 characters');
    }
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('fails before sending when the plan targets an unsupported chain', async () => {
    const { privy, sendTransaction } = fakePrivy();

    const result = await sendWith(privy, PRIVY_WALLET, requestFor(999999));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnexpectedError);
      expect(result.error.message).toBe('Privy adapter cannot wait for unsupported chain 999999');
    }
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(actions.waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});
