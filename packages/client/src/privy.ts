import { APIUserAbortError, type AuthorizationContext } from '@privy-io/node';
import {
  type Address,
  type Chain,
  createPublicClient,
  http,
  isAddress,
  isHash,
  type Hex,
  type PublicClient,
  toHex,
  type Transport,
} from 'viem';
import { getTransactionReceipt } from 'viem/actions';

import {
  preflightExecutorCapabilities,
  runExecutionPlan,
  toCompletedExecutionStep,
  type SingleTransactionContext,
  type SingleTransactionResult,
  type SingleTxExecutor,
} from './lib/adapters.js';
import { CHAINS, isSupportedChainId } from './lib/chains.js';
import {
  BroadcastError,
  CancelError,
  ConfigurationError,
  ConfirmationError,
  TransactionError,
  UnsupportedCapabilityError,
  ValidationError,
} from './lib/errors.js';
import { checkExecutionPlanExpiry } from './lib/plan.js';
import { err, errAsync, ok, ResultAsync, type Result } from './lib/result.js';
import { observeResult } from './lib/telemetry.js';
import type {
  ConfirmationOptions,
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutorCapabilities,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';
import {
  validateConfirmations,
  validateExecutionPlan,
  validateExecutorBinding,
  validateResumeState,
} from './lib/validation.js';
import { nonRepricedReplacementError, waitForViemReceipt } from './lib/viemReceipt.js';

const MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH = 256;

export const PRIVY_EXECUTOR_CAPABILITIES: ExecutorCapabilities = {
  name: 'privy',
  sequentialTransactions: true,
  atomicBatch: false,
  permitAuthorization: false,
  sponsoredTransactions: false,
  chainSwitching: 'none',
  simulation: 'none',
};

export type PrivyWallet = {
  readonly id: string;
  readonly address: Address;
  readonly authorizationContext?: AuthorizationContext;
};

/**
 * Structural seam for the Privy Wallet API methods used by this adapter.
 * It avoids coupling consumers to a nominal `PrivyClient` class identity.
 */
export type PrivyExecutorClient = {
  wallets(): {
    ethereum(): {
      sendTransaction(
        walletId: string,
        request: {
          readonly caip2: `eip155:${number}`;
          readonly authorization_context?: AuthorizationContext;
          readonly idempotency_key?: string;
          readonly params: {
            readonly transaction: {
              readonly from: Address;
              readonly to: Address;
              readonly value: Hex;
              readonly chain_id: number;
              readonly data: Hex;
            };
          };
        },
      ): PromiseLike<{ readonly hash: string }>;
    };
  };
};

export type SendWithOptions = ConfirmationOptions & {
  /** Explicitly binds this executor invocation to one chain. */
  readonly chainId: number;
  readonly idempotencyKeys?: Readonly<Record<string, string>>;
  readonly receiptClient?: PublicClient;
  readonly transport?: Transport;
  /** Required with `transport` when the chain is not in the local registry. */
  readonly chain?: Chain;
  readonly allowPublicRpc?: boolean;
  readonly confirmationTimeoutMs?: number;
};

type ResolvedOptions = SendWithOptions & {
  readonly confirmations: number;
  readonly receiptClient: PublicClient;
};

function resolveOptions(
  plan: ExecutionPlan,
  options: SendWithOptions | undefined,
): Result<ResolvedOptions, ValidationError | ConfigurationError> {
  if (options === undefined) {
    return err(
      new ConfigurationError(
        'Privy sendWith requires explicit options including chainId',
        'options',
      ),
    );
  }
  const confirmations = validateConfirmations(options.confirmations ?? 1);
  if (confirmations.isErr()) return err(confirmations.error);
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    return err(ValidationError.forField('chainId', 'chainId must be a positive safe integer'));
  }
  if (
    options.confirmationTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.confirmationTimeoutMs) || options.confirmationTimeoutMs <= 0)
  ) {
    return err(
      ValidationError.forField(
        'confirmationTimeoutMs',
        'confirmationTimeoutMs must be a positive safe integer',
      ),
    );
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') {
    return err(ValidationError.forField('onProgress', 'onProgress must be a function'));
  }
  if (options.allowPublicRpc !== undefined && typeof options.allowPublicRpc !== 'boolean') {
    return err(ValidationError.forField('allowPublicRpc', 'allowPublicRpc must be a boolean'));
  }

  const idempotency = validateIdempotencyKeys(plan, options.idempotencyKeys);
  if (idempotency.isErr()) return err(idempotency.error);

  let receiptClient = options.receiptClient;
  if (receiptClient !== undefined) {
    if (receiptClient.chain?.id !== options.chainId) {
      return err(
        new ConfigurationError(
          'receiptClient must expose chain metadata matching options.chainId',
          'receiptClient',
        ),
      );
    }
  } else {
    const chain =
      options.chain ??
      (isSupportedChainId(options.chainId) ? CHAINS[options.chainId].viemChain : undefined);
    if (chain === undefined || chain.id !== options.chainId) {
      return err(
        new ConfigurationError(
          `Unknown chain ${options.chainId} requires caller-supplied chain metadata or receiptClient`,
          'chain',
        ),
      );
    }
    if (options.transport === undefined && options.allowPublicRpc !== true) {
      return err(
        new ConfigurationError(
          'Privy receipt polling requires a transport or explicit allowPublicRpc: true',
          'transport',
        ),
      );
    }
    receiptClient = createPublicClient({
      chain,
      transport: options.transport ?? http(),
    });
  }

  return ok({
    ...options,
    confirmations: confirmations.value,
    receiptClient,
  });
}

function validateIdempotencyKeys(
  unvalidatedPlan: ExecutionPlan,
  keys: Readonly<Record<string, string>> | undefined,
): Result<void, ValidationError> {
  if (keys === undefined) return ok(undefined);
  if (typeof keys !== 'object' || keys === null) {
    return err(
      ValidationError.forField(
        'idempotencyKeys',
        'idempotencyKeys must be an object keyed by plan step id',
      ),
    );
  }
  // Keys are matched against step ids, so the plan must be structurally valid
  // before it is read here; otherwise a malformed plan would throw instead of
  // returning its ValidationError.
  const validated = validateExecutionPlan(unvalidatedPlan);
  if (validated.isErr()) return err(validated.error);
  const plan = validated.value;
  const providedStepIds = Object.keys(keys);
  if (providedStepIds.length !== plan.steps.length) {
    return err(
      ValidationError.forField(
        'idempotencyKeys',
        'idempotencyKeys must contain exactly one entry for every stable plan step id',
      ),
    );
  }
  const values = new Set<string>();
  for (const step of plan.steps) {
    const key = keys[step.id];
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH ||
      !/^[\x21-\x7E]+$/.test(key)
    ) {
      return err(
        ValidationError.forField(
          `idempotencyKeys.${step.id}`,
          `Privy idempotency key must be 1-${MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters`,
        ),
      );
    }
    if (values.has(key)) {
      return err(
        ValidationError.forField(
          `idempotencyKeys.${step.id}`,
          'Privy idempotency keys must be unique per plan step',
        ),
      );
    }
    values.add(key);
  }
  if (providedStepIds.some((stepId) => !plan.steps.some((step) => step.id === stepId))) {
    return err(
      ValidationError.forField('idempotencyKeys', 'idempotencyKeys contains an unknown step id'),
    );
  }
  return ok(undefined);
}

async function sendPrivyTransaction(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  request: TransactionRequest,
  idempotencyKey: string | undefined,
): Promise<string> {
  const { hash } = await privy
    .wallets()
    .ethereum()
    .sendTransaction(wallet.id, {
      caip2: `eip155:${request.chainId}`,
      ...(wallet.authorizationContext === undefined
        ? {}
        : { authorization_context: wallet.authorizationContext }),
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      params: {
        transaction: {
          from: request.from,
          to: request.to,
          value: toHex(request.value),
          chain_id: request.chainId,
          data: request.data,
        },
      },
    });
  return hash;
}

function sendSingleTransaction(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  plan: ExecutionPlan,
  request: TransactionRequest,
  context: SingleTransactionContext,
  options: ResolvedOptions,
): ResultAsync<SingleTransactionResult, SendWithError> {
  const expiry = checkExecutionPlanExpiry(plan, context.failure('preflight'));
  if (expiry.isErr()) return errAsync(expiry.error);
  return ResultAsync.fromPromise(
    sendPrivyTransaction(privy, wallet, request, options.idempotencyKeys?.[request.id]),
    (cause) =>
      cause instanceof APIUserAbortError
        ? CancelError.from(cause, context.failure('signing'))
        : BroadcastError.from(cause, context.failure('broadcast')),
  ).andThen((hash) => {
    if (!isHash(hash)) {
      return errAsync(
        new UnsupportedCapabilityError(
          'standard transaction hash (sponsored/user-operation responses are unsupported)',
          'privy',
        ),
      );
    }
    const submittedHash = hash;
    const confirmation = async (): Promise<SingleTransactionResult> => {
      await context.notifySubmitted(submittedHash);
      const { receipt, replacement } = await waitForViemReceipt(options.receiptClient, {
        hash: submittedHash,
        confirmations: context.confirmations,
        ...(options.confirmationTimeoutMs === undefined
          ? {}
          : { timeout: options.confirmationTimeoutMs }),
      });
      // Same rule as the viem and ethers adapters: only a same-transaction fee
      // bump may stand in for the submitted hash.
      if (replacement !== undefined && replacement !== 'repriced') {
        throw nonRepricedReplacementError(
          submittedHash,
          replacement,
          receipt.transactionHash,
          context.failure('replacement', submittedHash),
        );
      }
      if (receipt.status === 'reverted') {
        throw new TransactionError(
          `Transaction ${receipt.transactionHash} reverted`,
          receipt.transactionHash,
          context.failure('revert', receipt.transactionHash),
        );
      }
      return {
        submittedHash,
        hash: receipt.transactionHash,
        ...(replacement === undefined
          ? {}
          : {
              replacement: {
                reason: replacement,
                originalHash: submittedHash,
                replacementHash: receipt.transactionHash,
              },
            }),
        confirmation: {
          status: 'success',
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          confirmations: context.confirmations,
        },
      };
    };
    return ResultAsync.fromPromise(confirmation(), (cause) => {
      if (cause instanceof ConfirmationError || cause instanceof TransactionError) return cause;
      return ConfirmationError.from(cause, context.failure('confirmation', submittedHash));
    });
  });
}

function verifyResumeReceipts(
  plan: ExecutionPlan,
  options: ResolvedOptions,
): ResultAsync<void, SendWithError> {
  const resume = validateResumeState(plan, options.resume);
  if (resume.isErr()) return errAsync(resume.error);
  const verification = async (): Promise<Result<void, SendWithError>> => {
    // oxlint-disable no-await-in-loop -- Validate the confirmed prefix in deterministic order.
    for (const transaction of resume.value) {
      const step = plan.steps[transaction.stepIndex]!;
      const completed = resume.value.slice(0, transaction.stepIndex);
      const execution = {
        planId: plan.id,
        stepId: step.id,
        stepIndex: transaction.stepIndex,
        operation: step.operation,
        stage: 'confirmation' as const,
        hash: transaction.hash,
        completed: completed.map(toCompletedExecutionStep),
      };
      const receipt = await ResultAsync.fromPromise(
        getTransactionReceipt(options.receiptClient, { hash: transaction.hash }),
        (cause) => ConfirmationError.from(cause, execution),
      );
      if (receipt.isErr()) return err(receipt.error);
      if (
        receipt.value.status !== 'success' ||
        receipt.value.transactionHash.toLowerCase() !== transaction.hash.toLowerCase()
      ) {
        return err(
          new ConfirmationError(
            `Resume proof for step ${step.id} is not a successful matching receipt`,
            execution,
          ),
        );
      }
    }
    // oxlint-enable no-await-in-loop
    return ok(undefined);
  };
  return new ResultAsync(verification());
}

function executePlan(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  if (typeof wallet.id !== 'string' || wallet.id.length === 0) {
    return errAsync(ValidationError.forField('wallet.id', 'wallet.id must be a non-empty string'));
  }
  if (!isAddress(wallet.address)) {
    return errAsync(
      ValidationError.forField('wallet.address', 'wallet.address must be an EVM address'),
    );
  }
  const resolvedOptions = resolveOptions(plan, options);
  if (resolvedOptions.isErr()) return errAsync(resolvedOptions.error);
  const binding = validateExecutorBinding(plan, wallet.address, resolvedOptions.value.chainId);
  if (binding.isErr()) return errAsync(binding.error);
  const capability = preflightExecutorCapabilities(binding.value, PRIVY_EXECUTOR_CAPABILITIES);
  if (capability.isErr()) return errAsync(capability.error);

  return verifyResumeReceipts(binding.value, resolvedOptions.value).andThen(() => {
    const executor: SingleTxExecutor = (transaction, context) =>
      sendSingleTransaction(
        privy,
        wallet,
        binding.value,
        transaction,
        context,
        resolvedOptions.value,
      );
    return runExecutionPlan(
      binding.value,
      executor,
      PRIVY_EXECUTOR_CAPABILITIES,
      resolvedOptions.value,
    );
  });
}

export function sendWith(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  options: SendWithOptions,
): ExecutionPlanHandler;
export function sendWith(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  plan: ExecutionPlan,
  options: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError>;
export function sendWith(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  planOrOptions: ExecutionPlan | SendWithOptions,
  maybeOptions?: SendWithOptions,
): ExecutionPlanHandler | ResultAsync<TransactionResult, SendWithError> {
  // Guard the `in` check: a null or non-object plan must reach validation and
  // come back as a ValidationError instead of throwing here.
  if (typeof planOrOptions === 'object' && planOrOptions !== null && 'chainId' in planOrOptions) {
    return (plan) => observedExecutePlan(privy, wallet, plan, planOrOptions);
  }
  return observedExecutePlan(privy, wallet, planOrOptions, maybeOptions);
}

function observedExecutePlan(
  privy: PrivyExecutorClient,
  wallet: PrivyWallet,
  plan: ExecutionPlan,
  options?: SendWithOptions,
): ResultAsync<TransactionResult, SendWithError> {
  return observeResult(executePlan(privy, wallet, plan, options), {
    operation: 'privy.sendWith',
    executor: 'privy',
    ...(plan?.steps?.[0]?.chainId === undefined ? {} : { chainId: plan.steps[0].chainId }),
  });
}
