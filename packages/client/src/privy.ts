import { APIUserAbortError, type AuthorizationContext, type PrivyClient } from '@privy-io/node';
import {
  type Address,
  createPublicClient,
  http,
  type Hex,
  isAddress,
  isAddressEqual,
  isHash,
  type PublicClient,
  toHex,
  type Transport,
} from 'viem';
import { waitForTransactionReceipt } from 'viem/actions';

import { type SingleTxExecutor, flattenExecutionPlan, runExecutionPlan } from './lib/adapters.js';
import { CHAINS, isSupportedChainId, type OseroChainId } from './lib/chains.js';
import { CancelError, SigningError, TransactionError, UnexpectedError } from './lib/errors.js';
import { errAsync, okAsync, ResultAsync } from './lib/result.js';
import type {
  ExecutionPlan,
  ExecutionPlanHandler,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';

const MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH = 256;

function ensureWalletMatchesRequest(
  wallet: PrivyWallet,
  request: TransactionRequest,
): ResultAsync<PrivyWallet, UnexpectedError> {
  if (!isAddress(wallet.address)) {
    return errAsync(
      new UnexpectedError(`Privy wallet ${wallet.id} address ${wallet.address} is invalid`),
    );
  }
  if (!isAddress(request.from)) {
    return errAsync(new UnexpectedError(`Transaction sender ${request.from} is invalid`));
  }
  if (!isAddressEqual(wallet.address, request.from)) {
    return errAsync(
      new UnexpectedError(
        `Privy wallet ${wallet.id} address ${wallet.address} does not match transaction sender ${request.from}`,
      ),
    );
  }
  return okAsync(wallet);
}

function ensureIdempotencyKey(
  idempotencyKey: string | undefined,
): ResultAsync<string | undefined, UnexpectedError> {
  if (idempotencyKey === undefined) {
    return okAsync(undefined);
  }
  if (idempotencyKey.length === 0) {
    return errAsync(new UnexpectedError('Privy idempotency key cannot be empty'));
  }
  if (idempotencyKey.length > MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH) {
    return errAsync(
      new UnexpectedError(
        `Privy idempotency key cannot exceed ${MAX_PRIVY_IDEMPOTENCY_KEY_LENGTH} characters`,
      ),
    );
  }
  return okAsync(idempotencyKey);
}

function ensureIdempotencyKeyCount(
  plan: ExecutionPlan,
  idempotencyKeys: readonly string[] | undefined,
): ResultAsync<undefined, UnexpectedError> {
  if (idempotencyKeys === undefined) {
    return okAsync(undefined);
  }
  const transactionCount = flattenExecutionPlan(plan).length;
  if (idempotencyKeys.length !== transactionCount) {
    return errAsync(
      new UnexpectedError(
        `Execution plan has ${transactionCount} transaction(s) but ${idempotencyKeys.length} Privy idempotency key(s) were provided; pass exactly one key per transaction`,
      ),
    );
  }
  return okAsync(undefined);
}

/**
 * Privy's `sendTransaction` returns an empty `hash` for sponsored
 * (ERC-4337) transactions, which this adapter cannot wait on.
 *
 * @internal
 */
function ensureTransactionHash(hash: string): ResultAsync<Hex, UnexpectedError> {
  if (!isHash(hash)) {
    return errAsync(
      new UnexpectedError(
        `Privy did not return a valid transaction hash (got ${JSON.stringify(hash)}); sponsored transactions are not supported by this adapter`,
      ),
    );
  }
  return okAsync(hash);
}

/**
 * Translate a Privy Wallet API failure into the corresponding Osero
 * error, mapping caller-aborted requests to {@link CancelError} and
 * everything else to {@link SigningError}.
 *
 * @internal
 */
function mapSendError(err: unknown): CancelError | SigningError {
  if (err instanceof APIUserAbortError) {
    return CancelError.from(err);
  }
  return SigningError.from(err);
}

async function sendPrivyTransaction(
  privy: PrivyClient,
  wallet: PrivyWallet,
  request: TransactionRequest,
  idempotencyKey: string | undefined,
): Promise<string> {
  const { hash } = await privy
    .wallets()
    .ethereum()
    .sendTransaction(wallet.id, {
      caip2: `eip155:${request.chainId}`,
      ...(wallet.authorizationContext !== undefined
        ? { authorization_context: wallet.authorizationContext }
        : {}),
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
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

/**
 * Broadcast a single transaction with Privy's Wallet API and wait for
 * it to be mined. Privy selects gas and broadcasts on the CAIP-2 chain
 * specified in the request; this adapter only supplies the fully-built
 * transaction and confirms it with a viem public client.
 *
 * @internal
 */
function sendSingleTransaction(
  privy: PrivyClient,
  wallet: PrivyWallet,
  request: TransactionRequest,
  index: number,
  options: ResolvedSendWithOptions,
  getReceiptClient: (chainId: OseroChainId) => PublicClient,
): ResultAsync<`0x${string}`, CancelError | SigningError | TransactionError | UnexpectedError> {
  if (!isSupportedChainId(request.chainId)) {
    return errAsync(
      new UnexpectedError(`Privy adapter cannot wait for unsupported chain ${request.chainId}`),
    );
  }

  const chain = CHAINS[request.chainId].viemChain;
  const publicClient = getReceiptClient(request.chainId);

  return ensureWalletMatchesRequest(wallet, request)
    .andThen(() => ensureIdempotencyKey(options.idempotencyKeys?.[index]))
    .andThen((idempotencyKey) =>
      ResultAsync.fromPromise(
        sendPrivyTransaction(privy, wallet, request, idempotencyKey),
        mapSendError,
      ),
    )
    .andThen(ensureTransactionHash)
    .andThen((hash) =>
      ResultAsync.fromPromise(
        waitForTransactionReceipt(publicClient, {
          hash,
          confirmations: options.confirmations,
        }),
        (err) => UnexpectedError.from(err),
      ).andThen((receipt) => {
        if (receipt.status === 'reverted') {
          const explorer = chain.blockExplorers?.default?.url;
          const link = explorer
            ? new URL(`/tx/${receipt.transactionHash}`, explorer).toString()
            : undefined;
          return errAsync(
            TransactionError.from({
              txHash: receipt.transactionHash,
              link,
            }),
          );
        }
        return okAsync(receipt.transactionHash);
      }),
    );
}

type ResolvedSendWithOptions = {
  readonly confirmations: number;
  readonly transports?: Partial<Record<OseroChainId, Transport>>;
  readonly idempotencyKeys?: readonly string[];
};

function buildExecutor(
  privy: PrivyClient,
  wallet: PrivyWallet,
  options: ResolvedSendWithOptions,
): SingleTxExecutor {
  let index = 0;
  const receiptClients = new Map<OseroChainId, PublicClient>();
  const getReceiptClient = (chainId: OseroChainId): PublicClient => {
    const cached = receiptClients.get(chainId);
    if (cached !== undefined) {
      return cached;
    }
    const client = createPublicClient({
      chain: CHAINS[chainId].viemChain,
      transport: options.transports?.[chainId] ?? http(),
    });
    receiptClients.set(chainId, client);
    return client;
  };
  return (tx) => sendSingleTransaction(privy, wallet, tx, index++, options, getReceiptClient);
}

/**
 * Privy server wallet used by {@link sendWith}.
 */
export type PrivyWallet = {
  /**
   * Privy's wallet ID. This is the ID returned by
   * `privy.wallets().create(...)` or `privy.wallets().get(...)`.
   */
  readonly id: string;

  /**
   * EVM address for the Privy wallet. The adapter checks this against
   * every transaction's `from` address before broadcasting.
   */
  readonly address: Address;

  /**
   * Optional Privy authorization context used to authorize Wallet API
   * calls. Use this for authorization private keys, user JWTs, or
   * precomputed signatures configured in Privy.
   */
  readonly authorizationContext?: AuthorizationContext;
};

/**
 * Options accepted by {@link sendWith}.
 */
export type SendWithOptions = {
  /**
   * Override the number of confirmations the adapter waits for
   * after each transaction.
   *
   * @defaultValue 1
   */
  readonly confirmations?: number;

  /**
   * Custom viem `Transport`s keyed by chain ID for receipt polling
   * after Privy broadcasts the transaction. Any chain without an
   * entry falls back to viem's default public HTTP transport.
   */
  readonly transports?: Partial<Record<OseroChainId, Transport>>;

  /**
   * Optional Privy idempotency keys, one per transaction in execution
   * order. If the plan has multiple transactions, index `0` applies
   * to the first approval or action tx, index `1` to the next tx, and
   * so on. When provided, the number of keys must match the number of
   * transactions in the plan (`flattenExecutionPlan(plan).length`) —
   * the adapter fails before broadcasting anything otherwise, so no
   * transaction is ever sent without its retry protection.
   *
   * Privy stores an idempotency key for 24 hours and rejects reuse
   * with a different request body. Generate and persist a fresh key
   * for each distinct operation that you may need to retry.
   */
  readonly idempotencyKeys?: readonly string[];
};

/**
 * Turn an {@link ExecutionPlan} into a concrete sequence of Privy
 * Wallet API `sendTransaction` calls bound to a server wallet. Every
 * tx in the plan is broadcast in order; the adapter waits for each
 * receipt before starting the next one.
 *
 * Two usage modes:
 *
 * - **Curried** (the common form — pipe it into `.andThen`):
 *
 *   ```ts
 *   import { sendWith } from '@osero/client/privy';
 *
 *   const wallet = {
 *     id: process.env.PRIVY_WALLET_ID!,
 *     address: process.env.PRIVY_WALLET_ADDRESS! as `0x${string}`,
 *   };
 *
 *   const result = await mintUsds(client, request)
 *     .andThen(sendWith(privy, wallet));
 *   ```
 *
 * - **Direct** (for eagerly-obtained plans):
 *
 *   ```ts
 *   const plan = await mintUsds(client, request);
 *   if (plan.isOk()) {
 *     const result = await sendWith(privy, wallet, plan.value);
 *   }
 *   ```
 *
 * Privy receives the transaction's target network as a CAIP-2 chain ID
 * (`eip155:<chainId>`), so the wallet does not need to be switched like
 * a browser wallet. Receipt polling uses the SDK's supported chain
 * registry and public viem RPC defaults unless custom `transports`
 * are provided in the options.
 */
export function sendWith(
  privy: PrivyClient,
  wallet: PrivyWallet,
  options?: SendWithOptions,
): ExecutionPlanHandler;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  privy: PrivyClient,
  wallet: PrivyWallet,
  plan: T,
  options?: SendWithOptions,
): ReturnType<ExecutionPlanHandler<T>>;
export function sendWith<T extends ExecutionPlan = ExecutionPlan>(
  privy: PrivyClient,
  wallet: PrivyWallet,
  planOrOptions?: T | SendWithOptions,
  maybeOptions?: SendWithOptions,
):
  | ExecutionPlanHandler<T>
  | ResultAsync<
      TransactionResult,
      CancelError | SigningError | TransactionError | UnexpectedError
    > {
  const isPlan =
    typeof planOrOptions === 'object' && planOrOptions !== null && '__typename' in planOrOptions;

  const options = (isPlan ? maybeOptions : planOrOptions) as SendWithOptions | undefined;
  const resolved: ResolvedSendWithOptions = {
    confirmations: options?.confirmations ?? 1,
    transports: options?.transports,
    idempotencyKeys: options?.idempotencyKeys,
  };

  // A fresh executor per run keeps the per-transaction index — and the
  // idempotency key each transaction selects — correct when the curried
  // handler is reused, e.g. to retry the same plan.
  const run = (
    plan: T,
  ): ResultAsync<
    TransactionResult,
    CancelError | SigningError | TransactionError | UnexpectedError
  > =>
    ensureIdempotencyKeyCount(plan, resolved.idempotencyKeys).andThen(() =>
      runExecutionPlan(plan, buildExecutor(privy, wallet, resolved)),
    );

  if (isPlan) {
    return run(planOrOptions as T);
  }
  return run;
}
