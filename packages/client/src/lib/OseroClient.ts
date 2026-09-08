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
import type { Referral, Slippage } from './domain.js';
import { ConfigurationError, UnexpectedError, UnsupportedChainError } from './errors.js';
import { err, ok, type Result } from './result.js';

export type OseroPublicClient = Client<
  Transport,
  ViemChain,
  undefined,
  PublicRpcSchema,
  PublicActions
>;

export type GetPublicClientError = UnsupportedChainError | ConfigurationError | UnexpectedError;

export class OseroClient {
  readonly defaults: {
    readonly slippage: Slippage;
    readonly referral: Referral;
  };

  readonly #config: ResolvedClientConfig;
  readonly #publicClients = new Map<OseroChainId, OseroPublicClient>();

  private constructor(config: ResolvedClientConfig) {
    this.#config = config;
    this.defaults = Object.freeze({
      slippage: config.defaultSlippage,
      referral: config.referral,
    });
    for (const [chainId, publicClient] of Object.entries(config.publicClients)) {
      if (publicClient !== undefined) {
        this.#publicClients.set(Number(chainId) as OseroChainId, publicClient);
      }
    }
  }

  /**
   * Creates a client. Invalid configuration throws a typed
   * {@link ConfigurationError}; operations after construction return failures in `Result`.
   */
  static create(config: ClientConfig = {}): OseroClient {
    return new OseroClient(resolveConfig(config));
  }

  getPublicClient(chainId: number): Result<OseroPublicClient, GetPublicClientError> {
    if (!isSupportedChainId(chainId)) {
      return err(new UnsupportedChainError(chainId));
    }

    const cached = this.#publicClients.get(chainId);
    if (cached !== undefined) return ok(cached);

    const configuredTransport = this.#config.transports[chainId];
    if (configuredTransport === undefined && !this.#config.allowPublicRpc) {
      return err(
        new ConfigurationError(
          `No public RPC transport configured for chain ${chainId}; provide a transport or explicitly set allowPublicRpc: true`,
          `transports.${chainId}`,
        ),
      );
    }

    try {
      const publicClient = createPublicClient({
        chain: CHAINS[chainId].viemChain,
        transport: configuredTransport ?? http(),
      }) as OseroPublicClient;
      this.#publicClients.set(chainId, publicClient);
      return ok(publicClient);
    } catch (cause) {
      return err(UnexpectedError.from(cause));
    }
  }
}
