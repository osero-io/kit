import {
  type Chain as ViemChain,
  type Client,
  createPublicClient,
  http,
  type PublicActions,
  type PublicRpcSchema,
  type Transport,
} from 'viem';

import { CHAINS, isSupportedChainId, type OseroChainId } from './chains.js';
import { type ClientConfig, type ResolvedClientConfig, resolveConfig } from './config.js';
import { UnsupportedChainError } from './errors.js';

/**
 * Generic viem `PublicClient` used by the SDK. Typed in a way that
 * lets us store heterogeneous clients (one per chain) in a single
 * map without losing read-method autocomplete.
 */
export type OseroPublicClient = Client<
  Transport,
  ViemChain,
  undefined,
  PublicRpcSchema,
  PublicActions
>;

/**
 * The top-level entry point into the Osero SDK.
 *
 * An `OseroClient` holds the (resolved) configuration and lazily
 * instantiates viem public clients per chain so that actions can run
 * previews and fee reads without the caller having to wire up RPCs
 * by hand.
 *
 * ```ts
 * import { OseroClient } from '@osero/client';
 * import { http } from 'viem';
 *
 * const client = OseroClient.create({
 *   transports: {
 *     1: http('https://eth.llamarpc.com'),
 *     8453: http('https://mainnet.base.org'),
 *   },
 * });
 * ```
 *
 * The client is intentionally stateless from the caller's point of
 * view: there is no "connect" step, no wallet binding, and nothing
 * that holds a network connection open. Every action is a pure
 * function that takes the client as its first argument — the wallet
 * is supplied later via the viem or ethers adapter.
 */
export class OseroClient {
  readonly config: ResolvedClientConfig;

  readonly #publicClients = new Map<OseroChainId, OseroPublicClient>();

  private constructor(config: ResolvedClientConfig) {
    this.config = config;
  }

  /**
   * Create a new `OseroClient` with the given configuration.
   *
   * Every field in {@link ClientConfig} is optional, so
   * `OseroClient.create()` with no arguments yields a perfectly
   * usable (but public-RPC-backed) client. For production you should
   * supply your own `transports`.
   */
  static create(config: ClientConfig = {}): OseroClient {
    return new OseroClient(resolveConfig(config));
  }

  /**
   * Return the memoised viem `PublicClient` for a chain, creating it
   * on first access.
   *
   * @throws {UnsupportedChainError} if `chainId` is not listed in
   *   {@link CHAINS}.
   */
  getPublicClient(chainId: number): OseroPublicClient {
    if (!isSupportedChainId(chainId)) {
      throw new UnsupportedChainError(chainId);
    }

    const cached = this.#publicClients.get(chainId);
    if (cached) return cached;

    const meta = CHAINS[chainId];
    const transport = this.config.transports[chainId] ?? http();
    const publicClient = createPublicClient({
      chain: meta.viemChain,
      transport,
    }) as OseroPublicClient;

    this.#publicClients.set(chainId, publicClient);
    return publicClient;
  }

  /**
   * **Testing only.** Replace the cached public client for a chain
   * so that unit tests can inject a fake viem client without needing
   * live RPCs. Does nothing in production code paths.
   *
   * @internal
   */
  _setPublicClientForTesting(chainId: OseroChainId, publicClient: OseroPublicClient): void {
    this.#publicClients.set(chainId, publicClient);
  }
}
