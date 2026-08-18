import type { Account, Address, Chain, Hex, Transport, WalletClient } from 'viem';
import {
  getCapabilities,
  getTransactionReceipt,
  sendCalls,
  waitForCallsStatus,
  waitForTransactionReceipt,
} from 'viem/actions';

import { preflightExecutorCapabilities } from './lib/adapters.js';
import {
  CancelError,
  ConfigurationError,
  ConfirmationError,
  ProgressCallbackError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedCapabilityError,
  ValidationError,
  type ExecutionFailureContext,
  type ExecutionStage,
} from './lib/errors.js';
import { checkExecutionPlanExpiry } from './lib/plan.js';
import { err, errAsync, ok, ResultAsync, type Result } from './lib/result.js';
import type {
  ConfirmedTransaction,
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutionProgress,
  ExecutorCapabilities,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';
import {
  validateConfirmations,
  validateExecutorBinding,
  validateResumeState,
} from './lib/validation.js';
import { sendWith as sendWithViem, type SendWithOptions as ViemSendWithOptions } from './viem.js';

export type SendWithOptions = ViemSendWithOptions & {
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly fallbackToSequential?: boolean;
};

type NonEmpty<T> = readonly [T, ...T[]];

type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

type ResolvedOptions = SendWithOptions & {
  readonly confirmations: number;
  readonly gasBufferBps: number;
  readonly confirmationTimeoutMs: number;
  readonly fallbackToSequential: boolean;
};

type IndexedStep = {
  readonly index: number;
  readonly transaction: TransactionRequest;
};

type AtomicCall = {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
};

type AtomicBatchEntry = {
  readonly step: IndexedStep;
  readonly call: AtomicCall;
};

type AtomicBatch = {
  readonly kind: 'atomic-batch';
  readonly planId: string;
  readonly account: Address;
  readonly chainId: number;
  readonly entries: NonEmpty<AtomicBatchEntry>;
};

type PreparedExecution =
  | {
      readonly kind: 'complete';
      readonly plan: ExecutionPlan;
      readonly confirmed: NonEmpty<ConfirmedTransaction>;
      readonly options: ResolvedOptions;
    }
  | {
      readonly kind: 'pending';
      readonly plan: ExecutionPlan;
      readonly confirmed: readonly ConfirmedTransaction[];
      readonly pending: NonEmpty<IndexedStep>;
      readonly account: Address;
      readonly chainId: number;
      readonly options: ResolvedOptions;
    };

type AtomicSupport =
  | {
      readonly kind: 'available';
      readonly status: 'supported' | 'ready';
    }
  | {
      readonly kind: 'unavailable';
    };

declare const batchIdBrand: unique symbol;
type BatchId = string & { readonly [batchIdBrand]: true };

type ConfirmedBatchReceipt = {
  readonly batchId: BatchId;
  readonly terminal: {
    readonly transactionHash: Hex;
    readonly blockNumber?: bigint;
    readonly gasUsed?: bigint;
    readonly effectiveGasPrice?: bigint;
  };
};

type AtomicBatchOutcome =
  | {
      readonly kind: 'confirmed';
      readonly receipt: ConfirmedBatchReceipt;
    }
  | {
      readonly kind: 'atomic-unavailable';
    };

const EIP5792_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
  name: 'eip5792',
  sequentialTransactions: true,
  atomicBatch: true,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'none',
};

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

class Eip5792UnexpectedError extends UnexpectedError {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

function hasConnectedAccount(walletClient: WalletClient): walletClient is ConnectedWalletClient {
  return walletClient.account !== undefined && walletClient.chain !== undefined;
}

function resolveOptions(
  options: SendWithOptions | undefined,
): Result<ResolvedOptions, ValidationError> {
  const confirmations = validateConfirmations(options?.confirmations ?? 1);
  if (confirmations.isErr()) return err(confirmations.error);
  const gasBufferBps = options?.gasBufferBps ?? 1_500;
  if (!Number.isSafeInteger(gasBufferBps) || gasBufferBps < 0 || gasBufferBps > 10_000) {
    return err(
      ValidationError.forField('gasBufferBps', 'gasBufferBps must be an integer in [0, 10000]'),
    );
  }
  const confirmationTimeoutMs = options?.confirmationTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) {
    return err(
      ValidationError.forField(
        'confirmationTimeoutMs',
        'confirmationTimeoutMs must be a positive safe integer',
      ),
    );
  }
  if (options?.onProgress !== undefined && typeof options.onProgress !== 'function') {
    return err(ValidationError.forField('onProgress', 'onProgress must be a function'));
  }
  if (
    options?.fallbackToSequential !== undefined &&
    typeof options.fallbackToSequential !== 'boolean'
  ) {
    return err(
      ValidationError.forField('fallbackToSequential', 'fallbackToSequential must be a boolean'),
    );
  }
  if (
    options?.capabilities !== undefined &&
    (typeof options.capabilities !== 'object' ||
      options.capabilities === null ||
      Array.isArray(options.capabilities))
  ) {
    return err(ValidationError.forField('capabilities', 'capabilities must be an object'));
  }
  return ok({
    ...options,
    confirmations: confirmations.value,
    gasBufferBps,
    confirmationTimeoutMs,
    fallbackToSequential: options?.fallbackToSequential ?? true,
  });
}

function decodeAtomicSupport(value: unknown): AtomicSupport {
  if (typeof value !== 'object' || value === null || !('atomic' in value)) {
    return { kind: 'unavailable' };
  }
  const atomic = value.atomic;
  if (typeof atomic !== 'object' || atomic === null || !('status' in atomic)) {
    return { kind: 'unavailable' };
  }
  if (atomic.status === 'supported' || atomic.status === 'ready') {
    return { kind: 'available', status: atomic.status };
  }
  return { kind: 'unavailable' };
}

async function probeAtomicSupport(
  walletClient: ConnectedWalletClient,
  account: Address,
  chainId: number,
): Promise<AtomicSupport> {
  try {
    const capabilities = await getCapabilities(walletClient, { account, chainId });
    return decodeAtomicSupport(capabilities);
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function supportsAtomicBatch(walletClient: WalletClient): Promise<boolean> {
  if (!hasConnectedAccount(walletClient)) return false;
  const support = await probeAtomicSupport(
    walletClient,
    walletClient.account.address,
    walletClient.chain.id,
  );
  return support.kind === 'available';
}

function failureContext(
  plan: ExecutionPlan,
  step: IndexedStep,
  stage: ExecutionStage,
  completed: readonly ConfirmedTransaction[],
  hash?: Hex,
): ExecutionFailureContext {
  return {
    planId: plan.id,
    stepId: step.transaction.id,
    stepIndex: step.index,
    operation: step.transaction.operation,
    stage,
    ...(hash === undefined ? {} : { hash }),
    completed: completed.map((transaction) => ({
      planId: transaction.planId,
      stepId: transaction.stepId,
      stepIndex: transaction.stepIndex,
      operation: transaction.operation,
      hash: transaction.hash,
    })),
  };
}

function verifyResumeReceipts(
  walletClient: ConnectedWalletClient,
  plan: ExecutionPlan,
  options: ResolvedOptions,
): ResultAsync<readonly ConfirmedTransaction[], SendWithError> {
  const resume = validateResumeState(plan, options.resume);
  if (resume.isErr()) return errAsync(resume.error);

  const verification = async (): Promise<
    Result<readonly ConfirmedTransaction[], SendWithError>
  > => {
    // oxlint-disable no-await-in-loop -- Resume proofs must be checked in prefix order.
    for (const transaction of resume.value) {
      const step = {
        index: transaction.stepIndex,
        transaction: plan.steps[transaction.stepIndex]!,
      };
      let receipt: unknown;
      try {
        receipt = await getTransactionReceipt(walletClient, { hash: transaction.hash });
      } catch (cause) {
        return err(
          ConfirmationError.from(
            cause,
            failureContext(
              plan,
              step,
              'confirmation',
              resume.value.slice(0, transaction.stepIndex),
              transaction.hash,
            ),
          ),
        );
      }
      if (
        typeof receipt !== 'object' ||
        receipt === null ||
        !('status' in receipt) ||
        receipt.status !== 'success' ||
        !('transactionHash' in receipt) ||
        typeof receipt.transactionHash !== 'string' ||
        receipt.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()
      ) {
        return err(
          new ConfirmationError(
            `Resume proof for step ${step.transaction.id} is not a successful matching receipt`,
            failureContext(
              plan,
              step,
              'confirmation',
              resume.value.slice(0, transaction.stepIndex),
              transaction.hash,
            ),
          ),
        );
      }
    }
    // oxlint-enable no-await-in-loop
    return ok(resume.value);
  };

  return new ResultAsync(verification());
}

function prepareExecution(
  walletClient: ConnectedWalletClient,
  plan: ExecutionPlan,
  options: ResolvedOptions,
): ResultAsync<PreparedExecution, SendWithError> {
  const binding = validateExecutorBinding(
    plan,
    walletClient.account.address,
    walletClient.chain.id,
  );
  if (binding.isErr()) return errAsync(binding.error);
  const capability = preflightExecutorCapabilities(binding.value, EIP5792_EXECUTOR_CAPABILITIES);
  if (capability.isErr()) return errAsync(capability.error);

  return verifyResumeReceipts(walletClient, binding.value, options).map((confirmed) => {
    const pending = binding.value.steps.slice(confirmed.length).map((transaction, offset) => ({
      index: confirmed.length + offset,
      transaction,
    }));
    if (pending.length === 0) {
      return {
        kind: 'complete',
        plan: binding.value,
        confirmed: confirmed as NonEmpty<ConfirmedTransaction>,
        options,
      };
    }
    return {
      kind: 'pending',
      plan: binding.value,
      confirmed,
      pending: pending as unknown as NonEmpty<IndexedStep>,
      account: walletClient.account.address,
      chainId: walletClient.chain.id,
      options,
    };
  });
}

function toAtomicCall(transaction: TransactionRequest): AtomicCall {
  return {
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
  };
}

function groupPendingSteps(
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
): AtomicBatch {
  return {
    kind: 'atomic-batch',
    planId: execution.plan.id,
    account: execution.account,
    chainId: execution.chainId,
    entries: execution.pending.map((step) => ({
      step,
      call: toAtomicCall(step.transaction),
    })) as unknown as NonEmpty<AtomicBatchEntry>,
  };
}

function getErrorCode(cause: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'number') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function mapSendCallsError(
  cause: unknown,
  plan: ExecutionPlan,
  batch: AtomicBatch,
  completed: readonly ConfirmedTransaction[],
): Result<AtomicBatchOutcome, SendWithError> {
  const code = getErrorCode(cause);
  if (code === 5760) return ok({ kind: 'atomic-unavailable' });
  const first = batch.entries[0].step;
  const signingFailed = code === 4001 || code === 4100 || code === 5750;
  const context = failureContext(plan, first, signingFailed ? 'signing' : 'broadcast', completed);
  if (code === 4001 || code === 5750) return err(CancelError.from(cause, context));
  if (code === 4100) return err(SigningError.from(cause, context));
  return err(UnexpectedError.from(cause));
}

function asReceipt(value: unknown): {
  readonly status: 'success' | 'reverted';
  readonly transactionHash: Hex;
  readonly blockNumber?: bigint;
  readonly gasUsed?: bigint;
  readonly effectiveGasPrice?: bigint;
} | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    (value.status !== 'success' && value.status !== 'reverted') ||
    !('transactionHash' in value) ||
    typeof value.transactionHash !== 'string' ||
    !HASH_PATTERN.test(value.transactionHash)
  ) {
    return null;
  }
  return {
    status: value.status,
    transactionHash: value.transactionHash as Hex,
    ...('blockNumber' in value && typeof value.blockNumber === 'bigint'
      ? { blockNumber: value.blockNumber }
      : {}),
    ...('gasUsed' in value && typeof value.gasUsed === 'bigint' ? { gasUsed: value.gasUsed } : {}),
    ...('effectiveGasPrice' in value && typeof value.effectiveGasPrice === 'bigint'
      ? { effectiveGasPrice: value.effectiveGasPrice }
      : {}),
  };
}

function unexpected(message: string, cause: unknown): UnexpectedError {
  return new Eip5792UnexpectedError(message, cause);
}

function decodeConfirmedBatchReceipt(
  value: unknown,
  plan: ExecutionPlan,
  batch: AtomicBatch,
  batchId: BatchId,
): Result<ConfirmedBatchReceipt, SendWithError> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('statusCode' in value) ||
    typeof value.statusCode !== 'number' ||
    !('receipts' in value) ||
    !Array.isArray(value.receipts)
  ) {
    return err(unexpected(`Call batch ${batchId} returned a malformed status`, value));
  }
  const receipts = value.receipts.map(asReceipt);
  const lastReceipt = receipts.toReversed().find((receipt) => receipt !== null);
  if (value.statusCode === 500 || value.statusCode === 600) {
    if (lastReceipt !== undefined && lastReceipt !== null) {
      return err(
        new TransactionError(
          `Call batch ${batchId} failed at transaction ${lastReceipt.transactionHash}`,
          lastReceipt.transactionHash,
          failureContext(
            plan,
            batch.entries[batch.entries.length - 1].step,
            'revert',
            [],
            lastReceipt.transactionHash,
          ),
          { cause: value },
        ),
      );
    }
    return err(unexpected(`Call batch ${batchId} failed without a transaction receipt`, value));
  }
  if (
    value.statusCode !== 200 ||
    ('atomic' in value && value.atomic === false) ||
    (receipts.length !== 1 && receipts.length !== batch.entries.length) ||
    receipts.some((receipt) => receipt === null || receipt.status !== 'success')
  ) {
    return err(unexpected(`Call batch ${batchId} returned an invalid terminal status`, value));
  }
  const terminal = receipts[receipts.length - 1]!;
  if (terminal === null) {
    return err(unexpected(`Call batch ${batchId} did not return a terminal receipt`, value));
  }
  return ok({
    batchId,
    terminal: {
      transactionHash: terminal.transactionHash,
      ...(terminal.blockNumber === undefined ? {} : { blockNumber: terminal.blockNumber }),
      ...(terminal.gasUsed === undefined ? {} : { gasUsed: terminal.gasUsed }),
      ...(terminal.effectiveGasPrice === undefined
        ? {}
        : { effectiveGasPrice: terminal.effectiveGasPrice }),
    },
  });
}

async function executeAtomicBatch(
  walletClient: ConnectedWalletClient,
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
  batch: AtomicBatch,
): Promise<Result<AtomicBatchOutcome, SendWithError>> {
  let response: unknown;
  try {
    response = await sendCalls(walletClient, {
      account: walletClient.account,
      chain: walletClient.chain,
      calls: batch.entries.map((entry) => entry.call),
      forceAtomic: true,
      experimental_fallback: false,
      ...(execution.options.capabilities === undefined
        ? {}
        : { capabilities: execution.options.capabilities as never }),
    });
  } catch (cause) {
    return mapSendCallsError(cause, execution.plan, batch, execution.confirmed);
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    !('id' in response) ||
    typeof response.id !== 'string' ||
    response.id.length === 0
  ) {
    return err(UnexpectedError.from(new Error('wallet_sendCalls returned an invalid batch id')));
  }
  const batchId = response.id as BatchId;

  let status: unknown;
  try {
    status = await waitForCallsStatus(walletClient, {
      id: batchId,
      timeout: execution.options.confirmationTimeoutMs,
    });
  } catch (cause) {
    return err(unexpected(`Failed while waiting for call batch ${batchId}`, cause));
  }
  const decoded = decodeConfirmedBatchReceipt(status, execution.plan, batch, batchId);
  if (decoded.isErr()) return err(decoded.error);
  if (execution.options.confirmations === 1)
    return ok({ kind: 'confirmed', receipt: decoded.value });

  let receipt: unknown;
  try {
    receipt = await waitForTransactionReceipt(walletClient, {
      hash: decoded.value.terminal.transactionHash,
      confirmations: execution.options.confirmations,
      timeout: execution.options.confirmationTimeoutMs,
    });
  } catch (cause) {
    return err(
      ConfirmationError.from(
        cause,
        failureContext(
          execution.plan,
          batch.entries[batch.entries.length - 1].step,
          'confirmation',
          execution.confirmed,
          decoded.value.terminal.transactionHash,
        ),
      ),
    );
  }
  const confirmed = asReceipt(receipt);
  if (confirmed === null || confirmed.status !== 'success') {
    return err(
      new TransactionError(
        `Transaction ${decoded.value.terminal.transactionHash} reverted`,
        decoded.value.terminal.transactionHash,
        failureContext(
          execution.plan,
          batch.entries[batch.entries.length - 1].step,
          'revert',
          execution.confirmed,
          decoded.value.terminal.transactionHash,
        ),
        { cause: receipt },
      ),
    );
  }
  return ok({
    kind: 'confirmed',
    receipt: {
      batchId,
      terminal: {
        transactionHash: confirmed.transactionHash,
        ...(confirmed.blockNumber === undefined ? {} : { blockNumber: confirmed.blockNumber }),
        ...(confirmed.gasUsed === undefined ? {} : { gasUsed: confirmed.gasUsed }),
        ...(confirmed.effectiveGasPrice === undefined
          ? {}
          : { effectiveGasPrice: confirmed.effectiveGasPrice }),
      },
    },
  });
}

function buildCompletedResult(
  execution: Extract<PreparedExecution, { readonly kind: 'complete' }>,
): TransactionResult {
  const last = execution.confirmed[execution.confirmed.length - 1];
  return {
    planId: execution.plan.id,
    transactions: execution.confirmed,
    txHash: last.hash,
  };
}

function toLogicalConfirmation(
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
  step: IndexedStep,
  receipt: ConfirmedBatchReceipt,
): ConfirmedTransaction {
  const hash = receipt.terminal.transactionHash;
  return {
    planId: execution.plan.id,
    stepId: step.transaction.id,
    stepIndex: step.index,
    operation: step.transaction.operation,
    submittedHash: hash,
    hash,
    confirmation: {
      status: 'success',
      transactionHash: hash,
      ...(receipt.terminal.blockNumber === undefined
        ? {}
        : { blockNumber: receipt.terminal.blockNumber }),
      ...(receipt.terminal.gasUsed === undefined ? {} : { gasUsed: receipt.terminal.gasUsed }),
      ...(receipt.terminal.effectiveGasPrice === undefined
        ? {}
        : { effectiveGasPrice: receipt.terminal.effectiveGasPrice }),
      confirmations: execution.options.confirmations,
    },
  };
}

function buildAtomicResult(
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
  receipt: ConfirmedBatchReceipt,
): TransactionResult {
  const transactions = [
    ...execution.confirmed,
    ...execution.pending.map((step) => toLogicalConfirmation(execution, step, receipt)),
  ];
  return {
    planId: execution.plan.id,
    transactions,
    txHash: receipt.terminal.transactionHash,
  };
}

function progressEvents(
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
  result: TransactionResult,
): readonly {
  readonly event: ExecutionProgress;
  readonly step: IndexedStep;
  readonly completed: readonly ConfirmedTransaction[];
}[] {
  const first = execution.pending[0];
  const events: {
    event: ExecutionProgress;
    step: IndexedStep;
    completed: readonly ConfirmedTransaction[];
  }[] = [
    {
      event: {
        type: 'preflight-complete',
        planId: execution.plan.id,
        totalSteps: execution.plan.steps.length,
        resumedSteps: execution.confirmed.length,
      },
      step: first,
      completed: execution.confirmed,
    },
  ];
  for (const step of execution.pending) {
    const transaction = result.transactions[step.index]!;
    const completed = result.transactions.slice(0, step.index);
    events.push(
      {
        event: {
          type: 'step-started',
          planId: execution.plan.id,
          stepId: step.transaction.id,
          stepIndex: step.index,
          operation: step.transaction.operation,
        },
        step,
        completed,
      },
      {
        event: {
          type: 'step-submitted',
          planId: execution.plan.id,
          stepId: step.transaction.id,
          stepIndex: step.index,
          operation: step.transaction.operation,
          hash: transaction.submittedHash,
        },
        step,
        completed,
      },
      {
        event: { type: 'step-confirmed', transaction },
        step,
        completed: result.transactions.slice(0, step.index + 1),
      },
    );
  }
  events.push({
    event: { type: 'plan-completed', result },
    step: execution.pending[execution.pending.length - 1],
    completed: result.transactions,
  });
  return events;
}

async function emitProgress(
  execution: Extract<PreparedExecution, { readonly kind: 'pending' }>,
  result: TransactionResult,
): Promise<Result<void, SendWithError>> {
  if (execution.options.onProgress === undefined) return ok(undefined);
  // oxlint-disable no-await-in-loop -- Progress callbacks preserve plan order.
  for (const item of progressEvents(execution, result)) {
    try {
      await execution.options.onProgress(item.event);
    } catch (cause) {
      return err(
        ProgressCallbackError.from(
          cause,
          failureContext(execution.plan, item.step, 'progress', item.completed),
        ),
      );
    }
  }
  // oxlint-enable no-await-in-loop
  return ok(undefined);
}

function toViemOptions(options: ResolvedOptions): ViemSendWithOptions {
  return {
    confirmations: options.confirmations,
    gasBufferBps: options.gasBufferBps,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };
}

function executePlan(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  const execution = async (): Promise<Result<TransactionResult, SendWithError>> => {
    try {
      const resolvedOptions = resolveOptions(options);
      if (resolvedOptions.isErr()) return err(resolvedOptions.error);
      if (!hasConnectedAccount(walletClient)) {
        return err(
          new ConfigurationError(
            'sendWith requires a viem WalletClient with both account and chain configured',
            'walletClient',
          ),
        );
      }
      const prepared = await prepareExecution(walletClient, plan, resolvedOptions.value);
      if (prepared.isErr()) return err(prepared.error);
      if (prepared.value.kind === 'complete') return ok(buildCompletedResult(prepared.value));

      const support = await probeAtomicSupport(
        walletClient,
        prepared.value.account,
        prepared.value.chainId,
      );
      if (support.kind === 'unavailable') {
        if (
          prepared.value.plan.requirements.execution === 'atomic-batch' ||
          !prepared.value.options.fallbackToSequential
        ) {
          return err(new UnsupportedCapabilityError('atomic-batch', 'eip5792'));
        }
        return await sendWithViem(
          walletClient,
          prepared.value.plan,
          toViemOptions(prepared.value.options),
        );
      }

      const expiry = checkExecutionPlanExpiry(prepared.value.plan);
      if (expiry.isErr()) return err(expiry.error);
      const batch = groupPendingSteps(prepared.value);
      const outcome = await executeAtomicBatch(walletClient, prepared.value, batch);
      if (outcome.isErr()) return err(outcome.error);
      if (outcome.value.kind === 'atomic-unavailable') {
        if (
          prepared.value.plan.requirements.execution === 'atomic-batch' ||
          !prepared.value.options.fallbackToSequential
        ) {
          return err(new UnsupportedCapabilityError('atomic-batch', 'eip5792'));
        }
        return await sendWithViem(
          walletClient,
          prepared.value.plan,
          toViemOptions(prepared.value.options),
        );
      }
      const result = buildAtomicResult(prepared.value, outcome.value.receipt);
      const progress = await emitProgress(prepared.value, result);
      if (progress.isErr()) return err(progress.error);
      return ok(result);
    } catch (cause) {
      return err(UnexpectedError.from(cause));
    }
  };
  return new ResultAsync(execution());
}

export function sendWith(
  walletClient: WalletClient,
  options?: SendWithOptions,
): ExecutionPlanHandler;
export function sendWith(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError>;
export function sendWith(
  walletClient: WalletClient,
  planOrOptions?: ExecutionPlan | SendWithOptions,
  maybeOptions?: SendWithOptions,
): ExecutionPlanHandler | ResultAsync<TransactionResult, SendWithError> {
  const isPlan =
    typeof planOrOptions === 'object' &&
    planOrOptions !== null &&
    '__typename' in planOrOptions &&
    planOrOptions.__typename === 'ExecutionPlan';
  if (isPlan) return executePlan(walletClient, planOrOptions, maybeOptions);
  const options = planOrOptions as SendWithOptions | undefined;
  return (plan) => executePlan(walletClient, plan, options);
}
