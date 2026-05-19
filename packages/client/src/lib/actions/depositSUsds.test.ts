import { decodeFunctionData, parseUnits } from 'viem';

import { erc4626Abi } from '../abis/erc4626.js';
import { psm3Abi } from '../abis/psm3.js';
import { PSM_ADDRESSES } from '../addresses.js';
import { UnsupportedChainError, ValidationError } from '../errors.js';
import { OseroClient } from '../OseroClient.js';
import { getToken } from '../tokens.js';
import { installMockPublicClient } from './_testing.js';
import { depositSUsds, previewDepositSUsds } from './depositSUsds.js';

const SENDER = '0x1111111111111111111111111111111111111111' as const;
const RECEIVER = '0x2222222222222222222222222222222222222222' as const;

describe('depositSUsds', () => {
  it('rejects an unsupported chain', async () => {
    const client = OseroClient.create();
    const result = await depositSUsds(client, {
      chainId: 137,
      amount: 1n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnsupportedChainError);
    }
  });

  it('rejects a zero amount', async () => {
    const client = OseroClient.create();
    const result = await depositSUsds(client, {
      chainId: 1,
      amount: 0n,
      sender: SENDER,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it('rejects a negative referral code', async () => {
    const client = OseroClient.create();
    const result = await depositSUsds(client, {
      chainId: 8453,
      amount: 1n,
      sender: SENDER,
      referralCode: -1n,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it('rejects a mainnet referral code above the supported range', async () => {
    const client = OseroClient.create();
    const result = await depositSUsds(client, {
      chainId: 1,
      amount: 1n,
      sender: SENDER,
      referralCode: 65_536n,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  describe('previewDepositSUsds', () => {
    it('rejects an unsupported chain', async () => {
      const client = OseroClient.create();
      const result = await previewDepositSUsds(client, {
        chainId: 137,
        amount: 1n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(UnsupportedChainError);
      }
    });

    it('rejects a zero amount', async () => {
      const client = OseroClient.create();
      const result = await previewDepositSUsds(client, {
        chainId: 1,
        amount: 0n,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
      }
    });

    it('previews the mainnet sUSDS output via previewDeposit', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 18);
      const sharesOut = parseUnits('995', 18);
      const mock = installMockPublicClient(client, 1, ({ address, functionName, args }) => {
        expect(address).toBe(getToken(1, 'sUSDS').address);
        if (functionName === 'previewDeposit') {
          expect(args).toEqual([amount]);
          return sharesOut;
        }
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewDepositSUsds(client, {
        chainId: 1,
        amount,
      });

      expect(mock.readContract).toHaveBeenCalledTimes(1);
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(sharesOut);
    });

    it('previews the L2 sUSDS output via PSM3.previewSwapExactIn', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 18);
      const quote = parseUnits('999.5', 18);
      const mock = installMockPublicClient(client, 8453, ({ address, functionName, args }) => {
        expect(address).toBe(PSM_ADDRESSES[8453]!.psm);
        if (functionName === 'previewSwapExactIn') {
          expect(args).toEqual([
            getToken(8453, 'USDS').address,
            getToken(8453, 'sUSDS').address,
            amount,
          ]);
          return quote;
        }
        throw new Error(`unexpected read ${functionName}`);
      });

      const result = await previewDepositSUsds(client, {
        chainId: 8453,
        amount,
      });

      expect(mock.readContract).toHaveBeenCalledTimes(1);
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value).toBe(quote);
    });
  });

  describe('mainnet (chain 1)', () => {
    it('builds an Erc20ApprovalRequired via sUSDS.deposit', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 18);

      const result = await depositSUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals[0]!.token).toBe(getToken(1, 'USDS').address);
      expect(plan.approvals[0]!.spender).toBe(getToken(1, 'sUSDS').address);
      expect(plan.approvals[0]!.amount).toBe(amount);

      const deposit = decodeFunctionData({
        abi: erc4626Abi,
        data: plan.originalTransaction.data,
      });
      expect(deposit.functionName).toBe('deposit');
      expect(deposit.args?.[0]).toBe(amount);
      expect(deposit.args?.[1]).toBe(SENDER);
      expect(deposit.args).toHaveLength(3);
      expect(deposit.args?.[2]).toBe(3000);
      expect(plan.originalTransaction.to).toBe(getToken(1, 'sUSDS').address);
      expect(plan.originalTransaction.operation).toBe('DEPOSIT_USDS_FOR_SUSDS');
    });

    it('respects an explicit receiver and mainnet referral code', async () => {
      const client = OseroClient.create();
      const amount = parseUnits('1000', 18);

      const result = await depositSUsds(client, {
        chainId: 1,
        amount,
        sender: SENDER,
        receiver: RECEIVER,
        referralCode: 42n,
      });
      if (!result.isOk()) throw result.error;

      const depositArgs = decodeFunctionData({
        abi: erc4626Abi,
        data: result.value.originalTransaction.data,
      }).args as readonly unknown[];

      expect(depositArgs).toHaveLength(3);
      expect(depositArgs[0]).toBe(amount);
      expect(depositArgs[1]).toBe(RECEIVER);
      expect(depositArgs[2]).toBe(42);
    });

    it('opts out of the mainnet deposit referral overload', async () => {
      const client = OseroClient.create();
      const result = await depositSUsds(client, {
        chainId: 1,
        amount: parseUnits('1000', 18),
        sender: SENDER,
        referralCode: undefined,
      });
      if (!result.isOk()) throw result.error;

      const depositArgs = decodeFunctionData({
        abi: erc4626Abi,
        data: result.value.originalTransaction.data,
      }).args as readonly unknown[];

      expect(depositArgs).toHaveLength(2);
    });
  });

  describe('L2 (chain 8453, Base)', () => {
    it('builds an Erc20ApprovalRequired via PSM3.swapExactIn(USDS, sUSDS)', async () => {
      const client = OseroClient.create({ defaultSlippageBps: 5 });
      const quote = 999_500_000_000_000_000_000n;
      installMockPublicClient(client, 8453, ({ functionName }) => {
        if (functionName === 'previewSwapExactIn') return quote;
        throw new Error(`unexpected read ${functionName}`);
      });

      const amount = parseUnits('1000', 18);
      const result = await depositSUsds(client, {
        chainId: 8453,
        amount,
        sender: SENDER,
      });
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const plan = result.value;
      expect(plan.__typename).toBe('Erc20ApprovalRequired');
      expect(plan.approvals[0]!.token).toBe(getToken(8453, 'USDS').address);
      expect(plan.approvals[0]!.spender).toBe(PSM_ADDRESSES[8453]!.psm);
      expect(plan.approvals[0]!.amount).toBe(amount);

      const main = decodeFunctionData({
        abi: psm3Abi,
        data: plan.originalTransaction.data,
      });
      expect(main.functionName).toBe('swapExactIn');
      const args = main.args as readonly unknown[];
      expect(args[0]).toBe(getToken(8453, 'USDS').address);
      expect(args[1]).toBe(getToken(8453, 'sUSDS').address);
      expect(args[2]).toBe(amount);
      expect(args[3]).toBe((quote * 9995n) / 10_000n);
      expect(args[4]).toBe(SENDER);
      expect(args[5]).toBe(3000n);
      expect(plan.originalTransaction.operation).toBe('DEPOSIT_USDS_FOR_SUSDS');
    });
  });
});
