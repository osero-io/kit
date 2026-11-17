import type { Account, Address, Chain, Hex, Transport, WalletClient } from 'viem';
import {
  getCapabilities,
  getTransactionReceipt,
  sendCalls,
  waitForCallsStatus,
} from 'viem/actions';

import { preflightExecutorCapabilities, toCompletedExecutionStep } from './lib/adapters.js';
import {
  BroadcastError,
  CancelError,
  ConfigurationError,
  ConfirmationError,
  OseroError,
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
import { observeResult } from './lib/telemetry.js';
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
import { nonRepricedReplacementError, waitForViemReceipt } from './lib/viemReceipt.js';
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
  /** Set when extra confirmations observed the batch transaction being repriced. */
  readonly repricedFrom?: Hex;
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
  batchId?: BatchId,
): ExecutionFailureContext {
  return {
    planId: plan.id,
    stepId: step.transaction.id,
    stepIndex: step.index,
    operation: step.transaction.operation,
    stage,
    ...(hash === undefined ? {} : { hash }),
    ...(batchId === undefined ? {} : { batchId }),
    completed: completed.map(toCompletedExecutionStep),
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
  // Every other wallet_sendCalls failure is a failed submission, not an SDK defect.
  return err(BroadcastError.from(cause, context));
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

type BatchEvent =
  | { readonly kind: 'preflight-complete' }
  | {
      readonly kind: 'step-started' | 'step-submitted' | 'step-confirmed';
      readonly step: IndexedStep;
    }
  | { readonly kind: 'plan-completed' };

/**
 * Emits progress for an atomic batch as each fact becomes known, so a batch
 * that later fails has still reported what was submitted:
 *
 * - once the wallet accepts the batch: `preflight-complete`, then `step-started`
 *   for every batched step;
 * - once the wallet reports the batch's transaction: `step-submitted` for every
 *   step, carrying that on-chain hash (a batch ID is not a transaction hash, so
 *   nothing is invented before then);
 * - only after the batch is confirmed: `step-confirmed` and `plan-completed`.
 *
 * A throwing callback cannot interrupt a batch the wallet has already accepted:
 * the batch is still confirmed. The first failure stops further events and is
 * returned once the batch succeeds.
 */
function createBatchProgress(execution: Extract<PreparedExecution, { readonly kind: 'pending' }>) {
  const handler = execution.options.onProgress;
  let failed: { readonly cause: unknown; readonly event: BatchEvent } | undefined;
  const emit = async (event: BatchEvent, progress: ExecutionProgress): Promise<void> => {
    if (handler === undefined || failed !== undefined) return;
    try {
      await handler(progress);
    } catch (cause) {
      failed = { cause, event };
    }
  };
  const stepEvent = (step: IndexedStep) => ({
    planId: execution.plan.id,
    stepId: step.transaction.id,
    stepIndex: step.index,
    operation: step.transaction.operation,
  });

  return {
    async batchAccepted(): Promise<void> {
      await emit(
        { kind: 'preflight-complete' },
        {
          type: 'preflight-complete',
          planId: execution.plan.id,
          totalSteps: execution.plan.steps.length,
          resumedSteps: execution.confirmed.length,
        },
      );
      // oxlint-disable no-await-in-loop -- Progress callbacks preserve plan order.
      for (const step of execution.pending) {
        await emit({ kind: 'step-started', step }, { type: 'step-started', ...stepEvent(step) });
      }
      // oxlint-enable no-await-in-loop
    },
    async transactionKnown(hash: Hex): Promise<void> {
      // oxlint-disable no-await-in-loop -- Progress callbacks preserve plan order.
      for (const step of execution.pending) {
        await emit(
          { kind: 'step-submitted', step },
          { type: 'step-submitted', ...stepEvent(step), hash },
        );
      }
      // oxlint-enable no-await-in-loop
    },
    async confirmed(result: TransactionResult): Promise<void> {
      // oxlint-disable no-await-in-loop -- Progress callbacks preserve plan order.
      for (const step of execution.pending) {
        await emit(
          { kind: 'step-confirmed', step },
          { type: 'step-confirmed', transaction: result.transactions[step.index]! },
        );
      }
      // oxlint-enable no-await-in-loop
      await emit({ kind: 'plan-completed' }, { type: 'plan-completed', result });
    },
    /**
     * The callback failure to report for a batch that confirmed, if any.
     *
     * The batch is atomic and has confirmed by the time this is reported, so
     * every step is listed as completed whichever event the callback failed on.
     * Reporting only the steps before that event would describe confirmed steps
     * as pending, and resume state derived from it would send them again.
     */
    failure(result: TransactionResult, batchId: BatchId): ProgressCallbackError | undefined {
      if (failed === undefined) return undefined;
      const { cause, event } = failed;
      const step =
        event.kind === 'preflight-complete'
          ? execution.pending[0]
          : event.kind === 'plan-completed'
            ? execution.pending[execution.pending.length - 1]
            : event.step;
      return ProgressCallbackError.from(
        cause,
        failureContext(execution.plan, step, 'progress', result.transactions, undefined, batchId),
      );
    },
  };
}

type BatchProgress = ReturnType<typeof createBatchProgress>;

function decodeConfirmedBatchReceipt(
  value: unknown,
  plan: ExecutionPlan,
  batch: AtomicBatch,
  batchId: BatchId,
  completed: readonly ConfirmedTransaction[],
): Result<ConfirmedBatchReceipt, SendWithError> {
  const lastStep = batch.entries[batch.entries.length - 1].step;
  // The wallet answered, but not with a status this adapter can accept as proof
  // of confirmation. That is a confirmation failure for a submitted batch.
  const unconfirmed = (message: string, hash?: Hex): ConfirmationError =>
    new ConfirmationError(
      message,
      failureContext(plan, lastStep, 'confirmation', completed, hash, batchId),
      { cause: value },
    );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('statusCode' in value) ||
    typeof value.statusCode !== 'number' ||
    !('receipts' in value) ||
    !Array.isArray(value.receipts)
  ) {
    return err(unconfirmed(`Call batch ${batchId} returned a malformed status`));
  }
  const receipts = value.receipts.map(asReceipt);
  const lastReceipt = receipts.toReversed().find((receipt) => receipt !== null);
  const lastHash = lastReceipt?.transactionHash;
  if (value.statusCode === 500 || value.statusCode === 600) {
    if (lastReceipt !== undefined && lastReceipt !== null) {
      return err(
        new TransactionError(
          `Call batch ${batchId} failed at transaction ${lastReceipt.transactionHash}`,
          lastReceipt.transactionHash,
          failureContext(plan, lastStep, 'revert', completed, lastReceipt.transactionHash, batchId),
          { cause: value },
        ),
      );
    }
    return err(unconfirmed(`Call batch ${batchId} failed without a transaction receipt`));
  }
  if (
    value.statusCode !== 200 ||
    ('atomic' in value && value.atomic === false) ||
    (receipts.length !== 1 && receipts.length !== batch.entries.length) ||
    receipts.some((receipt) => receipt === null || receipt.status !== 'success')
  ) {
    return err(unconfirmed(`Call batch ${batchId} returned an invalid terminal status`, lastHash));
  }
  const terminal = receipts[receipts.length - 1]!;
  if (terminal === null) {
    return err(unconfirmed(`Call batch ${batchId} did not return a terminal receipt`));
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
  progress: BatchProgress,
): Promise<Result<AtomicBatchOutcome, SendWithError>> {
  const firstStep = batch.entries[0].step;
  const lastStep = batch.entries[batch.entries.length - 1].step;
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
    return err(
      new BroadcastError(
        'wallet_sendCalls returned an invalid batch id',
        failureContext(execution.plan, firstStep, 'broadcast', execution.confirmed),
        { cause: response },
      ),
    );
  }
  const batchId = response.id as BatchId;
  await progress.batchAccepted();

  let status: unknown;
  try {
    status = await waitForCallsStatus(walletClient, {
      id: batchId,
      timeout: execution.options.confirmationTimeoutMs,
    });
  } catch (cause) {
    // The batch was accepted; only its outcome is unknown. Never retry blindly.
    return err(
      new ConfirmationError(
        `Failed while waiting for call batch ${batchId}`,
        failureContext(
          execution.plan,
          lastStep,
          'confirmation',
          execution.confirmed,
          undefined,
          batchId,
        ),
        { cause },
      ),
    );
  }
  const decoded = decodeConfirmedBatchReceipt(
    status,
    execution.plan,
    batch,
    batchId,
    execution.confirmed,
  );
  if (decoded.isErr()) {
    if (decoded.error instanceof TransactionError) {
      await progress.transactionKnown(decoded.error.txHash);
    }
    return err(decoded.error);
  }
  const submittedHash = decoded.value.terminal.transactionHash;
  await progress.transactionKnown(submittedHash);
  if (execution.options.confirmations === 1)
    return ok({ kind: 'confirmed', receipt: decoded.value });

  let receipt: unknown;
  let replacement: Awaited<ReturnType<typeof waitForViemReceipt>>['replacement'];
  try {
    const waited = await waitForViemReceipt(walletClient, {
      hash: submittedHash,
      confirmations: execution.options.confirmations,
      timeout: execution.options.confirmationTimeoutMs,
    });
    receipt = waited.receipt;
    replacement = waited.replacement;
  } catch (cause) {
    return err(
      ConfirmationError.from(
        cause,
        failureContext(
          execution.plan,
          lastStep,
          'confirmation',
          execution.confirmed,
          submittedHash,
          batchId,
        ),
      ),
    );
  }
  const confirmed = asReceipt(receipt);
  // Same rule as the sequential adapters: only a same-transaction fee bump may
  // stand in for the batch transaction the wallet reported.
  if (replacement !== undefined && replacement !== 'repriced') {
    return err(
      nonRepricedReplacementError(
        submittedHash,
        replacement,
        confirmed?.transactionHash ?? submittedHash,
        failureContext(
          execution.plan,
          lastStep,
          'replacement',
          execution.confirmed,
          submittedHash,
          batchId,
        ),
      ),
    );
  }
  if (confirmed === null || confirmed.status !== 'success') {
    const revertedHash = confirmed?.transactionHash ?? submittedHash;
    return err(
      new TransactionError(
        `Transaction ${revertedHash} reverted`,
        revertedHash,
        failureContext(
          execution.plan,
          lastStep,
          'revert',
          execution.confirmed,
          revertedHash,
          batchId,
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
      ...(replacement === 'repriced' ? { repricedFrom: submittedHash } : {}),
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
    submittedHash: receipt.repricedFrom ?? hash,
    hash,
    ...(receipt.repricedFrom === undefined
      ? {}
      : {
          replacement: {
            reason: 'repriced',
            originalHash: receipt.repricedFrom,
            replacementHash: hash,
          },
        }),
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

      const expiry = checkExecutionPlanExpiry(
        prepared.value.plan,
        failureContext(
          prepared.value.plan,
          prepared.value.pending[0],
          'preflight',
          prepared.value.confirmed,
        ),
      );
      if (expiry.isErr()) return err(expiry.error);
      const batch = groupPendingSteps(prepared.value);
      const progress = createBatchProgress(prepared.value);
      const outcome = await executeAtomicBatch(walletClient, prepared.value, batch, progress);
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
      await progress.confirmed(result);
      const progressFailure = progress.failure(result, outcome.value.receipt.batchId);
      if (progressFailure !== undefined) return err(progressFailure);
      return ok(result);
    } catch (cause) {
      // Last-resort net for genuine defects. Classified failures are returned
      // above as results; one that is thrown anyway is passed through unchanged.
      if (cause instanceof OseroError) return err(cause as SendWithError);
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
  if (isPlan) return observedExecutePlan(walletClient, planOrOptions, maybeOptions);
  const options = planOrOptions as SendWithOptions | undefined;
  return (plan) => observedExecutePlan(walletClient, plan, options);
}

function observedExecutePlan(
  walletClient: WalletClient,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  return observeResult(executePlan(walletClient, plan, options), {
    operation: 'eip5792.sendWith',
    executor: 'eip5792',
    ...(plan?.steps?.[0]?.chainId === undefined ? {} : { chainId: plan.steps[0].chainId }),
  });
}
